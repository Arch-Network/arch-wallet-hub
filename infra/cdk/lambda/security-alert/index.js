"use strict";

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const { decide, configFromEnv } = require("./decide");

const sns = new SNSClient({});

exports.handler = async (event) => {
  const decision = decide(event, configFromEnv(process.env));
  if (!decision.page) {
    console.log(
      JSON.stringify({ paged: false, eventName: event?.detail?.eventName ?? "" })
    );
    return { paged: false };
  }

  if (!process.env.TOPIC_ARN) {
    throw new Error("TOPIC_ARN is not set");
  }

  await sns.send(
    new PublishCommand({
      TopicArn: process.env.TOPIC_ARN,
      Subject: decision.subject,
      Message: JSON.stringify(decision.message, null, 2),
    })
  );
  console.log(
    JSON.stringify({
      paged: true,
      eventName: decision.message.eventName,
      actor: decision.message.actor,
    })
  );
  return { paged: true };
};
