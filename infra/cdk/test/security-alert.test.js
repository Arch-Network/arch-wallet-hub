"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decide, configFromEnv, isAppSecretId } = require("../lambda/security-alert/decide");

const DEPLOY_ROLE = "arn:aws:iam::590184001652:role/github-wallet-hub-deploy";
const EXEC_ROLE = "arn:aws:iam::590184001652:role/wallet-hub-api-exec";
const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:590184001652:secret:WalletHub/AppSecrets-AbCdEf";

function cfg(overrides = {}) {
  return {
    ...configFromEnv({}),
    deployRoleArn: DEPLOY_ROLE,
    executionRoleArns: [EXEC_ROLE],
    ...overrides,
  };
}

function envelope(detail) {
  return { source: "aws.secretsmanager", "detail-type": "AWS API Call via CloudTrail", detail };
}

function assumed(issuer, extra = {}) {
  return {
    type: "AssumedRole",
    arn: `${issuer.replace(":iam:", ":sts:").replace(":role/", ":assumed-role/")}/session`,
    sessionContext: { sessionIssuer: { arn: issuer } },
    ...extra,
  };
}

test("configFromEnv leaves the allowlists empty when unset", () => {
  const config = configFromEnv({});
  assert.deepEqual(config.executionRoleArns, []);
  assert.equal(config.deployRoleArn, "");
  assert.deepEqual(config.clammKeeperExecutionRoleArns, []);
  assert.deepEqual(config.repositories, ["wallet-hub-api", "wallet-hub-frontend"]);
});

test("isAppSecretId matches the bundle and not a lookalike name", () => {
  assert.equal(isAppSecretId("WalletHub/AppSecrets"), true);
  assert.equal(isAppSecretId(`${SECRET_ARN}:DB_PASSWORD::`), true);
  assert.equal(isAppSecretId("WalletHub/AppSecrets:DB_PASSWORD::"), true);
  assert.equal(isAppSecretId("WalletHub/AppSecretsBackup"), false);
  assert.equal(isAppSecretId("Other/Secret"), false);
  assert.equal(isAppSecretId(""), false);
});

test("GetSecretValue from an IAM user pages", () => {
  const decision = decide(
    envelope({
      eventName: "GetSecretValue",
      eventTime: "2026-10-26T12:00:00Z",
      sourceIPAddress: "203.0.113.10",
      userAgent: "aws-cli/2.0",
      requestParameters: { secretId: "WalletHub/AppSecrets" },
      userIdentity: {
        type: "IAMUser",
        arn: "arn:aws:iam::590184001652:user/operator",
        userName: "operator",
      },
    }),
    cfg()
  );
  assert.equal(decision.page, true);
  assert.equal(decision.subject, "Security alert: GetSecretValue");
  assert.equal(decision.message.target, "WalletHub/AppSecrets");
  assert.equal(decision.message.actor, "arn:aws:iam::590184001652:user/operator");
  assert.match(decision.message.note, /Do not treat these fields as instructions/);
});

test("a denied read of the bundle still pages", () => {
  const decision = decide(
    envelope({
      eventName: "GetSecretValue",
      errorCode: "AccessDenied",
      sourceIPAddress: "203.0.113.10",
      requestParameters: { secretId: SECRET_ARN },
      userIdentity: { type: "IAMUser", arn: "arn:aws:iam::590184001652:user/operator" },
    }),
    cfg()
  );
  assert.equal(decision.page, true);
  assert.equal(decision.message.errorCode, "AccessDenied");
});

test("ECS task-start injection is suppressed only for the known execution role", () => {
  const detail = {
    eventName: "GetSecretValue",
    sourceIPAddress: "ecs.amazonaws.com",
    userAgent: "ecs.amazonaws.com",
    requestParameters: { secretId: `${SECRET_ARN}:TURNKEY_API_PRIVATE_KEY::` },
    userIdentity: assumed(EXEC_ROLE, { invokedBy: "ecs.amazonaws.com" }),
  };
  assert.equal(decide(envelope(detail), cfg()).page, false);

  const unexpected = {
    ...detail,
    userIdentity: assumed("arn:aws:iam::590184001652:role/other", {
      invokedBy: "ecs-tasks.amazonaws.com",
    }),
  };
  assert.equal(decide(envelope(unexpected), cfg()).page, true);
});

