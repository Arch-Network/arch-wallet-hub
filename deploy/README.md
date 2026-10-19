# Arch Wallet Hub - Deployment

## Live Environment

| | URL |
|---|---|
| **Frontend (demo dapp)** | http://wallet-hub-alb-1812078009.us-east-1.elb.amazonaws.com |
| **API** | http://wallet-hub-alb-1812078009.us-east-1.elb.amazonaws.com/v1 |
| **Health check** | http://wallet-hub-alb-1812078009.us-east-1.elb.amazonaws.com/v1/health |

> **Production TLS is required.** The endpoints above are currently
> served over plain HTTP, which exposes API keys and wallet traffic to
> network observers. See [Production TLS](#production-tls) before any
> real / mainnet use.

## Production TLS

All production traffic MUST be served over HTTPS. There are two
supported topologies:

1. **TLS terminated upstream (ALB / CloudFront) — recommended for ECS.**
   - Add an HTTPS (443) listener to the ALB with an ACM certificate and
     redirect the HTTP (80) listener to HTTPS.
   - The ALB forwards `X-Forwarded-Proto`; the API trusts it
     (`trustProxy` is on).
2. **TLS terminated at nginx (single-host / EC2).**
   - Use [`deploy/nginx-tls.conf.template`](./nginx-tls.conf.template)
     instead of `nginx.conf.template`. It redirects HTTP→HTTPS, serves
     443 with your cert, sets HSTS, and forwards `X-Forwarded-Proto: https`.
   - Obtain a cert (e.g. certbot) and mount it at `/etc/nginx/tls/`.

Once TLS terminates in front of the API, set **`REQUIRE_HTTPS=true`** on
the API service. With it enabled the API rejects any request that did
not arrive over HTTPS (`426 Upgrade Required`), except the internal
`/v1/health` probe. It defaults to `false` so a not-yet-TLS environment
isn't bricked; flipping it on is a deliberate step taken *after* the
HTTPS listener exists.

## Architecture (ECS Fargate)

```
┌─────────────────────────────────────────────────┐
│               Application Load Balancer         │
│                                                 │
│   /*          → Frontend (nginx, port 80)       │
│   /v1/*       → API (Node.js, port 3005)        │
└─────────────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
   ┌────▼────┐   ┌──────▼──────┐  ┌────▼─────┐
   │ Frontend │   │   API       │  │  RDS     │
   │ (Fargate)│   │  (Fargate)  │──│ Postgres │
   │  nginx   │   │  Fastify    │  │  16      │
   └──────────┘   └─────────────┘  └──────────┘
                        │
              ┌─────────┼──────────┐
              │         │          │
         Arch RPC   Turnkey   Explorer
         (testnet)   API       API
```

**AWS Resources:**
- ECS Fargate cluster (`wallet-hub`) with 2 services
- RDS Postgres 16 (`db.t3.micro`, free tier)
- ALB with path-based routing
- Secrets Manager (`WalletHub/AppSecrets`)
- ECR repos: `wallet-hub-api`, `wallet-hub-frontend`

**Estimated cost:** ~$30-50/month (testing/low traffic)

## For Testers

1. Open the frontend URL above
2. Connect a wallet (Testnet4)
3. The API key is baked into the frontend build

To test the API directly (Postman, curl, SDK):
```bash
curl -H "X-Api-Key: YOUR_API_KEY" \
  http://wallet-hub-alb-1812078009.us-east-1.elb.amazonaws.com/v1/health
```

## CI/CD

Push to `main` triggers `.github/workflows/deploy.yml`:
1. Builds Docker images for API (frontend steps are currently `if: false`; see the workflow comment)
2. Pushes to ECR as both `:${{ github.sha }}` (immutable) and `:latest` (operator convenience / CDK fallback)
3. Pins the running ECS task definition to the SHA tag via `deploy/pin-ecs-image.sh` (rolling deployment of that revision)

The pin helper **clones the live task definition** and changes only the matching container image. It does **not** `--force-new-deployment` of `:latest` (that re-pulls a mutable tag; issue #47) and it does **not** register a CDK-shaped revision (production runs a hand-registered task definition; see #123). Env, secret, and CPU changes therefore never reach production through CI: register the new revision by hand and make the same change in `infra/cdk`, and do not `cdk deploy` without the reviewed template diff described under [Infrastructure changes (CDK)](#infrastructure-changes-cdk). The next CI run clones whatever revision the service is running.

**Prerequisites:** Set `AWS_DEPLOY_ROLE_ARN` in GitHub repo secrets. The role needs ECR push plus:

- `ecs:UpdateService`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition`
- `iam:PassRole` on the existing task role and execution role (the helper re-registers the live ARNs; it does not create new roles)

## Manual Operations

### Rebuild and deploy images manually

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 590184001652.dkr.ecr.us-east-1.amazonaws.com

SHA="$(git rev-parse HEAD)"
ECR=590184001652.dkr.ecr.us-east-1.amazonaws.com

# Build and push API (SHA tag is what ECS will run; :latest is a convenience alias)
docker build --platform linux/amd64 \
  -t $ECR/wallet-hub-api:$SHA \
  -t $ECR/wallet-hub-api:latest \
  -f deploy/Dockerfile.api .
docker push $ECR/wallet-hub-api:$SHA
docker push $ECR/wallet-hub-api:latest

# Build and push frontend
docker build --platform linux/amd64 \
  --build-arg VITE_WALLET_HUB_BASE_URL=/v1 \
  --build-arg VITE_WALLET_HUB_API_KEY=YOUR_API_KEY \
  --build-arg NGINX_CONF=deploy/nginx-fargate.conf.template \
  -t $ECR/wallet-hub-frontend:$SHA \
  -t $ECR/wallet-hub-frontend:latest \
  -f deploy/Dockerfile.frontend .
docker push $ECR/wallet-hub-frontend:$SHA
docker push $ECR/wallet-hub-frontend:latest

# Pin the live task defs to the SHA (does not re-pull :latest)
bash deploy/pin-ecs-image.sh --cluster wallet-hub --service wallet-hub-api \
  --region us-east-1 --image $ECR/wallet-hub-api:$SHA
bash deploy/pin-ecs-image.sh --cluster wallet-hub --service wallet-hub-frontend \
  --region us-east-1 --image $ECR/wallet-hub-frontend:$SHA
```

### Update secrets

```bash
aws secretsmanager put-secret-value \
  --secret-id WalletHub/AppSecrets \
  --secret-string '{"TURNKEY_API_PUBLIC_KEY":"...","TURNKEY_API_PRIVATE_KEY":"...","TURNKEY_ORGANIZATION_ID":"...","PLATFORM_ADMIN_API_KEY":"...","INDEXER_API_KEY":"...","INTERNAL_API_KEY":"...","DB_PASSWORD":"..."}'
```

After updating secrets, roll the API tasks so they re-read Secrets Manager. If the service is already pinned to a SHA tag, this is one of the few remaining legitimate uses of `--force-new-deployment` (same task def, new tasks):

```bash
aws ecs update-service --cluster wallet-hub --service wallet-hub-api --force-new-deployment
```

### App-store review login (dummy mainnet wallet)

Google Play / App Store reviewers can't receive the Turnkey OTP email the
email-wallet unlock depends on, which blocks public releases. The Hub can
expose a single pre-provisioned **dummy mainnet wallet** that unlocks with a
fixed test email + static OTP code, gated entirely behind
`REVIEW_LOGIN_ENABLED` (default `false`). Every other email keeps the normal,
fully OTP-gated path. Treat the dummy wallet as public and keep no value in it.

**How it works:** for the configured email, `/v1/recovery/email/{init,start,verify}`
skip Turnkey's OTP and return a credential bundle the client decrypts exactly
like a real one — it wraps a permanent "review" API key that is already
registered on the dummy sub-org's root user, which the client then spends once
via `STAMP_LOGIN`.

**One-time provisioning:**

1. Create the dummy email wallet on **mainnet**:
   ```bash
   curl -X POST \
     -H "X-Api-Key: $HUB_API_KEY" -H "X-Network: mainnet" \
     -H "Idempotency-Key: review-$(date +%s)" \
     -H "Content-Type: application/json" \
     -d '{"externalUserId":"play-review","userEmail":"play-review@arch.network"}' \
     https://<hub>/v1/turnkey/email-wallets
   ```
   Record `organizationId`, `walletId`, `defaultAddress`, and
   `defaultPublicKeyHex` from the response, plus the sub-org root user id.
2. Run the real email-OTP recovery once (receive the code, decrypt the bundle)
   and stamp `ACTIVITY_TYPE_CREATE_API_KEYS_V2` to register a permanent review
   API key (P-256) on that root user. Keep the key's **raw 32-byte private key
   (64 hex chars)**.
3. Put the values into the API secret and enable the feature:
   ```bash
   aws secretsmanager put-secret-value --secret-id WalletHub/AppSecrets \
     --secret-string '{..., "REVIEW_LOGIN_API_PRIVATE_KEY_HEX":"<64-hex>"}'
   # plus env on the task definition:
   #   REVIEW_LOGIN_ENABLED=true
   #   REVIEW_LOGIN_EMAIL=play-review@arch.network
   #   REVIEW_LOGIN_OTP_CODE=<static code, >=4 chars>
   #   REVIEW_LOGIN_ORGANIZATION_ID / _ROOT_USER_ID / _WALLET_ID
   #   REVIEW_LOGIN_DEFAULT_ADDRESS / _DEFAULT_PUBLIC_KEY_HEX / _EXTERNAL_USER_ID
   ```
   The API fails fast at boot if `REVIEW_LOGIN_ENABLED=true` and any required
   field is missing or malformed. Hand the reviewer the email + static code;
   they pick "Recover via email" in the app and land in the dummy wallet.

### Infrastructure changes (CDK)

> **Do not `cdk deploy` without a reviewed template diff** (see #123). The
> stack has not been deployed since 2026-05-06; production runs hand-registered
> API task definitions and a hand-made HTTPS listener. Before any deploy, a
> human must review a fresh `cdk diff --method template` against the live
> stack (no RDS replacement, no `AppSecrets` change) and confirm RDS deletion
> protection is on.

```bash
cd infra/cdk
npm ci
# Read-only: compares against the deployed template. The default diff method
# creates a CloudFormation change set, so always pass --method template.
npx cdk diff WalletHubStack --method template \
  -c corsAllowOrigins=https://hub.arch.network
# Only after the review above. CDK prompts before IAM / security-group changes;
# do not pass --require-approval never.
npx cdk deploy WalletHubStack -c corsAllowOrigins=https://hub.arch.network
```

`npx cdk` resolves to the `aws-cdk` CLI pinned in `infra/cdk/package.json`.
`corsAllowOrigins` is required; synthesis fails without it.

### View logs

```bash
# API logs
aws logs tail WalletHubStack-ApiTaskDefapiLogGroup9FDF1262-QSwOGdEbh7LA --follow

# Frontend logs
aws logs tail WalletHubStack-FrontendTaskDeffrontendLogGroupFDDEEC5B-Jjzf74V1OmnV --follow
```

### Tear down everything

```bash
cd infra/cdk
npx cdk destroy
```

## Local Development (Docker Compose)

For local development, use the docker-compose setup which includes nginx proxying:

```bash
cd deploy
cp .env.example .env
# Edit .env with your secrets
docker-compose up -d --build
```

- Frontend: http://localhost
- API: http://localhost:3005/v1
