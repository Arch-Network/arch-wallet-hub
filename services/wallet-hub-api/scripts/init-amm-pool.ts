#!/usr/bin/env tsx
/**
 * Standalone testnet client: call `initialize_pool` on the deployed
 * arch-bitcoin-defi AMM program.
 *
 * This is a *direct* Arch transaction (the Wallet Hub has no initialize_pool
 * action). It proves the deployed AMM dispatches a real instruction on
 * testnet — declare_id match, account creation, and PDA seeds — with no
 * Bitcoin/rune assets required.
 *
 * Usage:
 *   AMM_PROGRAM_ID=<hex32> RUNE_BLOCK=840000 RUNE_TX=1 FEE_BPS=30 \
 *   tsx scripts/init-amm-pool.ts
 */
import {
  RpcConnection,
  PubkeyUtil,
  SanitizedMessageUtil,
  SignatureUtil,
} from "@arch-network/arch-sdk";
import { computeBip322ToSignTaprootSighash } from "../src/bitcoin/bip322.js";
import { sha256 } from "@noble/hashes/sha256";
import * as bitcoin from "bitcoinjs-lib";
import secp256k1 from "@bitcoinerlab/secp256k1";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

const require = createRequire(import.meta.url);
(bitcoin as any).initEccLib?.(secp256k1);

const ARCH_RPC =
  process.env.ARCH_RPC_NODE_URL_TESTNET || "https://rpc.testnet.arch.network";
const AMM_PROGRAM_ID =
  process.env.AMM_PROGRAM_ID ||
  "71264e673b944fed4878dca0152c16e082e51e938371cf9156c382f986ef1724";
const RUNE_BLOCK = BigInt(process.env.RUNE_BLOCK || "840000");
const RUNE_TX = Number(process.env.RUNE_TX || "1");
const FEE_BPS = Number(process.env.FEE_BPS || "30");
const SEED = process.env.LOCAL_SIGNER_SEED; // optional 32-byte hex

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toXOnly(pubkey: Buffer): Buffer {
  return pubkey.length === 33 ? pubkey.subarray(1, 33) : pubkey;
}
function getECPair() {
  const mod = require("ecpair");
  const factory = mod.ECPairFactory ?? mod.default;
  return factory(secp256k1);
}
function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff);
  return b;
}

async function main() {
  console.log("🏊 initialize_pool on AMM", AMM_PROGRAM_ID);
  console.log("   RPC:", ARCH_RPC);

  const network = bitcoin.networks.testnet;
  const ECPair = getECPair();
  const keyPair = SEED
    ? ECPair.fromPrivateKey(Buffer.from(SEED, "hex"), { network })
    : ECPair.makeRandom({ network });
  const compressed = Buffer.from(keyPair.publicKey);
  const internalXOnly = toXOnly(compressed);
  const taproot = bitcoin.payments.p2tr({ internalPubkey: internalXOnly, network });
  const taprootAddress = taproot.address!;
  const tweak = bitcoin.crypto.taggedHash("TapTweak", internalXOnly);
  const tweakedKeyPair = keyPair.tweak(tweak);

  const funder = new Uint8Array(internalXOnly); // 32-byte Arch identity
  console.log("   Funder taproot:", taprootAddress);

  const provider = new RpcConnection(ARCH_RPC);

  // 1. Fund the funder account so it can pay rent for the pool PDA.
  console.log("💧 Requesting airdrop for funder...");
  try {
    await provider.requestAirdrop(funder);
  } catch (e: any) {
    console.log("   airdrop call:", e?.message || e);
  }
  // Wait for the account to materialize + be system-owned.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const info = await provider.readAccountInfo(funder);
      if (info) {
        console.log("   funder account present (lamports:", (info as any).lamports, ")");
        break;
      }
    } catch {
      /* not yet */
    }
    if (i === 19) console.log("   (proceeding without confirmed funder account)");
  }

  // 2. Derive the pool PDA: seeds = [b"pool", block_le(8), tx_le(4)].
  const programId = hexToBytes(AMM_PROGRAM_ID);
  const seeds = [Buffer.from("pool"), u64le(RUNE_BLOCK), u32le(RUNE_TX)];
  const [pool, bump] = PubkeyUtil.findProgramAddress(seeds, programId);
  console.log("   Pool PDA:", Buffer.from(pool).toString("hex"), "bump", bump);

  // 3. Instruction data: sha256("global:initialize_pool")[:8] + borsh(rune_id, fee_bps)
  const disc = sha256(new TextEncoder().encode("global:initialize_pool")).slice(0, 8);
  const args = Buffer.concat([u64le(RUNE_BLOCK), u32le(RUNE_TX), u16le(FEE_BPS)]);
  const data = new Uint8Array(Buffer.concat([Buffer.from(disc), args]));

  const SYSTEM_PROGRAM = new Uint8Array(32);
  const ix = {
    program_id: programId,
    accounts: [
      { pubkey: pool, is_signer: false, is_writable: true },
      { pubkey: funder, is_signer: true, is_writable: true },
      { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
    ],
    data,
  };

  // 4. Recent blockhash.
  const bhHex = await provider.getBestBlockHash();
  const recentBlockhash = hexToBytes(bhHex);

  // 5. Compile + hash the message.
  const message = SanitizedMessageUtil.createSanitizedMessage(
    [ix as any],
    funder,
    recentBlockhash,
  );
  if (typeof message === "string") {
    throw new Error(`message compile failed: ${message}`);
  }
  const msgHash = SanitizedMessageUtil.hash(message as any); // utf8 bytes of 64-char hex

  // 6. BIP-322 sign the message hash with the tweaked taproot key.
  const sighash = computeBip322ToSignTaprootSighash({
    signerAddress: taprootAddress,
    message: Buffer.from(msgHash),
  });
  const sig = tweakedKeyPair.signSchnorr(sighash);
  const adjusted = SignatureUtil.adjustSignature(new Uint8Array(sig));

  const rtx = { version: 0, signatures: [adjusted], message };

  // 7. Submit.
  console.log("📤 Submitting initialize_pool...");
  const txid = await provider.sendTransaction(rtx as any);
  console.log("   txid:", txid);

  // 8. Confirm the pool account now exists.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const info = await provider.readAccountInfo(pool);
      if (info) {
        const owner = Buffer.from((info as any).owner ?? []).toString("hex");
        console.log("✅ Pool account created. owner:", owner);
        console.log("   data len:", (info as any).data?.length);
        return;
      }
    } catch {
      /* not yet */
    }
  }
  console.log("⚠️  Pool account not observed yet; check tx", txid);
}

main().catch((e) => {
  console.error("❌", e?.stack || e?.message || e);
  process.exit(1);
});