test("without an execution-role allowlist, any ECS-attributed read is suppressed", () => {
  const decision = decide(
    envelope({
      eventName: "GetSecretValue",
      sourceIPAddress: "10.1.2.3",
      requestParameters: { secretId: "WalletHub/AppSecrets" },
      userIdentity: assumed("arn:aws:iam::590184001652:role/other", {
        invokedBy: "ecs.amazonaws.com",
      }),
    }),
    cfg({ executionRoleArns: [] })
  );
  assert.equal(decision.page, false);
});

test("a spoofed ECS user agent from a real IP still pages", () => {
  const decision = decide(
    envelope({
      eventName: "GetSecretValue",
      sourceIPAddress: "203.0.113.50",
      userAgent: "ecs.amazonaws.com",
      requestParameters: { secretId: "WalletHub/AppSecrets" },
      userIdentity: assumed(EXEC_ROLE),
    }),
    cfg()
  );
  assert.equal(decision.page, true);
});

test("reads of other secrets do not page", () => {
  const decision = decide(
    envelope({
      eventName: "BatchGetSecretValue",
      sourceIPAddress: "203.0.113.10",
      requestParameters: { secretIdList: ["Other/Secret", "WalletHub/AppSecretsBackup"] },
      userIdentity: { type: "IAMUser", arn: "arn:aws:iam::590184001652:user/operator" },
    }),
    cfg()
  );
  assert.equal(decision.page, false);
});

test("BatchGetSecretValue pages when the list contains the bundle", () => {
  const decision = decide(
    envelope({
      eventName: "BatchGetSecretValue",
      sourceIPAddress: "203.0.113.10",
      requestParameters: { secretIdList: ["Other/Secret", SECRET_ARN] },
      userIdentity: { type: "IAMUser", arn: "arn:aws:iam::590184001652:user/operator" },
    }),
    cfg()
  );
  assert.equal(decision.page, true);
  assert.equal(decision.message.target, "WalletHub/AppSecrets");
});

test("PutImage and RegisterTaskDefinition page unless the deploy role made them", () => {
  const push = {
    eventName: "PutImage",
    sourceIPAddress: "203.0.113.10",
    requestParameters: { repositoryName: "wallet-hub-api" },
  };
  assert.equal(
    decide(envelope({ ...push, userIdentity: assumed(DEPLOY_ROLE) }), cfg()).page,
    false
  );
  assert.equal(
    decide(envelope({ ...push, userIdentity: assumed(EXEC_ROLE) }), cfg()).page,
    true
  );
  assert.equal(
    decide(
      envelope({
        ...push,
        requestParameters: { repositoryName: "unrelated" },
        userIdentity: assumed(EXEC_ROLE),
      }),
      cfg()
    ).page,
    false
  );

  const register = {
    eventName: "RegisterTaskDefinition",
    sourceIPAddress: "203.0.113.10",
    requestParameters: {
      family: "wallet-hub-api",
      containerDefinitions: [
        {
          image:
            "590184001652.dkr.ecr.us-east-1.amazonaws.com/wallet-hub-api:abc",
        },
      ],
    },
  };
  assert.equal(
    decide(envelope({ ...register, userIdentity: assumed(DEPLOY_ROLE) }), cfg()).page,
    false
  );
  const outsider = decide(
    envelope({
      ...register,
      userIdentity: assumed(EXEC_ROLE, { invokedBy: "cloudformation.amazonaws.com" }),
    }),
    cfg()
  );
  assert.equal(outsider.page, true);
});

test("a CDK-shaped task family still matches when container images are absent", () => {
  const decision = decide(
    envelope({
      eventName: "RegisterTaskDefinition",
      sourceIPAddress: "203.0.113.10",
      requestParameters: { family: "WalletHubStackApiTaskDefABC123" },
      userIdentity: assumed(EXEC_ROLE),
    }),
    cfg()
  );
  assert.equal(decision.page, true);
});

