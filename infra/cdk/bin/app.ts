#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { WalletHubMonitoringStack } from "../lib/monitoring-stack";
import { WalletHubStack } from "../lib/wallet-hub-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

new WalletHubStack(app, "WalletHubStack", { env });

// Deployed on its own. Do not fold this into a WalletHubStack deploy:
// that stack still carries the RDS instance and AppSecrets (#123).
new WalletHubMonitoringStack(app, "WalletHubMonitoringStack", {
  env,
  description:
    "Wallet Hub detection and paging. Does not update RDS, AppSecrets, or task definitions.",
});
