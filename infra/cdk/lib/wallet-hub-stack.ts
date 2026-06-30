import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface WalletHubStackProps extends cdk.StackProps {
  /** ACM cert ARN for the public ALB hostname (required in prod). */
  certificateArn?: string;
  /** Operator CIDR allowed to reach the ALB directly on ports 80/443. */
  operatorIngressCidrs?: string[];
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
    // RDS master password as part of this single bundle (on FIRST create
    // only). The live DB master password is already stored here under
    // `DB_PASSWORD` and is reused verbatim by the RDS instance below
    // (see `Credentials.fromPassword`), so deploying does NOT reset it.
    // `AUDIT_HMAC_SECRET` is part of the schema because the API requires
    // it in production (audit-log tamper-evidence); the live secret
    // already carries a real value for it. Changing this template on an
    // EXISTING secret is metadata-only — Secrets Manager never
    // regenerates an already-created secret's value.
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
          AUDIT_HMAC_SECRET: "CHANGE_ME",
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
        // Pinned to the live instance version (auto-minor-upgraded
        // from 16.6). Pinning prevents CFN from attempting a downgrade.
        version: rds.PostgresEngineVersion.VER_16_13,
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

    // ─── ALB security group ────────────────────────────────
    //
    // Public ingress only to 443. HTTP/80 is added below as a 301
    // redirect target. If `operatorIngressCidrs` is provided we add
    // those, otherwise we allow any-IP on 80/443 (typical for a
    // public web app behind ACM).
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "Wallet Hub ALB",
      allowAllOutbound: true,
    });
    const ingressCidrs = props.operatorIngressCidrs?.length
      ? props.operatorIngressCidrs
      : ["0.0.0.0/0"];
    for (const cidr of ingressCidrs) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), "HTTPS in");
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), "HTTP in (redirected to HTTPS)");
    }

    // ─── ALB ───────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      loadBalancerName: "wallet-hub-alb",
      securityGroup: albSg,
    });

    // HTTPS listener (only added when an ACM cert ARN is provided).
    // Without a cert we still create the stack but log a warning and
    // serve HTTP only -- intended for dev / first-deploy. In prod
    // `certificateArn` must be set.
    const certArn = props.certificateArn ?? this.node.tryGetContext("certificateArn");
    let listener: elbv2.ApplicationListener;
    if (certArn) {
      const cert = acm.Certificate.fromCertificateArn(this, "AlbCert", certArn);
      listener = alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [cert],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      });
      // 80 -> 443 redirect.
      alb.addListener("HttpRedirectListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    } else {
      cdk.Annotations.of(this).addWarning(
        "WalletHubStack: no certificateArn provided; ALB will serve plain HTTP. " +
          "Set the `certificateArn` stack prop or `cdk -c certificateArn=...` for production."
      );
      listener = alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });
    }

    // ─── API Service ───────────────────────────────────────
    const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    const corsOrigins =
      props.corsAllowOrigins ?? this.node.tryGetContext("corsAllowOrigins");

    const apiContainer = apiTaskDef.addContainer("api", {
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
        // Rate limiting is currently DISABLED to remove throttling. The
        // application code defaults this to "true"; we override to "false"
        // here. Reversible: set back to "true" (or remove this line) to
        // restore the global 300/min/key limit + per-route overrides.
        RATE_LIMIT_ENABLED: "false",
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
        INTERNAL_API_KEY: ecs.Secret.fromSecretsManager(
          appSecrets,
          "INTERNAL_API_KEY"
        ),
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

    const apiServiceSg = new ec2.SecurityGroup(this, "ApiServiceSg", {
      vpc,
      description: "Wallet Hub API service",
      allowAllOutbound: true,
    });

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount: 1,
      serviceName: "wallet-hub-api",
      // INTERIM: public subnets + public IP to match the live default
      // VPC (no NAT for image/secret pulls). The task is still only
      // reachable via the ALB SG; inbound is locked down below. Phase 3
      // moves this to private subnets — see RUNBOOK-phase3-hardening.md.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [apiServiceSg],
    });

    // Only the ALB may reach the API on its port.
    apiServiceSg.addIngressRule(albSg, ec2.Port.tcp(3005), "ALB to API");

    // Allow API -> RDS
    dbSecurityGroup.addIngressRule(apiServiceSg, ec2.Port.tcp(5432), "API to Postgres");

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
      image: ecs.ContainerImage.fromEcrRepository(frontendRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "wallet-hub-frontend",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      // nginx in the upstream image runs as `nginx` (uid 101).
      user: "101",
      environment: {},
      // SECURITY: ship the platform-app key for the frontend's
      // server-side proxy from Secrets Manager, not a literal env
      // value. This was previously a plain `placeholder` env entry.
      secrets: {
        INTERNAL_API_KEY: ecs.Secret.fromSecretsManager(
          appSecrets,
          "INTERNAL_API_KEY"
        ),
      },
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -fsS http://localhost:8080/healthz || exit 1",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const frontendServiceSg = new ec2.SecurityGroup(this, "FrontendServiceSg", {
      vpc,
      description: "Wallet Hub frontend service",
      allowAllOutbound: true,
    });

    const frontendService = new ecs.FargateService(this, "FrontendService", {
      cluster,
      taskDefinition: frontendTaskDef,
      desiredCount: 1,
      serviceName: "wallet-hub-frontend",
      // INTERIM: public subnets + public IP to match the live default
      // VPC (no NAT). Reachable only via the ALB SG. Phase 3 moves this
      // to private subnets — see RUNBOOK-phase3-hardening.md.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [frontendServiceSg],
    });

    frontendServiceSg.addIngressRule(albSg, ec2.Port.tcp(8080), "ALB to frontend");

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
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: "/healthz",
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
        containerPort: 8080,
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
    const scheme = certArn ? "https" : "http";
    new cdk.CfnOutput(this, "AlbDns", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name — use this as the app URL",
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: `${scheme}://${alb.loadBalancerDnsName}/v1`,
      description: "API base URL for SDK / Postman",
    });
    new cdk.CfnOutput(this, "FrontendUrl", {
      value: `${scheme}://${alb.loadBalancerDnsName}`,
      description: "Demo dapp URL for testers",
    });
    new cdk.CfnOutput(this, "AppSecretsArn", {
      value: appSecrets.secretArn,
      description:
        "Secrets Manager ARN — app secrets incl. DB_PASSWORD (RDS master)",
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
