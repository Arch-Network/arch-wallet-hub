import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as destinations from "aws-cdk-lib/aws-logs-destinations";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { slackChannel } from "./slack-alerts";

export interface UserReportsProps {
  /** Slack workspace, authorised once by hand in the console. */
  readonly workspaceId: string;
  /** Slack channel the reports are posted to. */
  readonly channelId: string;
  /** Log group the API writes its `user.report` lines to. */
  readonly logGroupName: string;
  /** Topic told when the forwarder failed. */
  readonly failureTopic: sns.ITopic;
}

/**
 * Posts the error reports wallet users send to a Slack channel.
 *
 * The Hub writes one `user.report` log line per report and holds no
 * Slack credential. A subscription filter hands those lines to a
 * function, which publishes each to a topic only this channel reads.
 */
export class UserReports extends Construct {
  constructor(scope: Construct, id: string, props: UserReportsProps) {
    super(scope, id);

    const topic = new sns.Topic(this, "Topic", {
      displayName: "Arch wallet user reports for Slack",
    });

    // No role is passed: the one the configuration makes for itself
    // has no permissions, and a report needs none to be posted.
    slackChannel(this, "Channel", {
      name: "wallet-hub-reports",
      workspaceId: props.workspaceId,
      channelId: props.channelId,
      topic,
    });

    const forwarderLogs = new logs.LogGroup(this, "ForwarderLogs", {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const forwarder = new lambda.Function(this, "Forwarder", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/user-report")),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      logGroup: forwarderLogs,
      description: "Posts wallet users' error reports from the API log to Slack.",
      environment: {
        TOPIC_ARN: topic.topicArn,
      },
      // CloudWatch Logs invokes the function asynchronously, and Lambda
      // would run a failed batch twice more. A batch that failed in
      // part would post the reports that got through again.
      retryAttempts: 0,
    });
    topic.grantPublish(forwarder);

    // LambdaDestination lets logs.amazonaws.com invoke the function
    // for this log group only.
    logs.LogGroup.fromLogGroupName(this, "ApiLogs", props.logGroupName).addSubscriptionFilter(
      "Filter",
      {
        destination: new destinations.LambdaDestination(forwarder),
        filterPattern: logs.FilterPattern.stringValue("$.msg", "=", "user.report"),
      }
    );

    // Publishes under the statement ApiErrorAlarms adds to the security
    // topic, which allows every alarm in this account and Region.
    new cloudwatch.Alarm(this, "ForwarderErrors", {
      alarmDescription: `A wallet user's error report was not posted to Slack. It is still a user.report line in log group ${props.logGroupName}. The error is in the forwarder's log group.`,
      metric: forwarder.metricErrors({
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(props.failureTopic));
  }
}
