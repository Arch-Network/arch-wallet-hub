#!/usr/bin/env tsx
/**
 * Test script for signing request flow (programmatic testing).
 * 
 * Usage:
 *   WALLET_HUB_API_KEY=your-api-key WALLET_HUB_BASE_URL=http://localhost:3005 \
 *   TURNKEY_ORG_ID=... TURNKEY_API_PUBLIC_KEY=... TURNKEY_API_PRIVATE_KEY=... \
 *   tsx scripts/test-signing-request.ts
 */

import { WalletHubClient } from "@arch/wallet-hub-sdk";
import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { Buffer } from "node:buffer";
import * as bitcoin from "bitcoinjs-lib";
import secp256k1 from "@bitcoinerlab/secp256k1";
import { createRequire } from "node:module";
import { secp256k1 as nobleSecp256k1 } from "@noble/curves/secp256k1";

const require = createRequire(import.meta.url);
const bs58mod = require("bs58");
const bs58Encode: (b: Uint8Array) => string =
  (bs58mod && (bs58mod.encode as any)) || (bs58mod?.default?.encode as any);
if (typeof bs58Encode !== "function") {
  throw new Error("Failed to load bs58.encode");
}

// bitcoinjs-lib v6 requires initializing an ECC lib for taproot operations (p2tr, tweaks, etc).
// bip322-js does this internally; our script uses bitcoinjs-lib directly, so we do it here too.
(bitcoin as any).initEccLib?.(secp256k1);

const WALLET_HUB_BASE_URL = process.env.WALLET_HUB_BASE_URL || "http://localhost:3005";
const WALLET_HUB_API_KEY = process.env.WALLET_HUB_API_KEY;
const EXTERNAL_USER_ID = process.env.EXTERNAL_USER_ID || "test-user-1";
const RESOURCE_ID = process.env.RESOURCE_ID; // Optional: use existing wallet resourceId
const SIGNING_REQUEST_ID = process.env.SIGNING_REQUEST_ID; // Optional: use existing signing request ID
const LOCAL_SIGNER = process.env.LOCAL_SIGNER === "1"; // If true, do NOT use Turnkey; sign locally (for debugging)
const LOCAL_SIGNER_SEED = process.env.LOCAL_SIGNER_SEED; // Optional hex seed (32 bytes) to make local signer deterministic
const LOCAL_SIGNER_DO_AIRDROP = process.env.LOCAL_SIGNER_DO_AIRDROP !== "0"; // default true

// Turnkey credentials (for passkey wallet signing)
const TURNKEY_ORG_ID = process.env.TURNKEY_ORG_ID;
const TURNKEY_API_PUBLIC_KEY = process.env.TURNKEY_API_PUBLIC_KEY;
const TURNKEY_API_PRIVATE_KEY = process.env.TURNKEY_API_PRIVATE_KEY;

if (!WALLET_HUB_API_KEY) {
  console.error("❌ WALLET_HUB_API_KEY is required");
  process.exit(1);
}

const client = new WalletHubClient({
  baseUrl: WALLET_HUB_BASE_URL,
  apiKey: WALLET_HUB_API_KEY
});

function toXOnly(pubkey: Buffer): Buffer {
  // bitcoinjs-lib uses 33-byte compressed pubkeys; taproot internal key is x-only (32 bytes)
  if (pubkey.length === 33) return pubkey.subarray(1, 33);
  if (pubkey.length === 32) return pubkey;
  throw new Error(`Unexpected pubkey length: ${pubkey.length}`);
}

function getECPair() {
  // Use CJS require to avoid ESM interop edge-cases when running under tsx.
  const mod = require("ecpair");
  const factory = mod.ECPairFactory ?? mod.default;
  if (typeof factory !== "function") throw new Error("ecpair ECPairFactory export not found");
  return factory(secp256k1);
}

function taprootToArchAccountBase58(taprootAddress: string): string {
  const decoded = (bitcoin as any).address.fromBech32(taprootAddress);
  if (decoded.version !== 1 || !decoded.data || decoded.data.length !== 32) {
    throw new Error(`Expected taproot bech32m v1 32-byte program, got version=${decoded.version} len=${decoded.data?.length ?? "?"}`);
  }
  return bs58Encode(decoded.data);
}

