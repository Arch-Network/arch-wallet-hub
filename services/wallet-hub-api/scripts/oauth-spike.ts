/**
 * Turnkey social-login spike: proves, against the sandbox, that a Google id
 * token can (1) create a sub-org whose root user is the OIDC identity,
 * (2) be found again by token, (3) open a session for a browser-style
 * P-256 key through OAUTH_LOGIN, and (4) that key can then sign a BIP-340
 * payload with the wallet -- i.e. "log in with Google and access the
 * account". No Hub, no DB: the Turnkey client alone.
 *
 * Usage:
 *   cd services/wallet-hub-api
 *   export TURNKEY_ORGANIZATION_ID=… TURNKEY_API_PUBLIC_KEY=… TURNKEY_API_PRIVATE_KEY=…
 *   npx tsx scripts/oauth-spike.ts keypair           # step 1: prints the session key + the nonce to request
 *   # get a Google id token with that nonce (scripts/oauth-token.html), then:
 *   npx tsx scripts/oauth-spike.ts run <idToken> [subOrgId]
 *
 * The keypair is written to .oauth-spike-key.json next to this script
 * (gitignored); `run` reads it so the nonce in the token matches. Pass an
 * existing subOrgId to skip creation and test sign-in alone.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient } from "@turnkey/http";
import { generateP256KeyPair } from "@turnkey/crypto";
import { TurnkeyService } from "../src/turnkey/client.js";
import { oauthNonceFor } from "../src/auth/oidc.js";
import { verifyChallengeSignature } from "../src/auth/sessionToken.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(here, ".oauth-spike-key.json");
const BASE_URL = process.env.TURNKEY_BASE_URL ?? "https://api.turnkey.com";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function keypair(): { publicKey: string; privateKey: string } {
  const kp = generateP256KeyPair();
  const out = { publicKey: kp.publicKey, privateKey: kp.privateKey };
  fs.writeFileSync(KEY_FILE, JSON.stringify(out, null, 2));
  console.log("Session public key (compressed P-256):", out.publicKey);
  console.log("Request your Google id token with nonce =", oauthNonceFor(out.publicKey));
  console.log(`Saved to ${KEY_FILE}`);
  return out;
}

async function run(idToken: string, existingSubOrg?: string) {
  const kp = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as { publicKey: string; privateKey: string };
  const expectedNonce = oauthNonceFor(kp.publicKey);
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  console.log("token:", { iss: payload.iss, aud: payload.aud, sub: payload.sub, email: payload.email, email_verified: payload.email_verified, nonce: payload.nonce });
  if (payload.nonce !== expectedNonce) {
    throw new Error(`nonce mismatch: token has ${String(payload.nonce)}, session key needs ${expectedNonce}. Run "keypair" and request a new token.`);
  }

  const service = new TurnkeyService({
    baseUrl: BASE_URL,
    organizationId: env("TURNKEY_ORGANIZATION_ID"),
    apiPublicKey: env("TURNKEY_API_PUBLIC_KEY"),
    apiPrivateKey: env("TURNKEY_API_PRIVATE_KEY"),
  });

  // 2. Lookup by token (expect [] before the first create).
  const before = await service.getSubOrgIdsByOidcToken({ oidcToken: idToken });
  console.log("getSubOrgIds(OIDC_TOKEN) before:", before);

  let subOrgId = existingSubOrg ?? before[0];
  if (!subOrgId) {
    // 1. Create the sub-org with the OIDC identity as its root user.
    const created = await service.createSubOrganizationWithOAuthWallet({
      subOrganizationName: `oauth-spike-${Date.now().toString(36)}`,
      rootUser: { userName: String(payload.email ?? payload.sub), ...(typeof payload.email === "string" ? { userEmail: payload.email } : {}) },
      provider: { providerName: "google", oidcToken: idToken },
      wallet: { walletName: "spike", addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR", path: "m/86'/1'/0'/0/0" },
    });
    console.log("created sub-org:", created);
    subOrgId = created.subOrganizationId;
    const after = await service.getSubOrgIdsByOidcToken({ oidcToken: idToken });
    console.log("getSubOrgIds(OIDC_TOKEN) after:", after);
  }

  // 3. OAUTH_LOGIN registers the session key (stamped by the parent key).
  const login = await service.oauthLogin({ organizationId: subOrgId, oidcToken: idToken, publicKey: kp.publicKey, expirationSeconds: "900" });
  console.log("oauthLogin:", { activityId: login.activityId, sessionJwt: login.session?.slice(0, 24) + "…" });

  // 4. Sign with the session key: a client-side stamper, nothing from the parent key.
  const client = new TurnkeyClient({ baseUrl: BASE_URL }, new ApiKeyStamper({ apiPublicKey: kp.publicKey, apiPrivateKey: kp.privateKey }));
  const { wallets } = await service.getWalletsForOrganization({ organizationId: subOrgId });
  const { accounts } = await service.getWalletAccountsForOrganization({ organizationId: subOrgId, walletId: wallets[0]!.walletId });
  const account = accounts.find((a) => a.address.startsWith("tb1p") || a.address.startsWith("bc1p")) ?? accounts[0]!;
  console.log("wallet account:", { address: account.address, publicKey: account.publicKey });

  const digest = "11".repeat(32);
  const res = await (client as any).signRawPayload({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(Date.now()),
    organizationId: subOrgId,
    parameters: { signWith: account.address, payload: digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" },
  });
  const result = res.activity?.result?.signRawPayloadResult;
  if (!result) throw new Error(`signRawPayload did not complete: ${JSON.stringify(res.activity?.status)}`);
  const sig = `${result.r}${result.s}`;
  // The same check the Hub's session mint applies: the internal key or its BIP-341 tweaked output key.
  const ok = verifyChallengeSignature({ payloadHex: digest, signatureHex: sig, defaultPublicKeyHex: account.publicKey ?? "" });
  console.log("schnorr signature:", sig.slice(0, 16) + "…", "verifies against wallet key:", ok);
  if (!ok) throw new Error("signature did not verify against the wallet's key");
  console.log("\nPASS: Google id token → sub-org → OAUTH_LOGIN → session key signs for the wallet.");
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "keypair") keypair();
else if (cmd === "run" && a) run(a, b).catch((e) => { console.error(e); process.exit(1); });
else { console.error("usage: oauth-spike.ts keypair | run <idToken> [subOrgId]"); process.exit(2); }
