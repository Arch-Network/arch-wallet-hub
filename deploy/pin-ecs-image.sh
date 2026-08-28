#!/usr/bin/env bash
# Pin an ECS service to an immutable container image.
#
# Clones the task definition the service is *currently running*, changes
# only matching container image URIs, registers a new revision, and
# points the service at it. Does not --force-new-deployment of :latest.
#
# Why clone live (issue #47, deferred from PR #43 as "deploy risk"):
#   CI used to `docker push :$SHA` *and* `:latest`, then
#   `update-service --force-new-deployment`. That re-pulls whatever tag
#   the live task def already references — today `:latest`, a mutable
#   tag. The SHA was pushed but never referenced, so a later retag of
#   `:latest` silently changes the next roll.
#
#   We do NOT render a task def from CDK or a checked-in JSON. Live
#   env/secrets have drifted from infra/cdk (that is how :latest
#   force-deploys already mutated running task defs). Synthesizing from
#   this repo would reset those fields. #47's acceptance is only: pin
#   the image. Every other field is copied verbatim.
#
#   aws-actions/amazon-ecs-render-task-definition wants a git JSON or a
#   family name. A git file would drift; family "latest revision" may
#   not be what the service is running. describe-services →
#   taskDefinition is the revision actually in service.
#
# Extra IAM on AWS_DEPLOY_ROLE_ARN (beyond existing UpdateService):
#   ecs:DescribeServices, ecs:DescribeTaskDefinition,
#   ecs:RegisterTaskDefinition, iam:PassRole on the live task +
#   execution roles (unchanged ARNs; we pass through the cloned def).
#
# Usage:
#   bash deploy/pin-ecs-image.sh \
#     --cluster wallet-hub \
#     --service wallet-hub-api \
#     --image 590184001652.dkr.ecr.us-east-1.amazonaws.com/wallet-hub-api:${SHA}
#
#   --dry-run          describe + render, do not register or update
#   --render-only      read --task-def-json, print register payload, exit
#   --task-def-json F  used with --render-only (no AWS calls)

set -euo pipefail

CLUSTER=""
SERVICE=""
IMAGE=""
REGION="${AWS_REGION:-}"
DRY_RUN=0
RENDER_ONLY=0
TASK_DEF_JSON=""

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --task-def-json) TASK_DEF_JSON="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --render-only) RENDER_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$IMAGE" ]]; then
  echo "error: --image is required" >&2
  exit 2
fi

# Refuse the finding: a moving tag. Digests (@sha256:...) are immutable.
image_tag="${IMAGE##*:}"
if [[ "$IMAGE" != *@sha256:* ]]; then
  if [[ "$IMAGE" != *:* || "$image_tag" == "$IMAGE" ]]; then
    echo "error: --image must include a tag or digest: $IMAGE" >&2
    exit 2
  fi
  if [[ "$image_tag" == "latest" ]]; then
    echo "error: refusing to pin :latest (mutable). Pass a commit SHA tag or digest." >&2
    exit 2
  fi
fi

# Strip digest then trailing :tag. ECR URIs have no port, so one trailing
# colon is the tag. Used by jq via --arg and by the match-count check.
jq_repo_fn='def repo: split("@")[0] | if test(":[^/]+$") then sub(":[^:]+$"; "") else . end;'

strip_register_fields='del(
  .taskDefinitionArn,
  .revision,
  .status,
  .requiresAttributes,
  .compatibilities,
  .registeredAt,
  .registeredBy,
  .deregisteredAt
)'

render_payload() {
  local src="$1"
  jq -c --arg IMAGE "$IMAGE" \
    "${jq_repo_fn}
     ${strip_register_fields}
     | .containerDefinitions |= map(
         if ((.image | repo) == (\$IMAGE | repo)) then .image = \$IMAGE else . end
       )" \
    "$src"
}

match_count() {
  local src="$1"
  jq --arg IMAGE "$IMAGE" \
    "${jq_repo_fn}
     [.containerDefinitions[].image | repo]
     | map(select(. == (\$IMAGE | repo)))
     | length" \
    "$src"
}