function secp256k1PublicKeyHexToArchAccountBase58(publicKeyHex: string): string {
  const pt = nobleSecp256k1.ProjectivePoint.fromHex(publicKeyHex).toAffine();
  const xHex = pt.x.toString(16).padStart(64, "0");
  return bs58Encode(Buffer.from(xHex, "hex"));
}

async function main() {
  console.log("🧪 Testing signing request flow...\n");

  try {
    let signingRequest: any;
    let walletOrgId: string | undefined = TURNKEY_ORG_ID; // Default to parent org
    let localSigner:
      | { signWith: string; tweakedPrivateKey: Buffer; publicKeyHex: string; internalXOnly: Buffer }
      | undefined;
    
    // If we have an existing signing request ID, use it directly
    if (SIGNING_REQUEST_ID) {
      console.log(`📋 Step 1: Using existing signing request: ${SIGNING_REQUEST_ID}`);
      signingRequest = await client.getSigningRequest(SIGNING_REQUEST_ID);
      console.log(`   Status: ${signingRequest.status}`);
      console.log(`   Action: ${signingRequest.actionType}\n`);
    } else {
      // Step 1: Get wallet info (use provided resourceId or find existing)
      let resourceId: string;
      let walletAddress: string | undefined;
      let signerKind: "turnkey" | "external" = "turnkey";
      let externalTaprootAddress: string | undefined;
      
      if (LOCAL_SIGNER) {
        signerKind = "external";
        console.log("📋 Step 1: LOCAL_SIGNER=1 enabled. Creating an external signer keypair...");

        const ECPair = getECPair();
        const network = bitcoin.networks.testnet; // match tb1p... usage

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

        // Tweak private key for key-path signing (matches bip322-js Signer behavior)
        const tweak = bitcoin.crypto.taggedHash("TapTweak", internalPubkey);
        const tweakedKeyPair = keyPair.tweak(tweak);
        if (!tweakedKeyPair.privateKey) throw new Error("Tweaked keypair missing privateKey");

        externalTaprootAddress = taprootPayment.address;
        localSigner = {
          signWith: externalTaprootAddress,
          tweakedPrivateKey: Buffer.from(tweakedKeyPair.privateKey),
          publicKeyHex: compressedPubkey.toString("hex"),
          internalXOnly: internalPubkey
        };

        console.log(`   External Taproot address: ${externalTaprootAddress}`);
        console.log(`   Compressed pubkey: ${localSigner.publicKeyHex}`);
        const archAccountAddress = bs58Encode(localSigner.internalXOnly);
        console.log(`   Arch account (base58, internal x-only): ${archAccountAddress}`);

        // Optional: try to airdrop to the corresponding Arch account so tx can progress past fee checks.
        if (LOCAL_SIGNER_DO_AIRDROP) {
          try {
            console.log("   Requesting airdrop (dev helper)...");
            const res = await client.airdropArchAccount({ archAccountAddress, lamports: "10000000" });
            console.log(`   ✅ Airdrop result: ${JSON.stringify(res.result)}`);
          } catch (err: any) {
            console.warn(`   ⚠️  Airdrop failed (continuing anyway): ${String(err?.message ?? err)}`);
          }
        }
      }

      if (signerKind === "external") {
        // We don't need any Turnkey wallet; create signing request with external signer.
        if (!externalTaprootAddress) throw new Error("Missing externalTaprootAddress for LOCAL_SIGNER");

        console.log(`📋 Step 1: Using external signer taprootAddress: ${externalTaprootAddress}`);

        console.log("📝 Step 2: Creating signing request...");
        signingRequest = await client.createSigningRequest({
          externalUserId: EXTERNAL_USER_ID,
          signer: {
            kind: "external",
            taprootAddress: externalTaprootAddress,
            publicKeyHex: localSigner!.publicKeyHex
          } as any,
          action: {
            type: "arch.transfer",
            toAddress: "6Ye9yqsktBMcRtuZxMaKxaPuTxFsWsLzrgjVobML2vnt",
            lamports: "1"
          }
        });

        console.log(`   ✅ Created signing request: ${signingRequest.signingRequestId}`);
        console.log(`   Status: ${signingRequest.status}`);
      } else {
      if (RESOURCE_ID) {
        console.log(`📋 Step 1: Using provided resourceId: ${RESOURCE_ID}`);
        resourceId = RESOURCE_ID;
        // Try to get wallet info, but don't fail if not found (API will validate)
        try {
          const walletsResponse: any = await client.listTurnkeyWallets(EXTERNAL_USER_ID);
          const wallets = walletsResponse.wallets || [];
          const wallet = wallets.find((w: any) => w.id === RESOURCE_ID || w.resourceId === RESOURCE_ID);
          if (wallet) {
            walletAddress = wallet.defaultAddress;
            walletOrgId = wallet.organizationId;
            console.log(`   Found wallet, address: ${walletAddress}`);
          } else {
            console.log(`   Wallet not found in list (will be validated by API)`);
          }
        } catch (err: any) {
          console.log(`   Could not list wallets: ${err.message}`);
        }
      } else {
        console.log("📋 Step 1: Listing wallets...");
        const walletsResponse: any = await client.listTurnkeyWallets(EXTERNAL_USER_ID);
        const wallets = walletsResponse.wallets || [];
        console.log(`   Found ${wallets.length} wallet(s)`);

        // Prefer a wallet in the same organization as the API key (parent org) so this script
        // can sign with the Turnkey API key. Sub-org (passkey) wallets require passkey signing.
        const preferredWallet =
          (TURNKEY_ORG_ID ? wallets.find((w: any) => w.organizationId === TURNKEY_ORG_ID) : null) ??
          wallets[0] ??
          null;

        if (!preferredWallet) {
          if (RESOURCE_ID) {
            console.log(`   No wallets found, but RESOURCE_ID provided: ${RESOURCE_ID}`);
            console.log(`   Will try to use it (API will validate if it belongs to this app)`);
            resourceId = RESOURCE_ID;
          } else {
            console.log("   No wallets found. Creating a new wallet for this test...");
            try {
              const walletResponse: any = await client.createTurnkeyWallet({
                idempotencyKey: `test-wallet-${Date.now()}`,
                body: {
                  externalUserId: EXTERNAL_USER_ID,
                  walletName: "Test Wallet",
                  addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR",
                  // NOTE: SDK types may differ across versions; keep script permissive.
                  derivationPath: "m/86'/1'/0'/0/0"
                } as any
              } as any);
              resourceId = walletResponse.resourceId || walletResponse.id;
              walletAddress = walletResponse.defaultAddress;
              walletOrgId = walletResponse.organizationId;
              console.log(`   ✅ Created wallet: ${resourceId}`);
              console.log(`   Taproot address: ${walletAddress}\n`);
            } catch (err: any) {
              console.error(`   ❌ Failed to create wallet: ${err.message}`);
              console.error("   Please create a wallet manually or provide RESOURCE_ID");
              process.exit(1);
            }
          }
        } else {
          const wallet = preferredWallet;
          resourceId = wallet.id || wallet.resourceId;
          walletAddress = wallet.defaultAddress;
          walletOrgId = wallet.organizationId;
          console.log(`   Using wallet: ${resourceId}`);
          console.log(`   OrganizationId: ${walletOrgId}`);
          console.log(`   Taproot address: ${walletAddress}\n`);
          if (TURNKEY_ORG_ID && walletOrgId && walletOrgId !== TURNKEY_ORG_ID) {
            console.warn(
              `   ⚠️  Selected wallet is in sub-organization ${walletOrgId}. This script uses API-key signing and may fail.\n` +
              `      Prefer a wallet with organizationId=${TURNKEY_ORG_ID} or use the demo dapp passkey signer.`
            );
          }
        }
      }
      
      if (!resourceId) {
        console.error("❌ No resourceId available");
        process.exit(1);
      }
      
      console.log(`   Resource ID: ${resourceId}\n`);

      // Best-effort: ensure the Arch account exists (airdrop) using the wallet's public key when available.
      try {
        const walletMeta: any = await client.getTurnkeyWallet({ resourceId, externalUserId: EXTERNAL_USER_ID });
        const defaultPubkeyHex: string | null = walletMeta?.defaultPublicKeyHex ?? null;
        const archAccountAddress =
          defaultPubkeyHex && typeof defaultPubkeyHex === "string" && defaultPubkeyHex.length >= 64
            ? secp256k1PublicKeyHexToArchAccountBase58(defaultPubkeyHex)
            : (walletMeta?.defaultAddress ? taprootToArchAccountBase58(String(walletMeta.defaultAddress)) : null);
        if (archAccountAddress) {
          console.log(`   Arch account (airdrop): ${archAccountAddress}`);
          await client.airdropArchAccount({ archAccountAddress, lamports: "10000000" });
          console.log("   ✅ Airdrop requested");
          // Give the validator a moment to materialize the account before we create/submit.
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          console.log("   (Skipping airdrop: could not derive archAccountAddress)");
        }
      } catch (e: any) {
        console.warn(`   ⚠️  Airdrop step failed (continuing): ${String(e?.message ?? e)}`);
      }

      // Step 2: Create a signing request
      console.log("📝 Step 2: Creating signing request...");
      signingRequest = await client.createSigningRequest({
        externalUserId: EXTERNAL_USER_ID,
        signer: {
          kind: "turnkey",
          resourceId: resourceId
        },
        action: {
          type: "arch.transfer",
          toAddress: "6Ye9yqsktBMcRtuZxMaKxaPuTxFsWsLzrgjVobML2vnt", // Test recipient
          lamports: "1"
        }
      });

      console.log(`   ✅ Created signing request: ${signingRequest.signingRequestId}`);
      console.log(`   Status: ${signingRequest.status}`);
      }
    }
    
    console.log(`   Payload to sign: ${JSON.stringify(signingRequest.payloadToSign, null, 2)}\n`);

    // Step 3: Get readiness status (if we created a new request, we already have it)
    let status: any;
    if (!SIGNING_REQUEST_ID) {
      console.log("🔍 Step 3: Checking readiness...");
      status = await client.getSigningRequest(signingRequest.signingRequestId);
      console.log(`   Readiness: ${JSON.stringify(status.readiness, null, 2)}\n`);
    } else {
      console.log("🔍 Step 3: Readiness check (skipped - using existing request)\n");
    }

    if (status && status.readiness && status.readiness.status === "not_ready") {
      console.log(`   ⚠️  Request is not ready: ${status.readiness.reason}`);
      console.log("   Continuing anyway for testing...\n");
    }

    // Step 4: Sign the payload
    if (LOCAL_SIGNER) {
      console.log("✍️  Step 4: Signing payload locally (LOCAL_SIGNER=1)...");
    } else {
      console.log("✍️  Step 4: Signing payload with Turnkey...");
    }
    
    // Get payload from signing request (might need to fetch if using existing ID)
    let payloadToSign: any;
    if (SIGNING_REQUEST_ID && !signingRequest.payloadToSign) {
      const fullRequest = await client.getSigningRequest(SIGNING_REQUEST_ID);
      payloadToSign = fullRequest.payloadToSign;
    } else {
      payloadToSign = signingRequest.payloadToSign;
    }
    
    if (!payloadToSign || payloadToSign.kind !== "taproot_sighash_hex") {
      throw new Error(`Unexpected payload kind: ${payloadToSign?.kind ?? "undefined"}`);
    }

    const signWith = payloadToSign.signWith;
    const payloadHex = payloadToSign.payloadHex;

    console.log(`   Signing with: ${signWith}`);
    console.log(`   Payload (hex): ${payloadHex}`);

    let signature64Hex: string;
    let activityId: string | undefined = undefined;

    if (LOCAL_SIGNER) {
      // Local signing path: schnorr-sign the provided payloadHex digest with a tweaked Taproot key.
      // This mimics bip322-js Signer behavior (tweak with TapTweak(internalPubkey) then sign).
      if (!localSigner) throw new Error("LOCAL_SIGNER enabled but localSigner was not initialized");
      if (signWith !== localSigner.signWith) {
        throw new Error(`LOCAL_SIGNER signWith mismatch: payload asks for ${signWith} but local signer is ${localSigner.signWith}`);
      }

      const digest = Buffer.from(payloadHex, "hex");
      if (digest.length !== 32) throw new Error(`Expected 32-byte payload digest, got ${digest.length}`);
      const sig = secp256k1.signSchnorr(digest, localSigner.tweakedPrivateKey);
      signature64Hex = Buffer.from(sig).toString("hex");
      console.log(`   ✅ Signature (local): ${signature64Hex.substring(0, 32)}...${signature64Hex.substring(32)}`);
      console.log(`   Note: LOCAL_SIGNER uses a fresh keypair each run unless LOCAL_SIGNER_SEED is set.\n`);
    } else {
      if (!TURNKEY_ORG_ID || !TURNKEY_API_PUBLIC_KEY || !TURNKEY_API_PRIVATE_KEY) {
        console.error("❌ Turnkey credentials not provided. Cannot sign.");
        console.error("   Set TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY");
        process.exit(1);
      }

      const stamper = new ApiKeyStamper({
        apiPublicKey: TURNKEY_API_PUBLIC_KEY,
        apiPrivateKey: TURNKEY_API_PRIVATE_KEY
      });

      const turnkeyClient = new TurnkeyClient(
        { baseUrl: "https://api.turnkey.com" },
        stamper
      );

      // Sign using Turnkey's signRawPayload
      const orgId = walletOrgId || TURNKEY_ORG_ID;
      const signResponse = await turnkeyClient.signRawPayload({
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

      // Poll for activity completion
      let activity = signResponse.activity;
      activityId = activity.id;
      console.log(`   Activity ID: ${activityId}`);
      
      // Poll until completed (simplified - in production you'd want timeout/retry logic)
      while (activity.status === "ACTIVITY_STATUS_PENDING" || activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const getActivityResponse = await turnkeyClient.getActivity({
          organizationId: orgId,
          activityId
        });
        activity = getActivityResponse.activity;
      }

      if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
        throw new Error(`Signing failed: ${activity.status} - ${JSON.stringify(activity)}`);
      }

      const signResult = activity.result?.signRawPayloadResult;
      if (!signResult) {
        throw new Error(`Signing failed: no result - ${JSON.stringify(activity)}`);
      }
      
      const signature = `${signResult.r}${signResult.s}`;
      signature64Hex = Buffer.from(signature, "hex").toString("hex");
      console.log(`   ✅ Signature: ${signature64Hex.substring(0, 32)}...${signature64Hex.substring(32)}`);
      console.log(`   Turnkey Activity ID: ${activityId}\n`);
    }

    // Step 5: Submit the signature
    console.log("📤 Step 5: Submitting signature...");
    const requestId = SIGNING_REQUEST_ID || signingRequest.signingRequestId;
    const submitResult: any = await client.submitSigningRequest(requestId, {
      externalUserId: EXTERNAL_USER_ID,
      signature64Hex,
      turnkeyActivityId: activityId
    });

    console.log(`   ✅ Result: ${JSON.stringify(submitResult, null, 2)}\n`);

    if (submitResult.status === "succeeded" && submitResult.result?.txid) {
      console.log(`   🎉 Transaction submitted successfully!`);
      console.log(`   TXID: ${submitResult.result.txid}\n`);
    } else if (submitResult.status === "failed") {
      console.error(`   ❌ Transaction failed: ${JSON.stringify(submitResult.error ?? submitResult, null, 2)}\n`);
      process.exit(1);
    }

    console.log("✅ All tests passed!");

  } catch (error: any) {
    console.error("\n❌ Test failed:");
    console.error(error);
    if (error.response) {
      console.error("Response:", JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
