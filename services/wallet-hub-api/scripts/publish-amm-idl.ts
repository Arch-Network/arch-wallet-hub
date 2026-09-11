#!/usr/bin/env tsx
/**
 * Publish a Satellite/Anchor IDL on-chain for an Arch program.
 *
 * The Satellite CLI's `idl init` is Solana-RPC only, so it can't talk to Arch.
 * But the deployed program embeds the standard (Arch-native) IDL instruction
 * handlers (`__idl_dispatch`), which create the canonical IDL account via a CPI
 * to the Arch system program. This script drives those handlers directly over
 * the Arch RPC, matching what `anchor idl init` does:
 *
 *   1. Create  { data_len }  -> allocates the canonical IDL account
 *   2. Write   { data }      -> appends zlib-compressed IDL JSON in chunks
 *
 * Canonical IDL account address (derived from the program id alone):
 *   base = find_program_address([], program_id)
 *   idl  = create_with_seed(base, "anchor:idl", program_id)
 *        = sha256(base || "anchor:idl" || program_id)
 *
 * Usage:
 *   AMM_PROGRAM_ID=<hex32> IDL_PATH=/abs/path/to/amm.json \
 *   tsx scripts/publish-amm-idl.ts
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
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
(bitcoin as any).initEccLib?.(secp256k1);

const ARCH_RPC =
  process.env.ARCH_RPC_NODE_URL_TESTNET || "https://rpc.testnet.arch.network";
const AMM_PROGRAM_ID =
  process.env.AMM_PROGRAM_ID ||
  "4443bfc2c2c09dca01814cde8ff723e9bef46b21ea1bde32fae8278c7a5cc698";
const IDL_PATH =
  process.env.IDL_PATH ||
  "/Users/brianhoffman/Projects/arch-bitcoin-defi/target/idl/amm.json";

// Sha256("anchor:idl")[..8], stored little-endian. See satellite lang/src/idl.rs.
const IDL_IX_TAG_LE = Buffer.from([
  0x40, 0xf4, 0xbc, 0x78, 0xa7, 0xe9, 0x69, 0x0a,
]);
const IDL_SEED = "anchor:idl";
const MAX_WRITE_SIZE = 600; // matches the CLI chunk size

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
  return (mod.ECPairFactory ?? mod.default)(secp256k1);
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

/** create_with_seed(base, seed, owner) = sha256(base || seed || owner). */
function createWithSeed(
  base: Uint8Array,
  seed: string,
  owner: Uint8Array,
): Uint8Array {
  return sha256(
    Buffer.concat([
      Buffer.from(base),
      Buffer.from(seed, "utf8"),
      Buffer.from(owner),
    ]),
  );
}

async function signSubmit(
  provider: any,
  ix: any,
  signer: Uint8Array,
  taprootAddress: string,
  tweakedKeyPair: any,
): Promise<string> {
  const recentBlockhash = hexToBytes(await provider.getBestBlockHash());
  const message = SanitizedMessageUtil.createSanitizedMessage(
    [ix],
    signer,
    recentBlockhash,
  );
  if (typeof message === "string") throw new Error(`compile failed: ${message}`);
  const msgHash = SanitizedMessageUtil.hash(message as any);
  const sighash = computeBip322ToSignTaprootSighash({
    signerAddress: taprootAddress,
    message: Buffer.from(msgHash),
  });
  const sig = tweakedKeyPair.signSchnorr(sighash);
  const adjusted = SignatureUtil.adjustSignature(new Uint8Array(sig));
  return provider.sendTransaction({
    version: 0,
    signatures: [adjusted],
    message,
  } as any);
}

async function waitProcessed(provider: any, txid: string, label: string) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const p: any = await provider.getProcessedTransaction(txid).catch(() => null);
    const st = p?.status?.type ?? p?.status;
    const norm = String(st).toLowerCase();
    if (norm === "processed") return;
    if (norm === "failed") {
      const logs = (p?.logs || p?.log_messages || []).join("\n     ");
      throw new Error(`${label} failed: ${p?.status?.message}\n     ${logs}`);
    }
  }
  throw new Error(`${label}: no terminal status for ${txid}`);
}

