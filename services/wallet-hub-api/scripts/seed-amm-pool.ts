#!/usr/bin/env tsx
/**
 * Standalone testnet client: seed an arch-bitcoin-defi AMM pool by calling
 * `add_liquidity`, referencing real custody deposit UTXOs (one rune output +
 * one BTC output, both paying the program custody address).
 *
 * add_liquidity reads the deposited amounts on-chain (via arch_get_bitcoin_tx /
 * arch_get_runes_from_output), so we only pass the outpoints, not amounts.
 *
 * Txid bytes use Arch's display-order convention (explorer hex decoded as-is;
 * matches the SDK's UtxoMetaUtil.fromHex which does not reverse).
 *
 * Usage:
 *   AMM_PROGRAM_ID=<hex32> RUNE_BLOCK=73393 RUNE_TX=191 \
 *   BASE_TXID=<rune utxo txid> BASE_VOUT=1 \
 *   QUOTE_TXID=<btc utxo txid> QUOTE_VOUT=0 MIN_CONF=1 \
 *   tsx scripts/seed-amm-pool.ts
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
const RUNE_BLOCK = BigInt(process.env.RUNE_BLOCK || "73393");
const RUNE_TX = Number(process.env.RUNE_TX || "191");

const BASE_TXID =
  process.env.BASE_TXID ||
  "56a52c88ba5c25694bbbb666088badc76167ca3e620dd466583ae75bedec2163";
const BASE_VOUT = Number(process.env.BASE_VOUT || "1");
const QUOTE_TXID =
  process.env.QUOTE_TXID ||
  "dfbb057aea8cca69908f23944d9b03a5075610cd8e36bfd0b7c0300098804a0b";
const QUOTE_VOUT = Number(process.env.QUOTE_VOUT || "0");
const MIN_CONF = Number(process.env.MIN_CONF || "1");

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

async function main() {
  console.log("🌱 add_liquidity on AMM", AMM_PROGRAM_ID);
  console.log("   rune", `${RUNE_BLOCK}:${RUNE_TX}`);
  console.log("   base(rune)", `${BASE_TXID}:${BASE_VOUT}`);
  console.log("   quote(btc) ", `${QUOTE_TXID}:${QUOTE_VOUT}`);

  const network = bitcoin.networks.testnet;
  const ECPair = getECPair();
  const keyPair = ECPair.makeRandom({ network });
  const compressed = Buffer.from(keyPair.publicKey);
  const internalXOnly = toXOnly(compressed);
  const taprootAddress = bitcoin.payments.p2tr({
    internalPubkey: internalXOnly,
    network,
  }).address!;
  const tweakedKeyPair = keyPair.tweak(
    bitcoin.crypto.taggedHash("TapTweak", internalXOnly),
  );
  const lp = new Uint8Array(internalXOnly);
  console.log("   lp taproot", taprootAddress);

  const provider = new RpcConnection(ARCH_RPC);

  console.log("💧 airdrop lp...");
  try {
    await provider.requestAirdrop(lp);
  } catch (e: any) {
    console.log("   airdrop:", e?.message || e);
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      if (await provider.readAccountInfo(lp)) {
        console.log("   lp funded");
        break;
      }
    } catch {
      /* not yet */
    }
  }

  const programId = hexToBytes(AMM_PROGRAM_ID);
  const [pool] = PubkeyUtil.findProgramAddress(
    [Buffer.from("pool"), u64le(RUNE_BLOCK), u32le(RUNE_TX)],
    programId,
  );
  const [position] = PubkeyUtil.findProgramAddress(
    [Buffer.from("lp"), Buffer.from(pool), Buffer.from(lp)],
    programId,
  );
  console.log("   pool    ", Buffer.from(pool).toString("hex"));
  console.log("   position", Buffer.from(position).toString("hex"));

  // discriminator + AddLiquidityArgs
  const disc = sha256(new TextEncoder().encode("global:add_liquidity")).slice(0, 8);
  const args = Buffer.concat([
    Buffer.from(hexToBytes(BASE_TXID)), // display-order, no reverse
    u32le(BASE_VOUT),
    Buffer.from(hexToBytes(QUOTE_TXID)),
    u32le(QUOTE_VOUT),
    u32le(MIN_CONF),
  ]);
  const data = new Uint8Array(Buffer.concat([Buffer.from(disc), args]));

  const SYSTEM_PROGRAM = new Uint8Array(32);
  const ix = {
    program_id: programId,
    accounts: [
      { pubkey: pool, is_signer: false, is_writable: true },
      { pubkey: position, is_signer: false, is_writable: true },
      { pubkey: lp, is_signer: true, is_writable: true },
      { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
    ],
    data,
  };

  const recentBlockhash = hexToBytes(await provider.getBestBlockHash());
  const message = SanitizedMessageUtil.createSanitizedMessage(
    [ix as any],
    lp,
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

  console.log("📤 submitting add_liquidity...");
  const txid = await provider.sendTransaction({
    version: 0,
    signatures: [adjusted],
    message,
  } as any);
  console.log("   txid:", txid);

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const info: any = await provider.readAccountInfo(position);
      if (info) {
        console.log("✅ position account created — liquidity seeded.");
        console.log("   position owner:", Buffer.from(info.owner ?? []).toString("hex"));
        return;
      }
    } catch {
      /* not yet */
    }
  }
  console.log("⚠️  position not observed yet; inspect tx", txid);
}

main().catch((e) => {
  console.error("❌", e?.stack || e?.message || e);
  process.exit(1);
});
