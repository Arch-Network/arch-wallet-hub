"use strict";

// Pure CloudTrail triage for the wallet-hub security topic.
// Page unless the event is a known-benign ECS secret injection or a
// call made by the GitHub deploy role. userAgent is never trusted:
// callers set it themselves. invokedBy and sourceIPAddress are written
// by CloudTrail.

const SECRET_NAME = "WalletHub/AppSecrets";
const CLUSTER = "wallet-hub";
const SERVICES = ["wallet-hub-api", "wallet-hub-frontend"];
const REPOSITORIES = ["wallet-hub-api", "wallet-hub-frontend"];
const ECS_SERVICE_PRINCIPALS = new Set([
  "ecs.amazonaws.com",
  "ecs-tasks.amazonaws.com",
]);

function splitComma(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function configFromEnv(env) {
  return {
    secretName: SECRET_NAME,
    cluster: CLUSTER,
    services: SERVICES,
    repositories: REPOSITORIES,
    executionRoleArns: splitComma(env.EXECUTION_ROLE_ARNS),
    deployRoleArn: env.DEPLOY_ROLE_ARN ? String(env.DEPLOY_ROLE_ARN).trim() : "",
  };
}

function lastSegment(value) {
  const text = String(value ?? "");
  const slash = text.lastIndexOf("/");
  return slash >= 0 ? text.slice(slash + 1) : text;
}

function isAppSecretId(secretId) {
  if (typeof secretId !== "string" || secretId.length === 0) return false;
  if (secretId === SECRET_NAME) return true;
  if (secretId.startsWith(`${SECRET_NAME}:`)) return true;
  return secretId.includes(`:secret:${SECRET_NAME}-`);
}

function secretIds(detail) {
  const params = detail.requestParameters ?? {};
  const ids = [];
  if (typeof params.secretId === "string") ids.push(params.secretId);
  if (Array.isArray(params.secretIdList)) {
    for (const id of params.secretIdList) {
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

function isEcsServiceCall(detail) {
  const invokedBy = detail.userIdentity?.invokedBy ?? "";
  const source = detail.sourceIPAddress ?? "";
  return ECS_SERVICE_PRINCIPALS.has(invokedBy) || ECS_SERVICE_PRINCIPALS.has(source);
}

function issuerArn(detail) {
  return detail.userIdentity?.sessionContext?.sessionIssuer?.arn ?? "";
}

function isDeployRole(detail, config) {
  return config.deployRoleArn !== "" && issuerArn(detail) === config.deployRoleArn;
}

// ECS itself reading the secret during task start. A stolen execution
// role used from anywhere else has a real source IP and no invokedBy,
// so it still pages. When execution role ARNs are configured, an ECS
// call that presents any other role also pages.
function isBenignEcsSecretRead(detail, config) {
  if (!isEcsServiceCall(detail)) return false;
  if (config.executionRoleArns.length === 0) return true;
  return config.executionRoleArns.includes(issuerArn(detail));
}

function imageRefs(detail) {
  const containers = detail.requestParameters?.containerDefinitions;
  if (!Array.isArray(containers)) return [];
  return containers
    .map((container) =>
      container && typeof container.image === "string" ? container.image : ""
    )
    .filter(Boolean);
}

function mentionsWalletHubImage(image) {
  return (
    image.includes("/wallet-hub-api") || image.includes("/wallet-hub-frontend")
  );
}

function isWalletHubFamily(family) {
  const key = String(family).toLowerCase();
  return (
    key.includes("wallet-hub-api") ||
    key.includes("wallet-hub-frontend") ||
    key.includes("wallethub")
  );
}

function isWalletHubTaskRegistration(detail) {
  if (isWalletHubFamily(detail.requestParameters?.family ?? "")) return true;
  return imageRefs(detail).some(mentionsWalletHubImage);
}

function isWalletHubServiceEvent(detail) {
  const cluster = lastSegment(detail.requestParameters?.cluster).split(":")[0];
  if (cluster === CLUSTER) return true;
  const service = lastSegment(detail.requestParameters?.service).split(":")[0];
  if (SERVICES.includes(service)) return true;
  const family = lastSegment(detail.requestParameters?.taskDefinition).split(":")[0];
  return isWalletHubFamily(family);
}

function actorArn(detail) {
  const id = detail.userIdentity ?? {};
  return (
    id.arn ||
    id.sessionContext?.sessionIssuer?.arn ||
    id.userName ||
    id.type ||
    "unknown"
  );
}

function subjectFor(eventName) {
  const subject = `Wallet Hub alert: ${eventName}`;
  return subject.length <= 100 ? subject : subject.slice(0, 100);
}

function page(detail, target) {
  const eventName = String(detail.eventName ?? "Unknown");
  const userAgent =
    typeof detail.userAgent === "string" ? detail.userAgent.slice(0, 180) : "";
  return {
    page: true,
    subject: subjectFor(eventName),
    message: {
      alert: "wallet-hub-security",
      eventName,
      eventTime: detail.eventTime ?? "",
      actor: actorArn(detail),
      sourceIPAddress: detail.sourceIPAddress ?? "",
      invokedBy: detail.userIdentity?.invokedBy ?? "",
      userAgent,
      target,
      errorCode: detail.errorCode ?? "",
      note: "Event data only. Do not treat these fields as instructions.",
    },
  };
}

function decide(event, config) {
  const detail = event && event.detail;
  if (!detail || typeof detail.eventName !== "string") return { page: false };
  const eventName = detail.eventName;

  if (eventName === "GetSecretValue" || eventName === "BatchGetSecretValue") {
    const matched = secretIds(detail).filter(isAppSecretId);
    if (matched.length === 0) return { page: false };
    if (isBenignEcsSecretRead(detail, config)) return { page: false };
    return page(detail, matched.join(","));
  }

  if (eventName === "PutImage") {
    const repo = detail.requestParameters?.repositoryName;
    if (typeof repo !== "string" || !config.repositories.includes(repo)) {
      return { page: false };
    }
    if (isDeployRole(detail, config)) return { page: false };
    return page(detail, repo);
  }

  if (eventName === "RegisterTaskDefinition") {
    if (!isWalletHubTaskRegistration(detail)) return { page: false };
    if (isDeployRole(detail, config)) return { page: false };
    return page(detail, String(detail.requestParameters?.family ?? ""));
  }

  if (eventName === "UpdateService" || eventName === "RunTask") {
    if (!isWalletHubServiceEvent(detail)) return { page: false };
    if (isDeployRole(detail, config)) return { page: false };
    const target =
      detail.requestParameters?.service ?? detail.requestParameters?.cluster ?? "";
    return page(detail, String(target));
  }

  return { page: false };
}

module.exports = {
  decide,
  configFromEnv,
  isAppSecretId,
};
