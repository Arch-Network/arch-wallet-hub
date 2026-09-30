/**
 * Local re-derivation of what a Wallet Hub signing request asks us to sign.
 *
 * `displayHash` only proves the preview matches what the Hub stored, not
 * that the bytes to sign match the dapp's request. Everything signed is
 * rebuilt here from the dapp request, the signing account and the Hub's
 * `recentBlockhashHex` -- the only Hub input the extension cannot derive.
 *
 * The instruction builders mirror `services/wallet-hub-api/src/routes/
 * signingRequests.ts`; a change to how the Hub builds an action must land
 * here too or every such request will be refused.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PubkeyUtil,
  SanitizedMessageUtil,
  SystemInstruction,
  TOKEN_PROGRAM_ID,
  type Instruction,
  type Pubkey,
} from "@arch-network/arch-sdk";
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import { archMessageFee, type ArchFee } from "./arch-fee";
import { bytesToHex, computeBip322ToSignTaprootSighash, hexToBytes } from "./bip322";
import { parseU64DecimalString } from "./u64-amount";

export type HubSigningIntent =
  | { type: "arch.transfer"; toAddress: string; lamports: string }
  | {
      type: "arch.token_transfer";
      mintAddress: string;
      toAddress: string;
      amount: string;
      /** Source token account the extension itself sent the Hub; defaults to the signer's derived ATA. */
      sourceTokenAccount?: string;
    }
  | { type: "arch.sign_message"; messageHex: string };

export interface VerifiedHubSigningRequest {
  /** 32-byte BIP-322 to_sign sighash, recomputed locally. */
  payloadHex: string;
  /** The Hub's to_sign PSBT, checked to sign exactly `payloadHex`'s message; null when absent. */
  psbtBase64: string | null;
}

type Obj = Record<string, unknown>;

function mismatch(what: string): never {
  throw new Error(`Wallet Hub signing request does not match this request (${what}). Refusing to sign.`);
}

function asObj(value: unknown, what: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) mismatch(`${what} missing`);
  return value as Obj;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function taprootScript(address: unknown, what: string): Uint8Array {
  if (typeof address !== "string") mismatch(`${what} missing`);
  let decoded: { version: number; data: Uint8Array };
  try {
    decoded = bitcoin.address.fromBech32(address);
  } catch {
    mismatch(`${what} is not a bech32 address`);
  }
  if (decoded.version !== 1 || decoded.data.length !== 32) mismatch(`${what} is not Taproot`);
  return Uint8Array.from([0x51, 0x20, ...decoded.data]);
}

function decodePubkey(value: unknown, what: string): Pubkey {
  let bytes: Uint8Array | null = null;
  try {
    if (typeof value === "string") bytes = bs58.decode(value);
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== 32) mismatch(`${what} is not a 32-byte base58 key`);
  return bytes;
}

function expectSigner(value: unknown, archAddress: string, signerScript: Uint8Array): void {
  const who = asObj(value, "display signer");
  if (who.archAccountAddress !== archAddress) mismatch("from account");
  if (!equalBytes(taprootScript(who.taprootAddress, "from address"), signerScript)) {
    mismatch("from address");
  }
}

function associatedTokenAddress(mint: Pubkey, owner: Pubkey): Pubkey {
  return PubkeyUtil.getAssociatedTokenAddress(
    mint,
    owner,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

function createAssociatedTokenAccountInstruction(
  payer: Pubkey,
  ata: Pubkey,
  owner: Pubkey,
  mint: Pubkey,
  idempotent: boolean,
): Instruction {
  return {
    program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: payer, is_signer: true, is_writable: true },
      { pubkey: ata, is_signer: false, is_writable: true },
      { pubkey: owner, is_signer: false, is_writable: false },
      { pubkey: mint, is_signer: false, is_writable: false },
      { pubkey: PubkeyUtil.systemProgram(), is_signer: false, is_writable: false },
      { pubkey: TOKEN_PROGRAM_ID, is_signer: false, is_writable: false },
    ],
    data: idempotent ? new Uint8Array([1]) : new Uint8Array(0),
  };
}

function tokenTransferInstruction(
  sourceAta: Pubkey,
  destAta: Pubkey,
  owner: Pubkey,
  amount: bigint,
): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return {
    program_id: TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: sourceAta, is_signer: false, is_writable: true },
      { pubkey: destAta, is_signer: false, is_writable: true },
      { pubkey: owner, is_signer: true, is_writable: false },
    ],
    data,
  };
}