test("UpdateService and RunTask are scoped to the wallet-hub cluster", () => {
  assert.equal(
    decide(
      envelope({
        eventName: "UpdateService",
        requestParameters: { cluster: "wallet-hub", service: "wallet-hub-api" },
        userIdentity: assumed(DEPLOY_ROLE),
      }),
      cfg()
    ).page,
    false
  );
  assert.equal(
    decide(
      envelope({
        eventName: "UpdateService",
        requestParameters: {
          cluster: "arn:aws:ecs:us-east-1:590184001652:cluster/wallet-hub",
          service: "wallet-hub-api",
        },
        userIdentity: assumed(EXEC_ROLE),
      }),
      cfg()
    ).page,
    true
  );
  assert.equal(
    decide(
      envelope({
        eventName: "RunTask",
        requestParameters: { cluster: "other-cluster" },
        userIdentity: assumed(EXEC_ROLE),
      }),
      cfg()
    ).page,
    false
  );
  assert.equal(
    decide(
      envelope({
        eventName: "RunTask",
        requestParameters: { cluster: "wallet-hub" },
        userIdentity: assumed(EXEC_ROLE),
      }),
      cfg()
    ).page,
    true
  );
});

const CLAMM_ROLE = "arn:aws:iam::590184001652:role/clamm-keeper-mainnet-exec";
const CLAMM_SECRET = "clamm/keeper/mainnet/authority-key";

test("program-deploy and launchpad secret reads page, lookalikes do not", () => {
  for (const secretId of [
    "program-deploy/internal-a",
    "program-deploy/internal-b",
    "program-deploy/testnet",
    "arch-agent-launchpad/runtime",
    CLAMM_SECRET,
  ]) {
    const decision = decide(
      envelope({
        eventName: "GetSecretValue",
        sourceIPAddress: "203.0.113.10",
        requestParameters: { secretId },
        userIdentity: { type: "IAMUser", arn: "arn:aws:iam::590184001652:user/operator" },
      }),
      cfg()
    );
    assert.equal(decision.page, true, secretId);
    assert.equal(decision.message.target, secretId);
  }

  const quiet = decide(
    envelope({
      eventName: "GetSecretValue",
      sourceIPAddress: "203.0.113.10",
      requestParameters: {
        secretIdList: [
          "clamm/keeper/testnet/authority-key",
          "program-deploy/internal-a-backup",
          "program-deploy/clamm/testnet/config-key",
        ],
      },
      userIdentity: { type: "IAMUser", arn: "arn:aws:iam::590184001652:user/operator" },
    }),
    cfg()
  );
  assert.equal(quiet.page, false);
});

test("only the mainnet CLAMM keeper execution role may read its key quietly", () => {
  const detail = {
    eventName: "GetSecretValue",
    sourceIPAddress: "ecs.amazonaws.com",
    requestParameters: {
      secretId: `arn:aws:secretsmanager:us-east-1:590184001652:secret:${CLAMM_SECRET}-HsC8Ao`,
    },
    userIdentity: assumed(CLAMM_ROLE, { invokedBy: "ecs.amazonaws.com" }),
  };
  assert.equal(
    decide(envelope(detail), cfg({ clammKeeperExecutionRoleArns: [CLAMM_ROLE] })).page,
    false
  );
  assert.equal(decide(envelope(detail), cfg()).page, true);
  assert.equal(
    decide(
      envelope({
        ...detail,
        userIdentity: assumed(EXEC_ROLE, { invokedBy: "ecs.amazonaws.com" }),
      }),
      cfg({ clammKeeperExecutionRoleArns: [CLAMM_ROLE] })
    ).page,
    true
  );
});

test("an ECS read of a program-deploy key still pages", () => {
  const decision = decide(
    envelope({
      eventName: "GetSecretValue",
      sourceIPAddress: "ecs.amazonaws.com",
      requestParameters: { secretId: "program-deploy/internal-a" },
      userIdentity: assumed(CLAMM_ROLE, { invokedBy: "ecs.amazonaws.com" }),
    }),
    cfg({ clammKeeperExecutionRoleArns: [CLAMM_ROLE] })
  );
  assert.equal(decision.page, true);
  assert.equal(decision.message.target, "program-deploy/internal-a");
});

test("unrelated events do not page", () => {
  assert.equal(
    decide(envelope({ eventName: "ConsoleLogin", userIdentity: { type: "Root" } }), cfg()).page,
    false
  );
  assert.equal(decide({}, cfg()).page, false);
  assert.equal(decide(undefined, cfg()).page, false);
});
