import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional()
);
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional()
);
const optionalEmail = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().email().optional()
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // When true, reject any request that did not arrive over HTTPS
  // (judged by X-Forwarded-Proto, which the ALB / nginx sets; trustProxy
  // is enabled). Defaults to false so local/dev over plain HTTP keeps
  // working AND so enabling it can't silently break a not-yet-TLS
  // deployment. Production deployments MUST set REQUIRE_HTTPS=true once
  // TLS terminates in front of the API (see deploy/README.md).
  REQUIRE_HTTPS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Phase 2b of the session-auth rollout (docs/security/session-auth-rollout.md).
  // Comma-separated list of route keys (see plugins/sessionAuth.ts) on which
  // to ENFORCE a per-user session token + bind the body/query externalUserId
  // to the session principal. Use "*" (or "all") to enforce every opted-in
  // route at once.
  //
  // Defaults to EMPTY (enforce nothing) so it can't break clients that don't
  // yet mint/send tokens. Only flip routes on once token-sending wallet
  // builds dominate the field; un-updated clients on an enforced route get
  // 401. Roll out one route (or a small batch) at a time, ordered by risk.
  SESSION_ENFORCED_ROUTES: z.string().default(""),

  // Postgres
  //
  // Two ways to configure the DB:
  //   1. DATABASE_URL=postgres://...  (single string, dev / docker-compose)
  //   2. DB_HOST + DB_PORT + DB_NAME + DB_USER + DB_PASSWORD
  //      (production / Fargate; password injected from Secrets Manager
  //      via `ecs.Secret.fromSecretsManager(dbSecret, "password")`).
  //
  // Either form is accepted; if both are set, DATABASE_URL wins. The
  // four DB_* fields are validated below and assembled into a URL at
  // pool init time so the password is never logged.
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().positive().optional(),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_SSLMODE: z.enum(["disable", "require", "verify-full"]).default("require"),
  DB_RUN_MIGRATIONS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Turnkey sandbox credentials (API key auth)
  TURNKEY_BASE_URL: z.string().url().default("https://api.turnkey.com"),
  TURNKEY_ORGANIZATION_ID: z.string().min(1),
  TURNKEY_API_PUBLIC_KEY: z.string().min(1),
  TURNKEY_API_PRIVATE_KEY: z.string().min(1),
  // Optional Turnkey OTP email branding/template customization. The JSON field
  // is forwarded as-is after validation so we can use Turnkey-supported fields
  // without code changes.
  TURNKEY_OTP_EMAIL_APP_NAME: optionalString,
  TURNKEY_OTP_EMAIL_LOGO_URL: optionalUrl,
  TURNKEY_OTP_EMAIL_MAGIC_LINK_TEMPLATE: optionalUrl,
  TURNKEY_OTP_EMAIL_TEMPLATE_ID: optionalString,
  TURNKEY_OTP_EMAIL_SENDER_NAME: optionalString,
  TURNKEY_OTP_EMAIL_SENDER_ADDRESS: optionalEmail,
  TURNKEY_OTP_EMAIL_REPLY_TO_ADDRESS: optionalEmail,
  TURNKEY_OTP_EMAIL_CUSTOMIZATION_JSON: optionalString,

  // Platform admin (bootstrap apps + API keys)
  PLATFORM_ADMIN_API_KEY: z.string().optional(),

  // Tamper-evidence HMAC key for the audit-log chain (migration 014).
  // Every audit row stores hash = HMAC-SHA256(secret, prev_hash || row).
  // Without this secret, a DB-write attacker can't recompute valid
  // chain hashes -- the verifier catches their edits.
  //
  // Required in production. In dev/test we permit a synthesized
  // fallback so a fresh checkout works without env wiring; the
  // boot-time logger should warn loudly when the fallback kicks in.
  AUDIT_HMAC_SECRET: z.string().min(32).optional(),

  // CORS
  // Comma-separated list of allowed origins (e.g. "https://dapp.example.com,https://app.example.com")
  // Use "*" only if you explicitly want to allow all origins.
  // In development, we also allow http://localhost:5173 and http://127.0.0.1:5173 by default.
  CORS_ALLOW_ORIGINS: z.string().optional(),

  // Existing Arch indexer API (Phase 1 view-only reads)
  INDEXER_BASE_URL: z.string().url().optional(),
  INDEXER_API_KEY: z.string().optional(),
  // Timeout for upstream indexer calls (ms). The explorer API can be slow for accounts with
  // many transactions, so a generous default avoids spurious timeouts.
  INDEXER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // For Arch flows that depend on anchored BTC UTXOs (e.g., arch.transfer),
  // the validator may require a minimum BTC confirmation count before it can
  // generate the underlying "transaction to sign".
  //
  // Default aligns with current Arch validator behavior on testnet.
  BTC_MIN_CONFIRMATIONS: z.coerce.number().int().min(0).default(20),

  // Some Arch deployments may allow arch transfers without requiring an anchored BTC UTXO.
  // When false, Wallet Hub will skip BTC UTXO readiness checks for arch.transfer.
  ARCH_TRANSFER_REQUIRE_ANCHORED_UTXO: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Arch Network RPC nodes (for transaction submission). Use the network-specific
  // variants when both networks are served from the same Wallet Hub instance.
  // ARCH_RPC_NODE_URL is the legacy single-network fallback.
  ARCH_RPC_NODE_URL: z.string().url().optional(),
  ARCH_RPC_NODE_URL_TESTNET: z.string().url().optional(),
  ARCH_RPC_NODE_URL_MAINNET: z.string().url().optional()
});

export type Env = z.infer<typeof EnvSchema>;

export function getEnv(rawEnv: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    // Fail fast: configuration issues are safety issues.
    const message = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${message}`);
  }
  const env = parsed.data;
  if (!env.DATABASE_URL) {
    // Synthesize DATABASE_URL from DB_* fields.
    const missing = (["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"] as const).filter(
      (k) => !env[k],
    );
    if (missing.length > 0) {
      throw new Error(
        `Invalid environment: provide either DATABASE_URL or all of DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD (missing: ${missing.join(", ")})`,
      );
    }
    const user = encodeURIComponent(env.DB_USER!);
    const pass = encodeURIComponent(env.DB_PASSWORD!);
    env.DATABASE_URL = `postgresql://${user}:${pass}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}?sslmode=${env.DB_SSLMODE}`;
  }
  if (env.NODE_ENV === "production") {
    if (!env.PLATFORM_ADMIN_API_KEY) {
      throw new Error(
        "Invalid environment: PLATFORM_ADMIN_API_KEY is required in production",
      );
    }
    if (!env.CORS_ALLOW_ORIGINS || env.CORS_ALLOW_ORIGINS.trim() === "*") {
      throw new Error(
        "Invalid environment: CORS_ALLOW_ORIGINS must be an explicit comma-separated list in production (not '*')",
      );
    }
    // AUDIT_HMAC_SECRET is mandatory in prod: missing it would let
    // a DB-write attacker silently rewrite the audit chain. Dev /
    // test get a hardcoded dev secret with a warning, but prod has
    // no useful fallback (the attacker would just use the public
    // dev secret to rewrite).
    if (!env.AUDIT_HMAC_SECRET) {
      throw new Error(
        "Invalid environment: AUDIT_HMAC_SECRET (>=32 chars) is required in production for audit-log tamper-evidence",
      );
    }
  }
  return env;
}
