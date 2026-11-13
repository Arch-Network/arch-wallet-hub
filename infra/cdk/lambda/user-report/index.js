"use strict";

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const { forwardReports } = require("./report");

const sns = new SNSClient({});

exports.handler = (event) =>
  forwardReports(
    (params, options) => sns.send(new PublishCommand(params), options),
    process.env.TOPIC_ARN,
    event
  );
