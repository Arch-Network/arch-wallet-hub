#!/usr/bin/env tsx
/**
 * Test script for the arch.sign_message signing request flow.
 *
 * Exercises both paths:
 *   - passkey-style (user/client signs the BIP-322 sighash and POSTs /submit)
 *   - custodial (POST /sign-with-turnkey lets the Hub sign server-side for root-org wallets)
 *
 * Usage:
 *   WALLET_HUB_API_KEY=your-api-key WALLET_HUB_BASE_URL=http://localhost:3005 \
 *   TURNKEY_ORG_ID=... TURNKEY_API_PUBLIC_KEY=... TURNKEY_API_PRIVATE_KEY=... \
 *   RESOURCE_ID=... \
 *   MESSAGE="hello arch" \
 *   tsx scripts/test-sign-message.ts
 *
 * Or with a local (non-Turnkey) signer:
 *   LOCAL_SIGNER=1 MESSAGE="hello arch" \
 *   WALLET_HUB_API_KEY=your-api-key tsx scripts/test-sign-message.ts
 *
 * Use SERVER_SIGN=1 to exercise the custodial /sign-with-turnkey endpoint instead of
 * signing the payload locally/on-device.
 */

import { WalletHubClient } from "@arch-network/wallet-hub-sdk";
import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { Buffer } from "node:buffer";
import * as bitcoin from "bitcoinjs-lib";
import secp256k1 from "@bitcoinerlab/secp256k1";
import { createRequire } from "node:module";
import { schnorr } from "@noble/curves/secp256k1";
import { computeBip322ToSignTaprootSighash } from "../src/bitcoin/bip322.js";

const require = createRequire(import.meta.url);
(bitcoin as any).initEccLib?.(secp256k1);

const WALLET_HUB_BASE_URL = process.env.WALLET_HUB_BASE_URL || "http://localhost:3005";
const WALLET_HUB_API_KEY = process.env.WALLET_HUB_API_KEY;
const EXTERNAL_USER_ID = process.env.EXTERNAL_USER_ID || "test-user-1";
const RESOURCE_ID = process.env.RESOURCE_ID;
const LOCAL_SIGNER = process.env.LOCAL_SIGNER === "1";
const LOCAL_SIGNER_SEED = process.env.LOCAL_SIGNER_SEED;
const SERVER_SIGN = process.env.SERVER_SIGN === "1"; // use /sign-with-turnkey instead of manual submit
const MESSAGE = process.env.MESSAGE || "hello from test-sign-message";

const TURNKEY_ORG_ID = process.env.TURNKEY_ORG_ID;
const TURNKEY_API_PUBLIC_KEY = process.env.TURNKEY_API_PUBLIC_KEY;
const TURNKEY_API_PRIVATE_KEY = process.env.TURNKEY_API_PRIVATE_KEY;

if (!WALLET_HUB_API_KEY) {
  console.error("WALLET_HUB_API_KEY is required");
  process.exit(1);
}

const client = new WalletHubClient({
  baseUrl: WALLET_HUB_BASE_URL,
  apiKey: WALLET_HUB_API_KEY
});

function toXOnly(pubkey: Buffer): Buffer {
  if (pubkey.length === 33) return pubkey.subarray(1, 33);
  if (pubkey.length === 32) return pubkey;
  throw new Error(`Unexpected pubkey length: ${pubkey.length}`);
}

function getECPair() {
  const mod = require("ecpair");
  const factory = mod.ECPairFactory ?? mod.default;
  if (typeof factory !== "function") throw new Error("ecpair ECPairFactory export not found");
  return factory(secp256k1);
}

function taprootOutputXOnlyFromAddress(taprootAddress: string): Buffer {
  const decoded = (bitcoin as any).address.fromBech32(taprootAddress);
  if (decoded.version !== 1 || !decoded.data || decoded.data.length !== 32) {
    throw new Error(`Expected taproot bech32m v1 32-byte program, got version=${decoded.version}`);
  }
  return Buffer.from(decoded.data);
}

type LocalSigner = {
  signWith: string;
  tweakedPrivateKey: Buffer;
  publicKeyHex: string;
  internalXOnly: Buffer;
};