type ArchTxIntent = Exclude<HubSigningIntent, { type: "arch.sign_message" }>;

function archTransferInstructions(payer: Pubkey, to: Pubkey, lamports: bigint): Instruction[] {
  return [SystemInstruction.transfer(payer, to, lamports)];
}

function tokenAccountsFor(
  intent: Extract<HubSigningIntent, { type: "arch.token_transfer" }>,
  payer: Pubkey,
  to: Pubkey,
): { mint: Pubkey; sourceAta: Pubkey; destAta: Pubkey } {
  const mint = decodePubkey(intent.mintAddress, "mint");
  // Only derived ATAs (or a source account the extension chose itself)
  // are accepted: a Hub-chosen token account can't be checked for
  // owner/mint without an RPC read, so it fails closed.
  const sourceAta =
    intent.sourceTokenAccount !== undefined
      ? decodePubkey(intent.sourceTokenAccount, "source token account")
      : associatedTokenAddress(mint, payer);
  return { mint, sourceAta, destAta: associatedTokenAddress(mint, to) };
}

function tokenTransferInstructions(
  payer: Pubkey,
  to: Pubkey,
  mint: Pubkey,
  sourceAta: Pubkey,
  destAta: Pubkey,
  amount: bigint,
  createDestAta: boolean,
  idempotent: boolean,
): Instruction[] {
  return [
    ...(createDestAta
      ? [createAssociatedTokenAccountInstruction(payer, destAta, to, mint, idempotent)]
      : []),
    tokenTransferInstruction(sourceAta, destAta, payer, amount),
  ];
}

/**
 * Network fee for the message the Hub builds for `intent`, compiled with
 * the same builders `verifyHubSigningRequest` checks against. Amounts,
 * the blockhash and the optional ATA-create ix don't change the signer
 * set, so this is known before the Hub is asked. Null when the intent
 * can't be compiled (the request would be refused anyway).
 */
export function hubIntentFee(intent: ArchTxIntent, archAddress: string | undefined): ArchFee | null {
  try {
    if (!archAddress) return null;
    const payer = decodePubkey(archAddress, "signer Arch address");
    const to = decodePubkey(intent.toAddress, "recipient");
    let instructions: Instruction[];
    if (intent.type === "arch.transfer") {
      instructions = archTransferInstructions(payer, to, 0n);
    } else {
      const { mint, sourceAta, destAta } = tokenAccountsFor(intent, payer, to);
      instructions = tokenTransferInstructions(payer, to, mint, sourceAta, destAta, 0n, true, true);
    }
    const compiled = SanitizedMessageUtil.createSanitizedMessage(instructions, payer, new Uint8Array(32));
    return typeof compiled === "string" ? null : archMessageFee(compiled);
  } catch {
    return null;
  }
}

/** Returns the Arch message hash (the BIP-322 message) for a transfer / token transfer. */
function verifyArchTransaction(
  intent: ArchTxIntent,
  archAddress: string,
  signerScript: Uint8Array,
  payload: Obj,
  display: Obj,
): Uint8Array {
  const blockhashHex = payload.recentBlockhashHex;
  if (typeof blockhashHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(blockhashHex)) {
    mismatch("recentBlockhashHex");
  }
  if (display.kind !== intent.type) mismatch("action kind");
  expectSigner(display.from, archAddress, signerScript);
  if (asObj(display.to, "display recipient").archAccountAddress !== intent.toAddress) {
    mismatch("recipient");
  }

  const payer = decodePubkey(archAddress, "signer Arch address");
  const to = decodePubkey(intent.toAddress, "recipient");
  let instructions: Instruction[];
  if (intent.type === "arch.transfer") {
    const lamports = parseU64DecimalString(intent.lamports);
    if (lamports === null || parseU64DecimalString(display.lamports) !== lamports) {
      mismatch("lamports");
    }
    instructions = archTransferInstructions(payer, to, lamports);
  } else {
    const amount = parseU64DecimalString(intent.amount);
    if (amount === null || parseU64DecimalString(display.amount) !== amount) mismatch("amount");
    if (display.mint !== intent.mintAddress) mismatch("mint");
    const { mint, sourceAta, destAta } = tokenAccountsFor(intent, payer, to);
    if (display.sourceAta !== bs58.encode(sourceAta)) mismatch("source token account");
    if (display.destAta !== bs58.encode(destAta)) mismatch("destination token account");
    const createDestAta = display.createDestAta;
    const idempotent = display.createDestAtaIdempotent;
    if (
      typeof createDestAta !== "boolean" ||
      typeof idempotent !== "boolean" ||
      (idempotent && !createDestAta)
    ) {
      mismatch("createDestAta");
    }
    instructions = tokenTransferInstructions(payer, to, mint, sourceAta, destAta, amount, createDestAta, idempotent);
  }

  const compiled = SanitizedMessageUtil.createSanitizedMessage(
    instructions,
    payer,
    hexToBytes(blockhashHex),
  );
  if (typeof compiled === "string") mismatch(`local message compile failed: ${compiled}`);
  const messageHash = SanitizedMessageUtil.hash(compiled);
  if (payload.messageHashHex !== undefined && payload.messageHashHex !== bytesToHex(messageHash)) {
    mismatch("messageHashHex");
  }
  return messageHash;
}

