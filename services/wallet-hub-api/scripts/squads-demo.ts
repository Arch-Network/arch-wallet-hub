#!/usr/bin/env tsx
/**
 * End-to-end Squads V4 (ported to Arch) demo on Arch testnet.
 *
 *   tx #1: program_config_init  (signed by the controlled INITIALIZER key)
 *   tx #2: multisig_create_v2   (signed by creator + ephemeral create_key)
 *
 * Tx building + secp256k1 BIP322/taproot signing modeled on publish-amm-idl.ts.
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
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
(bitcoin as any).initEccLib?.(secp256k1);

const ARCH_RPC =
  process.env.ARCH_RPC_NODE_URL_TESTNET || "https://rpc.testnet.arch.network";
const PROGRAM_ID_HEX =
  process.env.SQUADS_PROGRAM_ID ||
  "60ecce876888d47a7b6809e1e8ecc8e7afb11fd0aa741ea368a7128ffc18598e";
const INITIALIZER_SEED =
  process.env.INITIALIZER_SEED ||
  "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

const SEED_PREFIX = Buffer.from("multisig", "utf8");
const SEED_PROGRAM_CONFIG = Buffer.from("program_config", "utf8");
const SEED_MULTISIG = Buffer.from("multisig", "utf8");
const SYSTEM_PROGRAM = new Uint8Array(32);

// ---------- helpers ----------
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function toXOnly(pubkey: Buffer): Buffer {
  return pubkey.length === 33 ? pubkey.subarray(1, 33) : pubkey;
}
function getECPair() {
  const mod = require("ecpair");
  return (mod.ECPairFactory ?? mod.default)(secp256k1);
}
function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function discriminator(name: string): Buffer {
  return Buffer.from(sha256(Buffer.from(`global:${name}`, "utf8"))).subarray(0, 8);
}

const ECPair = getECPair();
const network = bitcoin.networks.testnet;

interface Signer {
  xonly: Uint8Array; // 32-byte Arch pubkey
  taprootAddress: string;
  tweaked: any;
}
function makeSigner(seed32: Uint8Array): Signer {
  const keyPair = ECPair.fromPrivateKey(Buffer.from(seed32), { network });
  const compressedPub = Buffer.from(keyPair.publicKey);
  const internalXOnly = toXOnly(compressedPub);
  const taprootAddress = bitcoin.payments.p2tr({
    internalPubkey: internalXOnly,
    network,
  }).address!;
  const tweaked = keyPair.tweak(
    bitcoin.crypto.taggedHash("TapTweak", internalXOnly),
  );
  return { xonly: new Uint8Array(internalXOnly), taprootAddress, tweaked };
}

async function signSubmit(
  provider: any,
  ix: any,
  payer: Uint8Array,
  signers: Signer[],
): Promise<string> {
  const recentBlockhash = hexToBytes(await provider.getBestBlockHash());
  const message = SanitizedMessageUtil.createSanitizedMessage(
    [ix],
    payer,
    recentBlockhash,
  );
  if (typeof message === "string")
    throw new Error(`compile failed: ${message}`);
  const msg = message as any;
  const msgHash = SanitizedMessageUtil.hash(msg);
  const numSigners: number = msg.header.num_required_signatures;

  // signatures map 1:1 to the first `num_required_signatures` account_keys.
  const byKey = new Map<string, Signer>();
  for (const s of signers) byKey.set(hex(s.xonly), s);

  const signatures: Uint8Array[] = [];
  for (let i = 0; i < numSigners; i++) {
    const keyHex = hex(msg.account_keys[i]);
    const signer = byKey.get(keyHex);
    if (!signer)
      throw new Error(`no signer for required account_keys[${i}] = ${keyHex}`);
    const sighash = computeBip322ToSignTaprootSighash({
      signerAddress: signer.taprootAddress,
      message: Buffer.from(msgHash),
    });
    const sig = signer.tweaked.signSchnorr(sighash);
    signatures.push(SignatureUtil.adjustSignature(new Uint8Array(sig)));
  }

  return provider.sendTransaction({
    version: 0,
    signatures,
    message: msg,
  } as any);
}

async function waitProcessed(provider: any, txid: string, label: string) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const p: any = await provider
      .getProcessedTransaction(txid)
      .catch(() => null);
    const st = p?.status?.type ?? p?.status;
    const norm = String(st).toLowerCase();
    if (norm === "processed") return p;
    if (norm === "failed") {
      const logs = (p?.logs || p?.log_messages || []).join("\n     ");
      throw new Error(`${label} FAILED: ${p?.status?.message}\n     ${logs}`);
    }
  }
  throw new Error(`${label}: no terminal status for ${txid}`);
}

async function fund(provider: any, who: Uint8Array, label: string) {
  for (let r = 0; r < 8; r++) {
    try {
      await provider.requestAirdrop(who);
    } catch (e: any) {
      console.log(`   airdrop(${label}):`, e?.message || e);
    }
    await new Promise((r) => setTimeout(r, 2000));
    if (await provider.readAccountInfo(who).catch(() => null)) return;
  }
}

async function main() {
  const programId = hexToBytes(PROGRAM_ID_HEX);
  const provider = new RpcConnection(ARCH_RPC);

  const initializer = makeSigner(hexToBytes(INITIALIZER_SEED));
  console.log("program id   :", PROGRAM_ID_HEX);
  console.log("INITIALIZER  :", hex(initializer.xonly), `(seed ${INITIALIZER_SEED})`);

  // ----- PDAs -----
  const [programConfig] = PubkeyUtil.findProgramAddress(
    [SEED_PREFIX, SEED_PROGRAM_CONFIG],
    programId,
  );
  console.log("program_config PDA:", hex(programConfig));

  // ----- discriminators -----
  const dPci = discriminator("program_config_init");
  const dMc2 = discriminator("multisig_create_v2");
  const IDL_PCI = Buffer.from([184, 188, 198, 195, 205, 124, 117, 216]);
  const IDL_MC2 = Buffer.from([50, 221, 199, 93, 40, 245, 139, 233]);
  console.log("disc program_config_init:", [...dPci], "idl match:", dPci.equals(IDL_PCI));
  console.log("disc multisig_create_v2 :", [...dMc2], "idl match:", dMc2.equals(IDL_MC2));

  console.log("\n💧 funding initializer/creator...");
  await fund(provider, initializer.xonly, "initializer");

  // ============ TX #1: program_config_init ============
  const treasury = initializer.xonly; // controlled
  const authority = initializer.xonly; // controlled
  const pciArgs = Buffer.concat([
    Buffer.from(authority), // authority: Pubkey
    u64le(0n), // multisig_creation_fee = 0
    Buffer.from(treasury), // treasury: Pubkey
  ]);
  const pciData = new Uint8Array(Buffer.concat([dPci, pciArgs]));

  const existingPc = await provider.readAccountInfo(programConfig).catch(() => null);
  if (existingPc) {
    console.log("\n⏭️  program_config already exists; skipping tx#1");
  } else {
    const pciIx = {
      program_id: programId,
      accounts: [
        { pubkey: programConfig, is_signer: false, is_writable: true },
        { pubkey: initializer.xonly, is_signer: true, is_writable: true },
        { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
      ],
      data: pciData,
    };
    console.log("\n📤 TX#1 program_config_init ...");
    const txid1 = await signSubmit(provider, pciIx, initializer.xonly, [initializer]);
    console.log("   txid:", txid1);
    await waitProcessed(provider, txid1, "program_config_init");
    console.log("   ✅ program_config_init processed");
    console.log("TXID_PCI=" + txid1);
  }

  // ============ TX #2: multisig_create_v2 ============
  const createKeySeed = randomBytes(32);
  const createKey = makeSigner(new Uint8Array(createKeySeed));
  console.log("\ncreate_key   :", hex(createKey.xonly), `(seed ${createKeySeed.toString("hex")})`);

  const [multisigPda] = PubkeyUtil.findProgramAddress(
    [SEED_PREFIX, SEED_MULTISIG, Buffer.from(createKey.xonly)],
    programId,
  );
  console.log("multisig PDA :", hex(multisigPda));

  // MultisigCreateArgsV2
  const memo = "Ported from Solana Squads V4 \u2192 Arch";
  const memoBytes = Buffer.from(memo, "utf8");
  const member = Buffer.concat([
    Buffer.from(initializer.xonly), // Member.key
    Buffer.from([7]), // Permissions.mask = all (initiate|vote|execute)
  ]);
  const mc2Args = Buffer.concat([
    Buffer.from([0]), // config_authority: Option<Pubkey> = None
    u16le(1), // threshold = 1
    u32le(1), // members: Vec len = 1
    member,
    u32le(0), // time_lock = 0
    Buffer.from([0]), // rent_collector: Option<Pubkey> = None
    Buffer.from([1]), // memo: Option<String> = Some
    u32le(memoBytes.length),
    memoBytes,
  ]);
  const mc2Data = new Uint8Array(Buffer.concat([dMc2, mc2Args]));

  const mc2Ix = {
    program_id: programId,
    accounts: [
      { pubkey: programConfig, is_signer: false, is_writable: false },
      { pubkey: treasury, is_signer: false, is_writable: true },
      { pubkey: multisigPda, is_signer: false, is_writable: true },
      { pubkey: createKey.xonly, is_signer: true, is_writable: false },
      { pubkey: initializer.xonly, is_signer: true, is_writable: true }, // creator
      { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
    ],
    data: mc2Data,
  };
  console.log("\n📤 TX#2 multisig_create_v2 ...");
  const txid2 = await signSubmit(provider, mc2Ix, initializer.xonly, [
    initializer,
    createKey,
  ]);
  console.log("   txid:", txid2);
  await waitProcessed(provider, txid2, "multisig_create_v2");
  console.log("   ✅ multisig_create_v2 processed");
  console.log("TXID_MC2=" + txid2);

  console.log("\n===== SUMMARY =====");
  console.log("program_config PDA:", hex(programConfig));
  console.log("multisig PDA      :", hex(multisigPda));
  console.log("treasury          :", hex(treasury));
  console.log("create_key        :", hex(createKey.xonly));
}

main().catch((e) => {
  console.error("\u274c", e?.stack || e?.message || e);
  process.exit(1);
});