function buildLocalSigner(): LocalSigner {
  const ECPair = getECPair();
  const network = bitcoin.networks.testnet;

  const seed =
    LOCAL_SIGNER_SEED && /^[0-9a-fA-F]{64}$/.test(LOCAL_SIGNER_SEED)
      ? Buffer.from(LOCAL_SIGNER_SEED, "hex")
      : undefined;

  const keyPair = seed ? ECPair.fromPrivateKey(seed, { network }) : ECPair.makeRandom({ network });
  if (!keyPair.privateKey) throw new Error("Local keypair missing privateKey");

  const compressedPubkey = Buffer.from(keyPair.publicKey);
  const internalPubkey = toXOnly(compressedPubkey);
  const taprootPayment = bitcoin.payments.p2tr({ internalPubkey, network });
  if (!taprootPayment.address) throw new Error("Failed to derive taproot address");

  const tweak = bitcoin.crypto.taggedHash("TapTweak", internalPubkey);
  const tweakedKeyPair = keyPair.tweak(tweak);
  if (!tweakedKeyPair.privateKey) throw new Error("Tweaked keypair missing privateKey");

  return {
    signWith: taprootPayment.address,
    tweakedPrivateKey: Buffer.from(tweakedKeyPair.privateKey),
    publicKeyHex: compressedPubkey.toString("hex"),
    internalXOnly: internalPubkey
  };
}

