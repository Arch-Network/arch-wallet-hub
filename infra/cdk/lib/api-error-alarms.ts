import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

const METRIC_NAMESPACE = "WalletHub/Api";
const WINDOW = cdk.Duration.minutes(5);

// Responses per window that raise each alarm. Starting values chosen
// without production traffic numbers; tune them against the metrics.
const SERVER_ERROR_THRESHOLD = 5;
const UPSTREAM_ERROR_THRESHOLD = 25;
// 404s from one IP in one window. The 15 Nov probe produced dozens in a
// couple of minutes. A wallet missing a single path does not.
const ROUTE_SCAN_THRESHOLD = 25;

// The API writes one `request.completed` line per response
// (services/wallet-hub-api/src/plugins/observability.ts). Both filters
// read `msg` and `statusCode` from it.
const COMPLETED = logs.FilterPattern.stringValue("$.msg", "=", "request.completed");

// The API's indexer proxy answers 502 for any indexer failure, and puts
// the indexer's own status on the line as `upstreamStatus`. A 404 there
// is an account or transaction the indexer has not seen, which a wallet
// with no history produces, so it is not an upstream failure.
//
// Most 502 lines have no `upstreamStatus`: timeouts, the routes that do
// not set it, and every line from an API build older than the field.
// The documentation describes a comparison as matching lines that
// contain the property, so `!= 404` alone would stop counting all of
// those. NOT EXISTS, the documented test for a missing field, keeps
// them, and the pattern does not depend on how `!=` treats one.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntaxForMetricFilters.html
const NOT_UPSTREAM_NOT_FOUND = logs.FilterPattern.any(
  logs.FilterPattern.notExists("$.upstreamStatus"),
  logs.FilterPattern.numberValue("$.upstreamStatus", "!=", 404)
);

export interface ApiErrorAlarmsProps {
  /** Log group the wallet-hub API container writes to. */
  readonly logGroupName: string;
  /** Topic the alarms notify. */
  readonly topic: sns.Topic;
  /** Slack-only topic the alarms also notify, when Slack is configured. */
  readonly slackTopic?: sns.Topic;
}

/**
 * Alarms on the API's own error responses, counted from its request log.
 *
 * A 502 is how the API reports a failed upstream (indexer, Bitcoin node,
 * wallet provider), and the indexer throttles in normal operation, so
 * 502s are counted apart from the other 5xx and alarm at a higher count.
 * A 502 for something the indexer answered 404 to is not counted.
 */
export class ApiErrorAlarms extends Construct {
  constructor(scope: Construct, id: string, props: ApiErrorAlarmsProps) {
    super(scope, id);

    const logGroup = logs.LogGroup.fromLogGroupName(this, "ApiLogs", props.logGroupName);
    const topics = props.slackTopic ? [props.topic, props.slackTopic] : [props.topic];
    const actions = topics.map((topic) => new cloudwatchActions.SnsAction(topic));

    const alarm = (
      name: string,
      metricName: string,
      filterPattern: logs.IFilterPattern,
      threshold: number,
      what: string
    ) => {
      const filter = logGroup.addMetricFilter(`${name}Filter`, {
        filterPattern,
        metricNamespace: METRIC_NAMESPACE,
        metricName,
        metricValue: "1",
        defaultValue: 0,
      });
      new cloudwatch.Alarm(this, name, {
        alarmDescription: `${what}: ${threshold} or more in ${WINDOW.toMinutes()} minutes. Find them in log group ${props.logGroupName} with msg "request.completed"; each line carries the reqId a wallet error report quotes.`,
        metric: filter.metric({ statistic: cloudwatch.Stats.SUM, period: WINDOW }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(...actions);
    };

    alarm(
      "ServerErrors",
      "ServerErrors",
      logs.FilterPattern.all(
        COMPLETED,
        logs.FilterPattern.numberValue("$.statusCode", ">=", 500),
        logs.FilterPattern.numberValue("$.statusCode", "!=", 502)
      ),
      SERVER_ERROR_THRESHOLD,
      "wallet-hub API 5xx responses other than 502"
    );
    alarm(
      "UpstreamErrors",
      "UpstreamErrors",
      logs.FilterPattern.all(
        COMPLETED,
        logs.FilterPattern.numberValue("$.statusCode", "=", 502),
        NOT_UPSTREAM_NOT_FOUND
      ),
      UPSTREAM_ERROR_THRESHOLD,
      "wallet-hub API 502 responses (an upstream failed)"
    );

    // One IP walking unknown paths. Keyed on remoteAddress, which
    // request.completed has carried since #181. A line without that
    // field does not match, so older builds cannot pile up as one
    // empty contributor. INSIGHT_RULE_METRIC is alarmable only as a
    // math expression, and that expression has to carry its own period.
    const scanRuleName = "wallet-hub-route-scan";
    new cloudwatch.CfnInsightRule(this, "RouteScanRule", {
      ruleName: scanRuleName,
      ruleState: "ENABLED",
      ruleBody: JSON.stringify({
        Schema: { Name: "CloudWatchLogRule", Version: 1 },
        LogGroupNames: [props.logGroupName],
        LogFormat: "JSON",
        AggregateOn: "Count",
        Contribution: {
          Keys: ["$.remoteAddress"],
          Filters: [
            { Match: "$.msg", EqualTo: "request.completed" },
            { Match: "$.statusCode", EqualTo: 404 },
            { Match: "$.remoteAddress", NotIn: [""] },
          ],
        },
      }),
    });
    new cloudwatch.CfnAlarm(this, "RouteScan", {
      alarmDescription: `One client IP produced ${ROUTE_SCAN_THRESHOLD} or more wallet-hub 404s in ${WINDOW.toMinutes()} minutes. Find them in log group ${props.logGroupName} with msg "request.completed" and statusCode 404, grouped by remoteAddress.`,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      evaluationPeriods: 1,
      threshold: ROUTE_SCAN_THRESHOLD,
      treatMissingData: "notBreaching",
      metrics: [
        {
          id: "scan",
          expression: `INSIGHT_RULE_METRIC("${scanRuleName}", "MaxContributorValue")`,
          period: WINDOW.toSeconds(),
          returnData: true,
        },
      ],
      alarmActions: topics.map((topic) => topic.topicArn),
    });

    // Each topic already has an explicit policy (the GuardDuty rule
    // publishes to it), so CloudWatch needs its own statement.
    for (const topic of topics) {
      topic.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "AllowApiErrorAlarms",
          actions: ["sns:Publish"],
          principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
          resources: [topic.topicArn],
          conditions: {
            ArnLike: {
              "aws:SourceArn": cdk.Stack.of(this).formatArn({
                service: "cloudwatch",
                resource: "alarm",
                arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                resourceName: "*",
              }),
            },
          },
        })
      );
    }
  }
}
