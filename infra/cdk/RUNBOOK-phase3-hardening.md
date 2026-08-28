# Wallet Hub — Phase 3 Hardening Runbook

Operator runbook for the security hardening steps that are **deliberately
deferred** out of the `chore/wallet-hub-cdk-reconcile` PR. Nothing here is
executed by that PR. Each step is a separate, scheduled maintenance action.

**Context / current interim state (post-reconcile):**

- RDS Postgres + both ECS Fargate services run in the **default VPC's public
  subnets** (`vpc-00d691311acf7d017`, `172.31.0.0/16`). The default VPC has
  **only public subnets and no NAT gateway**, which is why public placement is
  the interim state.
- The DB is **not** internet-reachable: `publiclyAccessible=false` and its
  security group (`DbSg`) only allows `5432` from the API service SG
  (`ApiServiceSg`). Tasks run with `assignPublicIp: true` purely so they can
  pull images from ECR and read Secrets Manager (no NAT available).
- The RDS master password is the existing value stored in
  `WalletHub/AppSecrets` under key `DB_PASSWORD`; CDK reuses it verbatim via
  `Credentials.fromPassword`. No plaintext `DATABASE_URL` is injected anymore.
- The ALB serves **plain HTTP:80** because no ACM cert is wired
  (`certificateArn` unset).

Region: `us-east-1`. Account: `590184001652`. Stack: `WalletHubStack`.

> **Golden rule:** every change below goes through CDK (`infra/cdk`) and
> `cdk deploy`. Never hand-edit task definitions, SGs, or RDS settings in the
> console / CLI — that is how the live stack drifted before. Always run
> `cdk diff` first and confirm there is **no RDS replacement and no
> `MasterUserPassword` change** before deploying.

---

## A. Move RDS + ECS tasks to true private subnets

**Goal:** tasks and the DB sit in private subnets with no public IPs. This
removes the interim `assignPublicIp: true` and the public-subnet placement.

There are two viable ways to give private subnets outbound reachability for
ECR / Secrets Manager / CloudWatch Logs pulls. Pick one.

### Option 1 — Private subnets + NAT gateway (simplest, ongoing cost)

- **What:** Add a dedicated VPC (or new private subnets in the existing VPC)
  with a NAT gateway per AZ (or a single NAT for cost). Tasks egress to AWS
  APIs and the internet through the NAT.
- **Cost:** ~$32/mo per NAT gateway + data processing $/GB. Two AZs ≈ $65/mo
  baseline. This is the recurring cost trade-off vs Option 2.
- **CDK sketch:**
  - Replace `ec2.Vpc.fromLookup(... isDefault: true)` with a managed
    `new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1, subnetConfiguration:
    [{ name: "public", subnetType: PUBLIC }, { name: "private", subnetType:
    PRIVATE_WITH_EGRESS }] })`.
  - Set RDS and both services back to
    `vpcSubnets: { subnetType: PRIVATE_WITH_EGRESS }` and
    `assignPublicIp: false`.

### Option 2 — Keep default VPC, add VPC endpoints (cheaper, recommended)

Avoid NAT entirely by giving private subnets direct AWS-service routes:

- **Interface (PrivateLink) endpoints** (≈$7.30/mo each + $/GB) for:
  - `com.amazonaws.us-east-1.ecr.api`
  - `com.amazonaws.us-east-1.ecr.dkr`
  - `com.amazonaws.us-east-1.secretsmanager`
  - `com.amazonaws.us-east-1.logs` (CloudWatch Logs)
- **Gateway endpoint** (free) for **S3** (`com.amazonaws.us-east-1.s3`) — ECR
  image layers are stored in S3, so this is required for image pulls.
- Add private subnets to the default VPC (or a new VPC) with **no** NAT;
  routing to the four services goes through the endpoints.