/** Returns the raw message bytes for arch.sign_message. */
function verifySignMessage(
  intent: Extract<HubSigningIntent, { type: "arch.sign_message" }>,
  archAddress: string,
  signerScript: Uint8Array,
  payload: Obj,
  display: Obj,
): Uint8Array {
  const messageHex = typeof intent.messageHex === "string" ? intent.messageHex.toLowerCase() : "";
  if (!/^(?:[0-9a-f]{2})+$/.test(messageHex)) mismatch("message is not non-empty even-length hex");
  if (display.kind !== intent.type) mismatch("action kind");
  expectSigner(display.account, archAddress, signerScript);
  if (asObj(display.message, "display message").hex !== messageHex) mismatch("message");
  if (payload.messageHex !== undefined && payload.messageHex !== messageHex) mismatch("messageHex");
  return hexToBytes(messageHex);
}

/**
 * The external-wallet path signs the Hub's PSBT instead of `payloadHex`.
 * Its SIGHASH_DEFAULT digest over its own prevout must equal the locally
 * computed sighash, which pins the to_spend txid (and so the message).
 */
function verifyToSignPsbt(psbtBase64: string, signerScript: Uint8Array, payloadHex: string): void {
  let psbt: bitcoin.Psbt;
  try {
    psbt = bitcoin.Psbt.fromBase64(psbtBase64);
  } catch {
    mismatch("psbtBase64 does not parse");
  }
  if (psbt.inputCount !== 1) mismatch("to_sign PSBT input count");
  const input = psbt.data.inputs[0]!;
  const prevout = input.witnessUtxo;
  if (!prevout || !equalBytes(prevout.script, signerScript)) mismatch("to_sign PSBT prevout");
  if (input.sighashType !== undefined && input.sighashType !== 0x00 && input.sighashType !== 0x01) {
    mismatch("to_sign PSBT sighash type");
  }
  const unsignedTx = (psbt as any).__CACHE?.__TX as bitcoin.Transaction | undefined;
  if (!unsignedTx) mismatch("to_sign PSBT has no unsigned transaction");
  const digest = unsignedTx.hashForWitnessV1(0, [prevout.script], [prevout.value], 0x00);
  if (bytesToHex(digest) !== payloadHex) mismatch("psbtBase64");
}

export function verifyHubSigningRequest(opts: {
  intent: HubSigningIntent;
  account: { btcAddress: string; archAddress?: string };
  payloadToSign: unknown;
  display: unknown;
}): VerifiedHubSigningRequest {
  const payload = asObj(opts.payloadToSign, "payloadToSign");
  const display = asObj(opts.display, "display");
  const archAddress = opts.account.archAddress;
  if (!archAddress) mismatch("signing account has no Arch address");
  const signerScript = taprootScript(opts.account.btcAddress, "signing account address");

  const message =
    opts.intent.type === "arch.sign_message"
      ? verifySignMessage(opts.intent, archAddress, signerScript, payload, display)
      : verifyArchTransaction(opts.intent, archAddress, signerScript, payload, display);

  const payloadHex = bytesToHex(
    computeBip322ToSignTaprootSighash({ signerAddress: opts.account.btcAddress, message }),
  );
  if (typeof payload.payloadHex !== "string" || payload.payloadHex.toLowerCase() !== payloadHex) {
    mismatch("payloadHex");
  }
  const psbtBase64 = typeof payload.psbtBase64 === "string" ? payload.psbtBase64 : null;
  if (psbtBase64 !== null) verifyToSignPsbt(psbtBase64, signerScript, payloadHex);
  return { payloadHex, psbtBase64 };
}
