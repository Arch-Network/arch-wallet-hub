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

  // Postgres
  DATABASE_URL: z.string().min(1),
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
  return parsed.data;
}
