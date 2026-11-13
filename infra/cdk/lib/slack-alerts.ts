import * as cdk from "aws-cdk-lib";
import * as chatbot from "aws-cdk-lib/aws-chatbot";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

// Also names the log group, /aws/chatbot/<name>, and the metric
// dimension. Changing it replaces the configuration.
const CONFIGURATION_NAME = "wallet-hub-alerts";

export interface SlackChannelProps {
  /** Configuration name. Changing it replaces the configuration. */
  readonly name: string;
  /** Slack workspace, authorised once by hand in the console. */
  readonly workspaceId: string;
  readonly channelId: string;
  /** The only topic the channel is subscribed to. */
  readonly topic: sns.ITopic;
  /** What channel members may do from Slack. Default: nothing. */
  readonly role?: iam.IRole;
}

/**
 * One Slack channel in Amazon Q Developer in chat applications (AWS
 * Chatbot), with the settings every wallet-hub channel has.
 */
export function slackChannel(
  scope: Construct,
  id: string,
  props: SlackChannelProps
): chatbot.SlackChannelConfiguration {
  return new chatbot.SlackChannelConfiguration(scope, id, {
    slackChannelConfigurationName: props.name,
    slackWorkspaceId: props.workspaceId,
    slackChannelId: props.channelId,
    notificationTopics: [props.topic],
    role: props.role,
    // Left unset, the guardrail is AdministratorAccess.
    guardrailPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchReadOnlyAccess"),
    ],
    loggingLevel: chatbot.LoggingLevel.ERROR,
    logRetention: logs.RetentionDays.ONE_YEAR,
  });
}

export interface SlackAlertsProps {
  /** Slack workspace, authorised once by hand in the console. */
  readonly workspaceId: string;
  /** Slack channel the alerts are posted to. */
  readonly channelId: string;
  /** Topic told when a notification did not reach the channel. */
  readonly failureTopic: sns.ITopic;
}

/**
 * Posts alerts to a Slack channel through Amazon Q Developer in chat
 * applications (AWS Chatbot).
 *
 * The channel has a topic of its own. The service delivers only AWS
 * service events it recognises and its custom-notification schema, and
 * drops anything else without a message, so what the email and HTTPS
 * subscribers of the security topic receive cannot be shared with it.
 */
export class SlackAlerts extends Construct {
  /** Publish here only what the service can render. */
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: SlackAlertsProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, "Topic", {
      displayName: "Arch security alerts for Slack",
    });

    // The service's Notification Permissions policy: what it needs to
    // draw the graph on a CloudWatch alarm. Nothing else is granted, so
    // channel members cannot change anything from Slack.
    const role = new iam.Role(this, "ChannelRole", {
      assumedBy: new iam.ServicePrincipal("chatbot.amazonaws.com"),
      description: "Read access the wallet-hub Slack alerts channel uses to draw alarm graphs.",
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*"],
        resources: ["*"],
      })
    );

    const channel = slackChannel(this, "Channel", {
      name: CONFIGURATION_NAME,
      workspaceId: props.workspaceId,
      channelId: props.channelId,
      topic: this.topic,
      role,
    });

    // A dropped notification is otherwise visible only in these two
    // metrics. Both alarms go to the security topic, never to Slack.
    // They publish under the statement ApiErrorAlarms adds to that
    // topic, which allows every alarm in this account and Region.
    const action = new cloudwatchActions.SnsAction(props.failureTopic);
    const alarm = (metricName: string, what: string) => {
      new cloudwatch.Alarm(this, metricName, {
        alarmDescription: `${what} The alert is missing from the Slack channel; email and HTTPS recipients still got it. The error is in log group /aws/chatbot/${CONFIGURATION_NAME} in us-east-1.`,
        metric: channel.metric(metricName, {
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);
    };
    alarm(
      "UnsupportedEvents",
      "A message published to the wallet-hub Slack topic was in a format the service does not deliver."
    );
    alarm(
      "MessageDeliveryFailure",
      "A wallet-hub alert could not be delivered to Slack."
    );
  }
}
