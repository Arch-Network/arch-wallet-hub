import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface WalletHubStackProps extends cdk.StackProps {
  /** Allowed CORS origins (comma-separated). Required in prod. */
  corsAllowOrigins?: string;
}

export class WalletHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WalletHubStackProps = {}) {
    super(scope, id, props);

    // ─── VPC ───────────────────────────────────────────────
    // Use the default VPC to avoid hitting VPC/IGW limits in this account.
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });

    // ─── Secrets ───────────────────────────────────────────
    // App secrets bundle. Populated post-deploy via the AWS console or
    // CLI; the generateSecretString here only seeds CHANGE_ME values
    // so the stack creates cleanly on first deploy.
    //
    // `generateStringKey: "DB_PASSWORD"` makes Secrets Manager mint the
    // RDS master password as part of this single bundle. The live DB
    // master password is stored here under `DB_PASSWORD` and is reused
    // verbatim by the RDS instance below (see `Credentials.fromPassword`).
    //
    // DO NOT EDIT `generateSecretString` (#123). Any change to it —
    // adding a key to the template, changing `generateStringKey` or a
    // generator option — makes CloudFormation write a NEW secret version
    // from the template, replacing every populated value (Turnkey keys,
    // DB_PASSWORD, AUDIT_HMAC_SECRET, …) with CHANGE_ME. It must stay
    // byte-identical to the deployed template. Add new keys
    // (AUDIT_HMAC_SECRET, INDEXER_SERVICE_KEY, …) to the live secret by
    // hand and reference them with `ecs.Secret.fromSecretsManager` only.
    const appSecrets = new secretsmanager.Secret(this, "AppSecrets", {
      secretName: "WalletHub/AppSecrets",
      description: "Wallet Hub application secrets",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          TURNKEY_API_PUBLIC_KEY: "CHANGE_ME",
          TURNKEY_API_PRIVATE_KEY: "CHANGE_ME",
          TURNKEY_ORGANIZATION_ID: "CHANGE_ME",
          PLATFORM_ADMIN_API_KEY: "CHANGE_ME",
          INDEXER_API_KEY: "",
          INTERNAL_API_KEY: "CHANGE_ME",
        }),
        generateStringKey: "DB_PASSWORD",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // ─── RDS Postgres ──────────────────────────────────────
    //
    // SECURITY:
    //   - Subnets: placed in PUBLIC subnets as an INTERIM state to
    //     match the live default VPC, which has only public subnets
    //     (no NAT). The DB is NOT internet-reachable: it is
    //     `publiclyAccessible=false` and locked down to the API
    //     service security group only (see `DbSg` ingress below).
    //     Migration to true private subnets is tracked in
    //     RUNBOOK-phase3-hardening.md.
    //   - Credentials: the master password is the existing value in
    //     `WalletHub/AppSecrets` under key `DB_PASSWORD` and is reused
    //     verbatim (`Credentials.fromPassword`). We deliberately do
    //     NOT mint a new `rds.DatabaseSecret`, since deploying that
    //     against the existing instance would RESET the master
    //     password. We also never materialise the password into a
    //     DATABASE_URL env var; the container reads DB_PASSWORD as a
    //     secret and builds its own connection string at startup.
    //   - Deletion: `RETAIN` removal policy + `deletionProtection`.
    //
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "Wallet Hub RDS",
      allowAllOutbound: false,
    });

    const db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        // Matches the deployed template. The instance auto-minor-upgrades,
        // so the running version is newer; CloudFormation only acts on
        // template changes, so leaving this untouched is a no-op. Bump it
        // only to the exact running version (`aws rds describe-db-instances`).
        version: rds.PostgresEngineVersion.VER_16_6,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      // INTERIM: public subnets to match the live default VPC (no NAT).
      // DB stays `publiclyAccessible=false` + SG-locked. Phase 3 moves
      // this to private subnets — see RUNBOOK-phase3-hardening.md.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSecurityGroup],
      publiclyAccessible: false,
      databaseName: "wallet_hub",
      // Reuse the EXISTING master password from AppSecrets (key
      // DB_PASSWORD). This matches the deployed stack and guarantees
      // `cdk diff` shows no master-password change / no secret swap.
      credentials: rds.Credentials.fromPassword(
        "wallet_hub",
        appSecrets.secretValueFromJson("DB_PASSWORD")
      ),
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── ECR Repositories (import existing) ────────────────
    const apiRepo = ecr.Repository.fromRepositoryName(
      this,
      "ApiRepo",
      "wallet-hub-api"
    );
    const frontendRepo = ecr.Repository.fromRepositoryName(
      this,
      "FrontendRepo",
      "wallet-hub-frontend"
    );

    // ─── ECS Cluster ───────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: "wallet-hub",
    });

    // ─── ALB ───────────────────────────────────────────────
    //
    // The ALB, API and frontend services use the security groups CDK
    // creates for them. They are the deployed groups; supplying explicit
    // `ec2.SecurityGroup`s would replace all three (#123).
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      loadBalancerName: "wallet-hub-alb",
    });

    // The stack manages only the port-80 listener. Production's HTTPS
    // listener on 443 (ACM cert; `/v1/*` -> ApiTg, default -> FrontendTg)
    // was created by hand and is NOT in this stack (#123). Creating a 443
    // listener here would conflict with it, so refuse rather than ignore
    // a `certificateArn` until that listener is imported.
    if (this.node.tryGetContext("certificateArn")) {
      throw new Error(
        "WalletHubStack: the 443 listener is hand-managed (see #123). Import it into the stack before managing HTTPS here."
      );
    }
    const listener = alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // ─── API Service ───────────────────────────────────────
    const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    const corsOrigins =
      props.corsAllowOrigins ?? this.node.tryGetContext("corsAllowOrigins");

    const apiContainer = apiTaskDef.addContainer("api", {
      // `:latest` is the CDK bootstrap / `cdk deploy` fallback so a
      // first-time stack has a pullable tag. CI then pins the *running*
      // service to an immutable git-SHA tag by cloning the live task
      // def (deploy/pin-ecs-image.sh, issue #47). Do not have CI
      // register a revision synthesized from this file — live env and
      // secrets have drifted from this stack; image-only clone is the
      // safe deploy path. A later `cdk deploy` may briefly re-point at
      // `:latest` until the next successful workflow run re-pins.
      image: ecs.ContainerImage.fromEcrRepository(apiRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "wallet-hub-api",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      // Run as a non-root user. The image must include a `node` user
      // with shell access to /app -- the upstream node:*-slim images
      // ship one. See deploy/Dockerfile.api.
      user: "1000",
      readonlyRootFilesystem: false,
      environment: {
        NODE_ENV: "production",
        PORT: "3005",
        DB_RUN_MIGRATIONS: "true",
        TURNKEY_BASE_URL: "https://api.turnkey.com",
        TURNKEY_OTP_EMAIL_APP_NAME: "Arch Wallet",
        TURNKEY_OTP_EMAIL_LOGO_URL: "",
        TURNKEY_OTP_EMAIL_MAGIC_LINK_TEMPLATE: "",
        TURNKEY_OTP_EMAIL_TEMPLATE_ID: "",
        TURNKEY_OTP_EMAIL_SENDER_NAME: "",
        TURNKEY_OTP_EMAIL_SENDER_ADDRESS: "",
        TURNKEY_OTP_EMAIL_REPLY_TO_ADDRESS: "",
        TURNKEY_OTP_EMAIL_CUSTOMIZATION_JSON: "",
        ARCH_RPC_NODE_URL: "https://rpc.testnet.arch.network",
        ARCH_RPC_NODE_URL_TESTNET: "https://rpc.testnet.arch.network",
        ARCH_RPC_NODE_URL_MAINNET: "https://rpc.mainnet.arch.network",
        INDEXER_BASE_URL: "https://explorer.arch.network/api/v1/testnet",
        ARCH_TRANSFER_REQUIRE_ANCHORED_UTXO: "false",
        // Global 300/min per app key + IP, plus per-route overrides. The
        // store is in-memory per task, so limits scale with desiredCount.
        // Log mode, matching live revision 19: would-be 429s are logged and
        // allowed through. Enforce ("true") only as a deliberate change.
        RATE_LIMIT_ENABLED: "log",
        // SECURITY: never default to `*`. Refuse to deploy without an
        // explicit allow-list. The `@fastify/cors` plugin also
        // enforces this server-side.
        CORS_ALLOW_ORIGINS:
          corsOrigins && corsOrigins !== "*"
            ? corsOrigins
            : (() => {
                throw new Error(
                  "WalletHubStack: corsAllowOrigins must be a non-wildcard comma-separated list (set via stack prop or `cdk -c corsAllowOrigins=...`)"
                );
              })(),
        INDEXER_TIMEOUT_MS: "30000",
        // DB connection info as plain env (split-env model, matching the
        // live task def). DB_USER is the non-secret master username; only
        // DB_PASSWORD is injected as a secret below. `wallet-hub-api`
        // builds its own connection string from these at startup, so the
        // password never appears materialised in the rendered task def.
        DB_HOST: db.instanceEndpoint.hostname,
        DB_PORT: "5432",
        DB_NAME: "wallet_hub",
        DB_USER: "wallet_hub",
        // Enforce TLS to RDS. The app assembles its connection string from
        // the DB_* vars and only enables `pg` SSL when sslmode is
        // require/verify (see services/wallet-hub-api/src/plugins/db.ts).
        // The app schema already defaults this to "require"; we set it
        // explicitly so TLS enforcement is visible in the task def and
        // resilient to any future change of that default. RDS also
        // enforces it server-side (rds.force_ssl=1).
        DB_SSLMODE: "require",
        DEPLOY_STAMP: new Date().toISOString(),
      },
      secrets: {
        // DB password sourced from the existing AppSecrets bundle (key
        // DB_PASSWORD) — the same value used for the RDS master password.
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appSecrets, "DB_PASSWORD"),
        // Required in production for audit-log tamper-evidence; the live
        // secret already carries a real value.
        AUDIT_HMAC_SECRET: ecs.Secret.fromSecretsManager(
          appSecrets,
          "AUDIT_HMAC_SECRET"
        ),
        TURNKEY_API_PUBLIC_KEY: ecs.Secret.fromSecretsManager(
          appSecrets,
          "TURNKEY_API_PUBLIC_KEY"
        ),
        TURNKEY_API_PRIVATE_KEY: ecs.Secret.fromSecretsManager(
          appSecrets,
          "TURNKEY_API_PRIVATE_KEY"
        ),
        TURNKEY_ORGANIZATION_ID: ecs.Secret.fromSecretsManager(
          appSecrets,
          "TURNKEY_ORGANIZATION_ID"
        ),
        PLATFORM_ADMIN_API_KEY: ecs.Secret.fromSecretsManager(
          appSecrets,
          "PLATFORM_ADMIN_API_KEY"
        ),
        INDEXER_API_KEY: ecs.Secret.fromSecretsManager(
          appSecrets,
          "INDEXER_API_KEY"
        ),
        // NOTE: INTERNAL_API_KEY is intentionally NOT injected into the API
        // container. It is not read anywhere in services/wallet-hub-api/src;
        // the API authenticates inbound X-Api-Key against DB-backed per-app
        // keys (plugins/appAuth.ts), not its own env value. The live task
        // defs (revisions 12 and 17) also omit it.
      },
      portMappings: [{ containerPort: 3005, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"const http=require('http');const r=http.get('http://localhost:3005/v1/health',(res)=>{process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1))\"",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount: 1,
      serviceName: "wallet-hub-api",
      // INTERIM: public subnets + public IP to match the live default
      // VPC (no NAT for image/secret pulls). Inbound is limited to the
      // ALB, which CDK wires when the target group joins the listener.
      // Private subnets are a follow-up — see RUNBOOK-phase3-hardening.md.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Allow API -> RDS
    apiService.connections.allowTo(
      dbSecurityGroup,
      ec2.Port.tcp(5432),
      "API to Postgres"
    );

    // ─── Frontend Service ──────────────────────────────────
    const frontendTaskDef = new ecs.FargateTaskDefinition(
      this,
      "FrontendTaskDef",
      {
        memoryLimitMiB: 512,
        cpu: 256,
      }
    );

    frontendTaskDef.addContainer("frontend", {
      // Same split as the API container: CDK keeps `:latest` as the
      // synth default; CI pins the live revision to a SHA tag. See
      // deploy/pin-ecs-image.sh / issue #47.
      image: ecs.ContainerImage.fromEcrRepository(frontendRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "wallet-hub-frontend",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      // Matches the image in ECR (March 2026), which predates the
      // non-root nginx on 8080 + `/healthz` in deploy/Dockerfile.frontend.
      // Switch to user 101, port 8080, `/healthz` and an INTERNAL_API_KEY
      // secret only after rebuilding and pushing that image, together with
      // FrontendTg below (a port change replaces it) and the hand-made 443
      // listener that forwards to it (#123).
      environment: {
        INTERNAL_API_KEY: "placeholder",
      },
      portMappings: [{ containerPort: 80, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -f http://localhost/ || exit 1",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const frontendService = new ecs.FargateService(this, "FrontendService", {
      cluster,
      taskDefinition: frontendTaskDef,
      desiredCount: 1,
      serviceName: "wallet-hub-frontend",
      // INTERIM: public subnets + public IP to match the live default
      // VPC (no NAT). Reachable only from the ALB. Private subnets are a
      // follow-up — see RUNBOOK-phase3-hardening.md.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ─── ALB Target Groups & Routing ───────────────────────
    const apiTargetGroup = new elbv2.ApplicationTargetGroup(this, "ApiTg", {
      vpc,
      port: 3005,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/v1/health",
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
      },
    });
    apiTargetGroup.addTarget(
      apiService.loadBalancerTarget({ containerName: "api", containerPort: 3005 })
    );

    const frontendTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "FrontendTg",
      {
        vpc,
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: "/",
          interval: cdk.Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          timeout: cdk.Duration.seconds(10),
        },
      }
    );
    frontendTargetGroup.addTarget(
      frontendService.loadBalancerTarget({
        containerName: "frontend",
        containerPort: 80,
      })
    );

    // API routes: /v1/* go to the API service
    listener.addTargetGroups("ApiRoute", {
      targetGroups: [apiTargetGroup],
      conditions: [elbv2.ListenerCondition.pathPatterns(["/v1/*"])],
      priority: 10,
    });

    // Default: everything else goes to frontend
    listener.addTargetGroups("DefaultRoute", {
      targetGroups: [frontendTargetGroup],
    });

    // ─── Outputs ───────────────────────────────────────────
    new cdk.CfnOutput(this, "AlbDns", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name — use this as the app URL",
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: `http://${alb.loadBalancerDnsName}/v1`,
      description: "API base URL for SDK / Postman",
    });
    new cdk.CfnOutput(this, "FrontendUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "Demo dapp URL for testers",
    });
    new cdk.CfnOutput(this, "SecretArn", {
      value: appSecrets.secretArn,
      description: "Secrets Manager ARN — populate secrets here",
    });
    new cdk.CfnOutput(this, "EcsClusterName", {
      value: cluster.clusterName,
      description: "ECS cluster name for manual operations",
    });
    new cdk.CfnOutput(this, "ApiRepoUri", {
      value: apiRepo.repositoryUri,
      description: "ECR URI for API images",
    });
    new cdk.CfnOutput(this, "FrontendRepoUri", {
      value: frontendRepo.repositoryUri,
      description: "ECR URI for frontend images",
    });
  }
}
