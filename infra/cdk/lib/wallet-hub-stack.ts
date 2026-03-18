import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export class WalletHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // ─── VPC ───────────────────────────────────────────────
    // Use the default VPC to avoid hitting VPC/IGW limits in this account.
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });

    // ─── Secrets ───────────────────────────────────────────
    // Create a single secret bundle for all app secrets.
    // After first deploy, populate via the AWS console or CLI:
    //   aws secretsmanager put-secret-value --secret-id WalletHub/AppSecrets --secret-string '{...}'
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
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "Wallet Hub RDS",
      allowAllOutbound: false,
    });

    const db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_6,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSecurityGroup],
      publiclyAccessible: false,
      databaseName: "wallet_hub",
      credentials: rds.Credentials.fromPassword(
        "wallet_hub",
        appSecrets.secretValueFromJson("DB_PASSWORD")
      ),
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      loadBalancerName: "wallet-hub-alb",
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // ─── API Service ───────────────────────────────────────
    const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    const databaseUrl = cdk.Fn.join("", [
      "postgresql://wallet_hub:",
      appSecrets.secretValueFromJson("DB_PASSWORD").unsafeUnwrap(),
      "@",
      db.instanceEndpoint.hostname,
      ":5432/wallet_hub?sslmode=require",
    ]);

    const apiContainer = apiTaskDef.addContainer("api", {
      image: ecs.ContainerImage.fromEcrRepository(apiRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "wallet-hub-api",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        NODE_ENV: "production",
        PORT: "3005",
        DB_RUN_MIGRATIONS: "true",
        TURNKEY_BASE_URL: "https://api.turnkey.com",
        ARCH_RPC_NODE_URL: "https://rpc.testnet.arch.network",
        INDEXER_BASE_URL: "https://explorer.arch.network/api/v1/testnet",
        ARCH_TRANSFER_REQUIRE_ANCHORED_UTXO: "false",
        CORS_ALLOW_ORIGINS: "*",
        INDEXER_TIMEOUT_MS: "30000",
        DATABASE_URL: databaseUrl,
        DEPLOY_STAMP: new Date().toISOString(),
      },
      secrets: {
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
      assignPublicIp: true,
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
      image: ecs.ContainerImage.fromEcrRepository(frontendRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "wallet-hub-frontend",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
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
      assignPublicIp: true,
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