- Endpoint SG must allow `443` inbound from the task SGs.
- **CDK sketch:** `vpc.addInterfaceEndpoint(...)` for each service +
  `vpc.addGatewayEndpoint("S3", { service: GatewayVpcEndpointAwsService.S3 })`,
  then flip `vpcSubnets`/`assignPublicIp` as in Option 1.

### Migration / import approach (applies to both options)

The hard part is the **RDS DB subnet group**. The DB is `RETAIN` +
`deletionProtection`, so it will not be deleted, but:

> ⚠️ **Risk — changing the DB subnet group is disruptive.** Modifying an RDS
> instance's subnet group (moving it to different subnets) triggers a
> **brief outage / possible reboot**, and CloudFormation may treat a subnet
> group change as requiring careful handling. Treat this as a **maintenance
> window**, not an in-place no-op.

Recommended sequencing:

1. **Land networking first, no DB move.** Deploy the new VPC/subnets +
   endpoints (or NAT) while RDS still references its current subnet group.
   `cdk diff` should show only additive endpoint/subnet/SG resources.
2. **Move ECS tasks next.** Flip the two services to private subnets +
   `assignPublicIp:false`. ECS does a rolling deploy; ALB keeps serving from
   healthy tasks. Verify both target groups go healthy before continuing.
3. **Move RDS last, in a window.** Update the DB's `vpcSubnets` to the private
   subnets. Snapshot the DB immediately before. Expect a short connection blip
   / failover-style interruption. Keep the SG rule (`ApiServiceSg → 5432`).
   - If CFN attempts to **replace** the instance instead of modifying it
     (check `cdk diff` for `replace`/`requires replacement` on
     `Postgres9DC8BB04`), **STOP** — do not deploy. Instead import-and-adjust:
     keep the logical ID `Postgres`, and if needed use a manual
     `aws rds modify-db-instance --db-subnet-group-name ...` to move it, then
     reconcile CDK to match (same pattern this reconcile PR used).

- **In-place vs window:** A (networking add) = in-place/no downtime.
  ECS move = rolling, effectively no downtime. **RDS subnet move = maintenance
  window** (announce it).
- **Rollback:** Networking is additive — leave it. For the RDS move, restore
  by pointing the subnet group back to the previous subnets (or restore the
  pre-move snapshot). Keep the pre-move snapshot for 7+ days.
- **Risk callouts:** wrong/missing S3 gateway endpoint → image pulls fail and
  tasks can't start; missing `logs` endpoint → tasks start but log driver
  errors; endpoint SG not allowing `443` from task SG → silent pull timeouts.

---

## B. Rotate the DB master password

Now that the plaintext `DATABASE_URL` is gone and the password flows only as a
Secrets Manager secret (`WalletHub/AppSecrets:DB_PASSWORD`, also the RDS master
password), it is safe to rotate. The previous plaintext value was exposed in an
old task-def revision (`:15` had it inline) — **rotate to invalidate it.**

**Steps (manual, controlled — preferred over automatic rotation for a single
shared key):**

1. Generate a new strong password (32+ chars, no shell-hostile punctuation to
   match `excludePunctuation`): `openssl rand -base64 32 | tr -d '/+=' | cut -c1-32`.
2. **Set it on RDS** (this is the authoritative change):
   `aws rds modify-db-instance --db-instance-identifier
   wallethubstack-postgres9dc8bb04-qwbku1ggyhzj --master-user-password '<NEW>'
   --apply-immediately`.
3. **Update the secret to match** so apps and CDK stay consistent:
   `aws secretsmanager put-secret-value --secret-id WalletHub/AppSecrets
   --secret-string "$(aws secretsmanager get-secret-value --secret-id
   WalletHub/AppSecrets --query SecretString --output text | jq -c
   '.DB_PASSWORD=\"<NEW>\"')"`.
4. **Roll the API tasks** so they pick up the new secret value:
   `aws ecs update-service --cluster wallet-hub --service wallet-hub-api
   --force-new-deployment`.
