#!/usr/bin/env tsx
/**
 * Standalone testnet client: execute a `swap` on the arch-bitcoin-defi AMM.
 *
 * QuoteToBase (buy rune with BTC): the user supplies a BTC input UTXO and
 * receives runes. The program selects which of the pool's OWN tracked reserve
 * UTXOs fund the rune side (the caller no longer supplies reserve inputs), and
 * verifies the user's input value on-chain. It then builds a native Bitcoin
 * settlement (TransactionBuilder) and queues it for FROST signing. The user's
 * single Arch (BIP-322) signature authorises both the Arch state transition and
 * the user's Bitcoin input; validators FROST-sign the program-custodied reserve
 * inputs the program chose.
 *
 * Usage (env):
 *   AMM_PROGRAM_ID=<hex32> RUNE_BLOCK=73393 RUNE_TX=191
 *   USER_TXID=<btc utxo txid> USER_VOUT=0
 *   AMOUNT_IN=2000 MIN_OUT=1 NONCE=0 FEE_RATE=2
 *   USER_SEED=<32-byte hex priv>   (the key that owns USER_TXID)
 *   tsx scripts/swap-amm-pool.ts
 *
 * The pool must already hold rune reserves (seed via add_liquidity) so the
 * program has UTXOs to select for the payout.
 */
import {
  RpcConnection,
  PubkeyUtil,
  SanitizedMessageUtil,
  SignatureUtil,
  SystemInstruction,
} from "@arch-network/arch-sdk";
import { computeBip322ToSignTaprootSighash } from "../src/bitcoin/bip322.js";
import { sha256 } from "@noble/hashes/sha256";
import * as bitcoin from "bitcoinjs-lib";
import secp256k1 from "@bitcoinerlab/secp256k1";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
(bitcoin as any).initEccLib?.(secp256k1);

const ARCH_RPC =
  process.env.ARCH_RPC_NODE_URL_TESTNET || "https://rpc.testnet.arch.network";
const AMM_PROGRAM_ID =
  process.env.AMM_PROGRAM_ID ||
  "aa03f3fde156ad78b434bb8885ca3ef1fa5a5c9f412cd8af1d7ca282b56f80e4";
const RUNE_BLOCK = BigInt(process.env.RUNE_BLOCK || "73393");
const RUNE_TX = Number(process.env.RUNE_TX || "191");

const USER_TXID = process.env.USER_TXID!;
const USER_VOUT = Number(process.env.USER_VOUT || "0");
const USER_VALUE = BigInt(process.env.USER_VALUE || "39800");

const AMOUNT_IN = BigInt(process.env.AMOUNT_IN || "2000");
const MIN_OUT = BigInt(process.env.MIN_OUT || "1");
const NONCE = BigInt(process.env.NONCE || "0");
const FEE_RATE = BigInt(process.env.FEE_RATE || "2");
const USER_SEED = process.env.USER_SEED; // 32-byte hex; owns USER_TXID

// ABI probing knobs. The deployed binary may predate the current source, so its
// SwapArgs layout is selectable. Defaults match the current source (format B:
// outpoint-only user_input, no reserve_inputs). Failed txs don't bump the pool
// nonce, so probing alternative layouts is non-destructive.
//   USER_FULL=1    -> user_input carries value_sats+rune_amount (HEAD InputUtxo)
//   HAS_RESERVE=1  -> SwapArgs includes a reserve_inputs Vec<InputUtxo>
//   RESERVE_FULL=1 -> reserve entries carry value_sats+rune_amount
const USER_FULL = process.env.USER_FULL === "1";
const HAS_RESERVE = process.env.HAS_RESERVE === "1";
const RESERVE_FULL = process.env.RESERVE_FULL !== "0";
const RESERVE_TXID = process.env.RESERVE_TXID || "";
const RESERVE_VOUT = Number(process.env.RESERVE_VOUT || "1");
const RESERVE_VALUE = BigInt(process.env.RESERVE_VALUE || "330");
const RESERVE_RUNE = BigInt(process.env.RESERVE_RUNE || "21");

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
function u128le(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return b;
}
function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
// REVERSE_TXID=1 sends txid bytes in internal (little-endian) order instead of
// display order. The settlement TransactionBuilder may interpret UtxoMeta bytes
// as internal order, in which case display-order bytes produce a reversed txid
// and the runtime's get_tx_raw lookup misses the cache.
const REVERSE_TXID = process.env.REVERSE_TXID === "1";
function txidBytes(txidHex: string): Buffer {
  const b = Buffer.from(hexToBytes(txidHex));
  return REVERSE_TXID ? Buffer.from(b).reverse() : b;
}
function outpoint(txidHex: string, vout: number): Buffer {
  return Buffer.concat([txidBytes(txidHex), u32le(vout)]);
}
function inputUtxo(
  txidHex: string,
  vout: number,
  value: bigint,
  rune: bigint,
  full: boolean,
): Buffer {
  return full
    ? Buffer.concat([outpoint(txidHex, vout), u64le(value), u128le(rune)])
    : outpoint(txidHex, vout);
}

