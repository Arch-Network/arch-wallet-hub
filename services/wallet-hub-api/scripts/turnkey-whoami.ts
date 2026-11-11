/**
 * Does the hub's Turnkey API key belong to the hub's Turnkey organization?
 *
 *   cd services/wallet-hub-api && npx tsx scripts/turnkey-whoami.ts
 *
 * Reads TURNKEY_* from .env (or the environment), stamps a `whoami` and prints the answer. A
 * `PUBLIC_KEY_NOT_FOUND` here means the key was created in a different organization than
 * TURNKEY_ORGANIZATION_ID names — the dashboard shows each organization's id on its overview, and
 * an API key under Users → <user> → API keys of the organization it belongs to.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient } from "@turnkey/http";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
const org = process.env.TURNKEY_ORGANIZATION_ID ?? "";
const pub = process.env.TURNKEY_API_PUBLIC_KEY ?? "";
const priv = process.env.TURNKEY_API_PRIVATE_KEY ?? "";
if (!org || !pub || !priv) throw new Error("TURNKEY_ORGANIZATION_ID / TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY missing");

const client = new TurnkeyClient({ baseUrl: process.env.TURNKEY_BASE_URL ?? "https://api.turnkey.com" }, new ApiKeyStamper({ apiPublicKey: pub, apiPrivateKey: priv }));
console.log(`org ${org}\nkey ${pub}`);
try {
  const me = await client.getWhoami({ organizationId: org });
  console.log("OK:", me);
} catch (err) {
  console.error("Turnkey refused:", (err as Error).message);
  process.exit(1);
}