5. Verify `/v1/health` and DB connectivity, then confirm `cdk diff` is clean
   (the `MasterUserPassword` reference doesn't change — only the secret *value*
   changed, which is not in the template).

> ⚠️ **Brief-blip caveat.** `--apply-immediately` on `master-user-password`
> takes effect within seconds, but there is a short window where existing
> tasks still hold the OLD password and new connections may fail until step 4
> rolls them. Sequence tightly: do step 2 → step 3 → step 4 back-to-back. For
> zero-blip, briefly allow both old and new by rolling tasks first against a
> dual-valid window — RDS does not support two master passwords, so a few
> seconds of failed new connections is expected. Do this in a low-traffic
> window.

- **In-place vs window:** low-traffic window recommended; not a full outage.
- **Rollback:** if apps can't connect, immediately `modify-db-instance` back to
  the previous password and re-roll tasks. Keep the old value handy until
  verified.
- **Risk callouts:** order matters — if you update the secret (step 3) before
  RDS (step 2), newly rolled tasks get a password RDS hasn't accepted yet.
  Don't enable Secrets Manager *automatic* rotation against this multi-key
  bundle without a Lambda that understands the shared schema.

---

## C. Wire ALB TLS (HTTPS:443 + HTTP→HTTPS redirect)

Today the stack serves plain **HTTP:80** because `certificateArn` is unset, so
CDK falls back to a single `HttpListener` on 80 and prints a warning. Providing
a cert switches the stack to: a **443 HTTPS listener** (with the API `/v1/*`
and default frontend routing) **plus an 80→443 permanent redirect** — the
HTTP:80 serving listener is replaced by the redirect listener.

**Prerequisites:**

1. Decide the public hostname (e.g. `hub.arch.network`) and ensure DNS will
   point to the ALB (`wallet-hub-alb`).
2. Request/validate an ACM cert **in `us-east-1`** for that hostname (DNS
   validation): `aws acm request-certificate --domain-name hub.arch.network
   --validation-method DNS` → add the CNAME → wait for `ISSUED`.

**Deploy steps:**

3. Pass the cert ARN to CDK (no code change needed — it's a prop/context):
   `npx cdk deploy -c certificateArn=arn:aws:acm:us-east-1:590184001652:certificate/<id>
   -c corsAllowOrigins=https://hub.arch.network`
   (or set `certificateArn` on the stack props in `bin/app.ts`).
4. `cdk diff` first. Expect: **new** `HttpsListener` (443) + new
   `HttpRedirectListener` (80, redirect), and the existing `HttpListener` (80,
   forward) **removed/replaced**. Listeners are stateless — no data risk.
5. Deploy, then verify: `https://hub.arch.network/v1/health` returns 200, and
   `http://hub.arch.network` 301-redirects to `https://`.

- **In-place vs window:** effectively in-place. There is a brief moment as the
  80 listener is swapped from forward → redirect; clients on HTTP get a 301
  thereafter. No task restarts required.
- **Rollback:** remove `certificateArn` and redeploy to return to the HTTP:80
  listener (the stack supports the certless fallback). Or point DNS back.
- **Risk callouts:** cert MUST be in `us-east-1` (same region as the ALB) or
  the listener creation fails; if `corsAllowOrigins` isn't updated to the
  HTTPS origin the API will reject browser calls; ensure the ALB SG already
  allows `443` (it does — `AlbSg` opens 80 and 443).

---

## Pre-flight checklist (run before ANY deploy above)

- [ ] `cd infra/cdk && npx cdk diff -c corsAllowOrigins=https://hub.arch.network`
- [ ] Confirm `AWS::RDS::DBInstance Postgres` shows **no** `replace` /
      `requires replacement`.
- [ ] Confirm **no** `MasterUserPassword` line in the diff.
- [ ] Confirm `PostgresSubnetGroup` subnet list is intentional for this step.
- [ ] Take an RDS snapshot if the step touches the DB.
- [ ] Announce a window for step A.3 (RDS subnet move) and step B (rotation).