/** Compile, BIP-322 sign, and submit a single-instruction Arch tx; return txid. */
async function signSubmit(
  provider: any,
  ix: any,
  user: Uint8Array,
  taprootAddress: string,
  tweakedKeyPair: any,
): Promise<string> {
  const recentBlockhash = hexToBytes(await provider.getBestBlockHash());
  const message = SanitizedMessageUtil.createSanitizedMessage(
    [ix],
    user,
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
  return provider.sendTransaction({ version: 0, signatures: [adjusted], message } as any);
}

async function main() {
  console.log("🔁 swap (QuoteToBase: buy rune with BTC) on AMM", AMM_PROGRAM_ID);
  console.log("   rune", `${RUNE_BLOCK}:${RUNE_TX}`);
  console.log("   user input(btc)", `${USER_TXID}:${USER_VOUT}`);
  console.log("   amount_in", AMOUNT_IN.toString(), "min_out", MIN_OUT.toString(), "nonce", NONCE.toString());

  const network = bitcoin.networks.testnet;
  const ECPair = getECPair();
  const keyPair = USER_SEED
    ? ECPair.fromPrivateKey(Buffer.from(USER_SEED, "hex"), { network })
    : ECPair.makeRandom({ network });
  const compressed = Buffer.from(keyPair.publicKey);
  const internalXOnly = toXOnly(compressed);
  const taprootAddress = bitcoin.payments.p2tr({
    internalPubkey: internalXOnly,
    network,
  }).address!;
  const tweakedKeyPair = keyPair.tweak(
    bitcoin.crypto.taggedHash("TapTweak", internalXOnly),
  );
  const user = new Uint8Array(internalXOnly);
  console.log("   user taproot", taprootAddress);

  // Recipient (user receives runes here): the user's own P2TR scriptPubKey.
  const recipientScript = Buffer.concat([Buffer.from([0x51, 0x20]), internalXOnly]);

  const provider = new RpcConnection(ARCH_RPC);

  console.log("💧 airdrop user (Arch fee payer)...");
  try {
    await provider.requestAirdrop(user);
  } catch (e: any) {
    console.log("   airdrop:", e?.message || e);
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      if (await provider.readAccountInfo(user)) {
        console.log("   user funded");
        break;
      }
    } catch {
      /* not yet */
    }
  }

  // Anchor the user's Arch account to the BTC input UTXO. Native settlement
  // requires the input's prevout to be known to the runtime (otherwise the
  // set_inputs_to_sign syscall fails "cache-only: tx not found in cache"). This
  // is the same arch.anchor step the Hub runs before any native-settlement tx.
  if (process.env.ANCHOR_FIRST !== "0") {
    const info: any = await provider.readAccountInfo(user).catch(() => null);
    const anchored = info?.utxo && String(info.utxo) !== "" &&
      !String(info.utxo).startsWith("0".repeat(64));
    if (anchored) {
      console.log("⚓ user already anchored:", String(info.utxo));
    } else {
      console.log("⚓ anchoring user account ->", `${USER_TXID}:${USER_VOUT}`);
      const anchorIx = SystemInstruction.anchor(user, USER_TXID, USER_VOUT);
      const atxid = await signSubmit(provider, anchorIx, user, taprootAddress, tweakedKeyPair);
      console.log("   anchor txid:", atxid);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const p: any = await (provider as any).getProcessedTransaction(atxid).catch(() => null);
        const st = p?.status?.type ?? p?.status;
        if (st) console.log(`   anchor status[${i}]:`, st);
        if (st === "processed" || st === "Processed") {
          console.log("   ✅ anchored");
          break;
        }
        if (st === "failed" || st === "Failed") {
          console.log("   ❌ anchor failed:", (p?.logs || []).join(" | "));
          throw new Error("anchor failed");
        }
      }
    }
  }

  const programId = hexToBytes(AMM_PROGRAM_ID);
  const [pool] = PubkeyUtil.findProgramAddress(
    [Buffer.from("pool"), u64le(RUNE_BLOCK), u32le(RUNE_TX)],
    programId,
  );
  console.log("   pool", Buffer.from(pool).toString("hex"));

  // discriminator + SwapArgs (Borsh)
  const disc = sha256(new TextEncoder().encode("global:swap")).slice(0, 8);
  const parts: Buffer[] = [
    Buffer.from([0x00]), // base_to_quote = false (QuoteToBase)
    u128le(AMOUNT_IN),
    u128le(MIN_OUT),
    u64le(NONCE),
    inputUtxo(USER_TXID, USER_VOUT, USER_VALUE, 0n, USER_FULL), // user_input
  ];
  if (HAS_RESERVE) {
    parts.push(u32le(1)); // reserve_inputs vec len = 1
    parts.push(
      inputUtxo(RESERVE_TXID, RESERVE_VOUT, RESERVE_VALUE, RESERVE_RUNE, RESERVE_FULL),
    );
  }
  parts.push(u32le(recipientScript.length)); // recipient_script vec<u8> len
  parts.push(recipientScript);
  parts.push(u64le(FEE_RATE));
  console.log(
    `   ABI: USER_FULL=${USER_FULL} HAS_RESERVE=${HAS_RESERVE} RESERVE_FULL=${RESERVE_FULL}`,
  );
  const args = Buffer.concat(parts);
  const data = new Uint8Array(Buffer.concat([Buffer.from(disc), args]));

  const ix = {
    program_id: programId,
    accounts: [
      { pubkey: pool, is_signer: false, is_writable: true },
      { pubkey: user, is_signer: true, is_writable: false },
    ],
    data,
  };

  const recentBlockhash = hexToBytes(await provider.getBestBlockHash());
  const message = SanitizedMessageUtil.createSanitizedMessage(
    [ix as any],
    user,
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

  console.log("📤 submitting swap...");
  const txid = await provider.sendTransaction({
    version: 0,
    signatures: [adjusted],
    message,
  } as any);
  console.log("   arch txid:", txid);

  // Poll processed-transaction status for success / program error + logs.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const p: any = await (provider as any).getProcessedTransaction(txid);
      if (p) {
        const status = p.status?.type ?? p.status ?? JSON.stringify(p.status);
        const norm = String(status).toLowerCase();
        console.log(`   status[${i}]:`, status);
        if (p.runtime_transaction || p.bitcoin_txid || p.bitcoin_txids) {
          console.log("   bitcoin_txid(s):", p.bitcoin_txid ?? p.bitcoin_txids);
        }
        const logs = p.logs || p.log_messages;
        if (logs && (norm === "failed" || norm === "processed" || typeof status === "object")) {
          console.log("   logs:\n     " + (logs as string[]).join("\n     "));
        }
        if (norm === "processed" || norm === "failed") return;
      }
    } catch (e: any) {
      // not yet available
    }
  }
  console.log("⚠️  no terminal status observed; inspect arch tx", txid);
}

main().catch((e) => {
  console.error("❌", e?.stack || e?.message || e);
  process.exit(1);
});