async function main() {
  console.log("Testing arch.sign_message flow...\n");

  const messageBytes = Buffer.from(MESSAGE, "utf8");
  const messageHex = messageBytes.toString("hex");
  console.log(`Message (utf8): ${JSON.stringify(MESSAGE)}`);
  console.log(`Message (hex):  ${messageHex}\n`);

  let localSigner: LocalSigner | undefined;
  let signerArg:
    | { kind: "external"; taprootAddress: string; publicKeyHex: string }
    | { kind: "turnkey"; resourceId: string };

  if (LOCAL_SIGNER) {
    localSigner = buildLocalSigner();
    console.log(`External taproot address: ${localSigner.signWith}`);
    console.log(`Compressed pubkey: ${localSigner.publicKeyHex}\n`);
    signerArg = {
      kind: "external",
      taprootAddress: localSigner.signWith,
      publicKeyHex: localSigner.publicKeyHex
    };
  } else {
    if (!RESOURCE_ID) {
      console.error("RESOURCE_ID is required when LOCAL_SIGNER is not set.");
      process.exit(1);
    }
    signerArg = { kind: "turnkey", resourceId: RESOURCE_ID };
    console.log(`Turnkey resourceId: ${RESOURCE_ID}\n`);
  }

  console.log("Step 1: Creating signing request (arch.sign_message)...");
  const signingRequest: any = await client.createSigningRequest({
    externalUserId: EXTERNAL_USER_ID,
    signer: signerArg as any,
    action: { type: "arch.sign_message", messageHex }
  });
  console.log(`  id: ${signingRequest.signingRequestId}`);
  console.log(`  status: ${signingRequest.status}`);
  console.log(`  actionType: ${signingRequest.actionType}`);

  const payloadToSign = signingRequest.payloadToSign;
  if (!payloadToSign || payloadToSign.kind !== "taproot_sighash_hex") {
    throw new Error(`Unexpected payload kind: ${payloadToSign?.kind}`);
  }
  const signWith: string = payloadToSign.signWith;
  const payloadHex: string = payloadToSign.payloadHex;
  console.log(`  signWith: ${signWith}`);
  console.log(`  payloadHex: ${payloadHex}\n`);

  console.log("Step 2: Recomputing BIP-322 taproot sighash locally and comparing...");
  const localSighash = computeBip322ToSignTaprootSighash({
    signerAddress: signWith,
    message: messageBytes
  });
  const localSighashHex = Buffer.from(localSighash).toString("hex");
  if (localSighashHex !== payloadHex) {
    throw new Error(
      `BIP-322 sighash mismatch:\n  hub returned: ${payloadHex}\n  local compute: ${localSighashHex}`
    );
  }
  console.log("  Match.\n");

  let submitResult: any;

  if (SERVER_SIGN) {
    console.log("Step 3: Invoking /sign-with-turnkey (custodial path)...");
    submitResult = await (client as any).signWithTurnkey(signingRequest.signingRequestId, {
      externalUserId: EXTERNAL_USER_ID
    });
  } else {
    console.log("Step 3: Signing payload...");
    let signature64Hex: string;
    let activityId: string | undefined;

    if (LOCAL_SIGNER) {
      if (!localSigner) throw new Error("LOCAL_SIGNER enabled but localSigner not initialized");
      const digest = Buffer.from(payloadHex, "hex");
      const sig = secp256k1.signSchnorr(digest, localSigner.tweakedPrivateKey);
      signature64Hex = Buffer.from(sig).toString("hex");
      console.log(`  signature (local): ${signature64Hex.slice(0, 32)}...${signature64Hex.slice(32)}`);
    } else {
      if (!TURNKEY_ORG_ID || !TURNKEY_API_PUBLIC_KEY || !TURNKEY_API_PRIVATE_KEY) {
        console.error("TURNKEY_ORG_ID / TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY required when not using LOCAL_SIGNER or SERVER_SIGN.");
        process.exit(1);
      }
      const stamper = new ApiKeyStamper({
        apiPublicKey: TURNKEY_API_PUBLIC_KEY!,
        apiPrivateKey: TURNKEY_API_PRIVATE_KEY!
      });
      const turnkey = new TurnkeyClient({ baseUrl: "https://api.turnkey.com" }, stamper);

      // If the wallet lives in a sub-org we must address that org. For simplicity we let
      // the Hub resolve that on the custodial path; here we assume root-org signing.
      const orgId = TURNKEY_ORG_ID!;
      const signResponse = await turnkey.signRawPayload({
        type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        timestampMs: Date.now().toString(),
        organizationId: orgId,
        parameters: {
          signWith,
          payload: payloadHex,
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP"
        }
      });
      let activity = signResponse.activity;
      activityId = activity.id;
      while (
        activity.status === "ACTIVITY_STATUS_PENDING" ||
        activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED"
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        const got = await turnkey.getActivity({ organizationId: orgId, activityId });
        activity = got.activity;
      }
      if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
        throw new Error(`Turnkey signing failed: ${activity.status}`);
      }
      const res = activity.result?.signRawPayloadResult;
      if (!res) throw new Error("Turnkey activity has no signRawPayloadResult");
      signature64Hex = `${res.r}${res.s}`;
      console.log(`  signature (turnkey): ${signature64Hex.slice(0, 32)}...${signature64Hex.slice(32)}`);
    }

    console.log("Step 4: Submitting signature...");
    submitResult = await client.submitSigningRequest(signingRequest.signingRequestId, {
      externalUserId: EXTERNAL_USER_ID,
      signature64Hex,
      turnkeyActivityId: activityId
    });
  }

  console.log(`  submitResult: ${JSON.stringify(submitResult, null, 2)}\n`);

  if (submitResult.status !== "succeeded") {
    throw new Error(`Expected status=succeeded, got ${submitResult.status}`);
  }

  const finalSig: string = submitResult.result?.signature64Hex;
  if (!finalSig || finalSig.length !== 128) {
    throw new Error(`Expected 64-byte signature (128 hex chars) in result.signature64Hex`);
  }

  console.log("Step 5: Verifying returned signature against BIP-322 Taproot output key...");
  const outputKey = taprootOutputXOnlyFromAddress(signWith);
  const ok = schnorr.verify(Buffer.from(finalSig, "hex"), Buffer.from(payloadHex, "hex"), outputKey);
  if (!ok) {
    throw new Error(
      "BIP-322 verification failed: signature did not verify against the Taproot output key"
    );
  }
  console.log("  Verified.\n");

  console.log("arch.sign_message flow passed.");
}

main().catch((err) => {
  console.error("\nTest failed:", err);
  if (err?.response) {
    console.error("Response:", JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