already_pinned() {
  local src="$1"
  jq -e --arg IMAGE "$IMAGE" \
    "${jq_repo_fn}
     any(.containerDefinitions[];
       ((.image | repo) == (\$IMAGE | repo)) and (.image == \$IMAGE)
     ) and
     all(.containerDefinitions[];
       ((.image | repo) != (\$IMAGE | repo)) or (.image == \$IMAGE)
     )" \
    "$src" >/dev/null
}

if [[ "$RENDER_ONLY" -eq 1 ]]; then
  if [[ -z "$TASK_DEF_JSON" ]]; then
    echo "error: --render-only requires --task-def-json" >&2
    exit 2
  fi
  count="$(match_count "$TASK_DEF_JSON")"
  if [[ "$count" -lt 1 ]]; then
    echo "error: no container image in the task def shares the repository of $IMAGE" >&2
    echo "images:" >&2
    jq -r '.containerDefinitions[].image' "$TASK_DEF_JSON" >&2
    exit 1
  fi
  render_payload "$TASK_DEF_JSON"
  exit 0
fi

if [[ -z "$CLUSTER" || -z "$SERVICE" ]]; then
  echo "error: --cluster and --service are required" >&2
  exit 2
fi

command -v aws >/dev/null 2>&1 || { echo "error: aws CLI is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

AWS_ARGS=()
if [[ -n "$REGION" ]]; then
  AWS_ARGS+=(--region "$REGION")
fi

echo "Resolving live task definition for $CLUSTER / $SERVICE ..."
svc_status="$(aws ecs describe-services \
  "${AWS_ARGS[@]}" \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --query 'services[0].status' \
  --output text)"
if [[ -z "$svc_status" || "$svc_status" == "None" || "$svc_status" == "INACTIVE" ]]; then
  echo "error: service $SERVICE on $CLUSTER is missing or INACTIVE (status=${svc_status:-empty})" >&2
  exit 1
fi

live_td="$(aws ecs describe-services \
  "${AWS_ARGS[@]}" \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --query 'services[0].taskDefinition' \
  --output text)"
if [[ -z "$live_td" || "$live_td" == "None" ]]; then
  echo "error: service $SERVICE has no taskDefinition" >&2
  exit 1
fi
echo "Live task definition: $live_td"

tmp="$(mktemp)"
trap 'rm -f "$tmp" "${tmp}.out"' EXIT

aws ecs describe-task-definition \
  "${AWS_ARGS[@]}" \
  --task-definition "$live_td" \
  --query 'taskDefinition' \
  >"$tmp"

count="$(match_count "$tmp")"
if [[ "$count" -lt 1 ]]; then
  echo "error: no container in $live_td shares the repository of $IMAGE" >&2
  echo "live images:" >&2
  jq -r '.containerDefinitions[].image' "$tmp" >&2
  exit 1
fi

if already_pinned "$tmp"; then
  echo "Already pinned to $IMAGE (revision $live_td). Skipping register."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "dry-run: would leave service on $live_td"
    exit 0
  fi
  # Point the service at this revision explicitly in case desiredCount
  # drifted; do not --force-new-deployment (that is the old :latest path).
  aws ecs update-service \
    "${AWS_ARGS[@]}" \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$live_td" \
    --query 'service.{taskDefinition:taskDefinition,desiredCount:desiredCount}' \
    --output json
  exit 0
fi

render_payload "$tmp" >"${tmp}.out"

echo "Rendered register payload (image-only delta):"
jq -r '.containerDefinitions[] | "  \(.name): \(.image)"' "${tmp}.out"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: not registering or updating the service"
  exit 0
fi

new_arn="$(aws ecs register-task-definition \
  "${AWS_ARGS[@]}" \
  --cli-input-json "file://${tmp}.out" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"
echo "Registered $new_arn"

aws ecs update-service \
  "${AWS_ARGS[@]}" \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --task-definition "$new_arn" \
  --query 'service.{taskDefinition:taskDefinition,desiredCount:desiredCount}' \
  --output json

echo "Service $SERVICE now targets $new_arn"