async function main() {
  const programId = hexToBytes(AMM_PROGRAM_ID);
  console.log("📦 publishing IDL for program", AMM_PROGRAM_ID);

  // Compress the IDL JSON (zlib), exactly like the CLI's serialize_idl.
  const json = readFileSync(IDL_PATH);
  const compressed = deflateSync(json);
  console.log(`   IDL json ${json.length}B -> zlib ${compressed.length}B`);

  // Derive the canonical IDL account address.
  const [base] = PubkeyUtil.findProgramAddress([], programId);
  const idlAddress = createWithSeed(base, IDL_SEED, programId);
  console.log("   base (program signer):", Buffer.from(base).toString("hex"));
  console.log("   idl account          :", Buffer.from(idlAddress).toString("hex"));

  const network = bitcoin.networks.testnet;
  const ECPair = getECPair();
  // Fixed seed so re-runs reuse the same authority (Write requires has_one).
  const seedHex =
    process.env.PAYER_SEED ||
    "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
  const keyPair = ECPair.fromPrivateKey(Buffer.from(seedHex, "hex"), { network });
  const compressedPub = Buffer.from(keyPair.publicKey);
  const internalXOnly = toXOnly(compressedPub);
  const taprootAddress = bitcoin.payments.p2tr({
    internalPubkey: internalXOnly,
    network,
  }).address!;
  const tweakedKeyPair = keyPair.tweak(
    bitcoin.crypto.taggedHash("TapTweak", internalXOnly),
  );
  const from = new Uint8Array(internalXOnly);
  console.log("   authority/payer      :", Buffer.from(from).toString("hex"));

  const provider = new RpcConnection(ARCH_RPC);

  console.log("💧 funding payer...");
  for (let r = 0; r < 5; r++) {
    try {
      await provider.requestAirdrop(from);
    } catch (e: any) {
      console.log("   airdrop:", e?.message || e);
    }
    await new Promise((r) => setTimeout(r, 2000));
    if (await provider.readAccountInfo(from).catch(() => null)) break;
  }

  const SYSTEM_PROGRAM = new Uint8Array(32);

  // Skip Create if the IDL account already exists (resume support).
  const existing = await provider.readAccountInfo(idlAddress).catch(() => null);
  if (!existing) {
    const dataLen = BigInt(compressed.length);
    const createData = new Uint8Array(
      Buffer.concat([IDL_IX_TAG_LE, Buffer.from([0x00]), u64le(dataLen)]),
    );
    const createIx = {
      program_id: programId,
      accounts: [
        { pubkey: from, is_signer: true, is_writable: true },
        { pubkey: idlAddress, is_signer: false, is_writable: true },
        { pubkey: base, is_signer: false, is_writable: false },
        { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
        { pubkey: programId, is_signer: false, is_writable: false },
      ],
      data: createData,
    };
    console.log("📤 Create { data_len:", compressed.length, "}");
    const txid = await signSubmit(provider, createIx, from, taprootAddress, tweakedKeyPair);
    console.log("   txid:", txid);
    await waitProcessed(provider, txid, "Create");
    console.log("   ✅ IDL account created");
  } else {
    console.log("   IDL account already exists; skipping Create");
  }

  // Write the compressed IDL in chunks.
  let offset = 0;
  while (offset < compressed.length) {
    const end = Math.min(offset + MAX_WRITE_SIZE, compressed.length);
    const chunk = compressed.subarray(offset, end);
    const writeData = new Uint8Array(
      Buffer.concat([
        IDL_IX_TAG_LE,
        Buffer.from([0x02]),
        u32le(chunk.length),
        chunk,
      ]),
    );
    const writeIx = {
      program_id: programId,
      accounts: [
        { pubkey: idlAddress, is_signer: false, is_writable: true },
        { pubkey: from, is_signer: true, is_writable: false },
      ],
      data: writeData,
    };
    process.stdout.write(`📝 Write ${offset}-${end}/${compressed.length} ... `);
    const txid = await signSubmit(provider, writeIx, from, taprootAddress, tweakedKeyPair);
    await waitProcessed(provider, txid, `Write@${offset}`);
    console.log("ok", txid.slice(0, 12));
    offset = end;
  }

  console.log("✅ IDL published.");
  console.log("   program id :", AMM_PROGRAM_ID);
  console.log("   idl account:", Buffer.from(idlAddress).toString("hex"));
}

main().catch((e) => {
  console.error("❌", e?.stack || e?.message || e);
  process.exit(1);
});
