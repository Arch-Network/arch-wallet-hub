/**
 * The "Hub" side of these tests replays the Wallet Hub create handler
 * (services/wallet-hub-api/src/routes/signingRequests.ts and
 * src/bitcoin/bip322.ts) with the same libraries it uses -- arch-sdk for
 * instructions + message hash, bip322-js + a top-level bitcoinjs Psbt
 * re-parse for the sighash -- rather than the extension's helpers.
 */
import { describe, it, expect } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  PubkeyUtil,
  SanitizedMessageUtil,
  SystemInstruction,
  type AccountMeta,
  type Instruction,
  type Pubkey,
} from "@arch-network/arch-sdk";
import { Address, BIP322, Verifier } from "@saturnbtcio/bip322-js";
import { verifyHubSigningRequest, type HubSigningIntent } from "../hub-signing-request-verify";
import { buildSendHubAction } from "../send-hub-action";

bitcoin.initEccLib(ecc as any);

const HUB_APL_TOKEN_PROGRAM_ID = PubkeyUtil.fromHex(
  "06ddf6e1b9ea84412c10b8df021c100fc8871907c309c33535de209c341763bf",
);
const HUB_APL_ASSOCIATED_TOKEN_PROGRAM_ID = PubkeyUtil.fromHex(
  "8c97231184927b77b5f180118fcc683414b77c521e5a77081cf71d5f606a5384",
);

function keyFromSeed(seed: number, network: bitcoin.Network) {
  const priv = Buffer.alloc(32);
  priv.writeUInt32BE(seed, 28);
  priv[0] = 0x01;
  const internalXOnly = Buffer.from(ecc.pointFromScalar(priv, true)!.slice(1, 33));
  const address = bitcoin.payments.p2tr({ internalPubkey: internalXOnly, network }).address!;
  return { internalXOnly, address, archAddress: bs58.encode(internalXOnly) };
}

const SIGNER = keyFromSeed(7, bitcoin.networks.testnet);
const SIGNER_MAINNET_ADDRESS = keyFromSeed(7, bitcoin.networks.bitcoin).address;
const RECIPIENT = keyFromSeed(8, bitcoin.networks.testnet).archAddress;
const OTHER = keyFromSeed(9, bitcoin.networks.testnet).archAddress;
const MINT = bs58.encode(Buffer.alloc(32, 0x42));
const OTHER_MINT = bs58.encode(Buffer.alloc(32, 0x43));
const BLOCKHASH = "ab".repeat(32);
const OTHER_BLOCKHASH = "cd".repeat(32);
const ACCOUNT = { btcAddress: SIGNER.address, archAddress: SIGNER.archAddress };

// ── Hub replay ────────────────────────────────────────────────────────────

function hubBuildToSignPsbtBase64(signerAddress: string, message: Buffer, tapInternalKey: Buffer) {
  const scriptPubKey = Address.convertAdressToScriptPubkey(signerAddress);
  const toSpend = BIP322.buildToSpendTx(message, scriptPubKey);
  return BIP322.buildToSignTx(toSpend.getId(), scriptPubKey, false, tapInternalKey).toBase64();
}

function hubComputeSighash(signerAddress: string, message: Buffer): Buffer {
  const xOnly = Buffer.from(bitcoin.address.fromBech32(signerAddress).data);
  const psbt = bitcoin.Psbt.fromBase64(hubBuildToSignPsbtBase64(signerAddress, message, xOnly));
  if (psbt.data.inputs[0]?.sighashType !== 0x00) {
    try {
      psbt.updateInput(0, { sighashType: 0x00 });
    } catch {
      // The Hub swallows this too.
    }
  }
  try {
    return Buffer.from((Verifier as any).getHashForSigP2TR(psbt, 0x00));
  } catch {
    const witnessUtxo = psbt.data.inputs[0]!.witnessUtxo!;
    let toSignTx: bitcoin.Transaction;
    try {
      toSignTx = psbt.extractTransaction(false);
    } catch {
      toSignTx = (psbt as any).__CACHE.__TX;
    }
    return Buffer.from(toSignTx.hashForWitnessV1(0, [witnessUtxo.script], [0n], 0x00));
  }
}

function hubAta(mint: Pubkey, owner: Pubkey): Pubkey {
  return PubkeyUtil.getAssociatedTokenAddress(
    mint,
    owner,
    true,
    HUB_APL_TOKEN_PROGRAM_ID,
    HUB_APL_ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

function hubCreateAtaIx(payer: Pubkey, ata: Pubkey, owner: Pubkey, mint: Pubkey, idempotent: boolean): Instruction {
  return {
    program_id: HUB_APL_ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: payer, is_signer: true, is_writable: true } as AccountMeta,
      { pubkey: ata, is_signer: false, is_writable: true } as AccountMeta,
      { pubkey: owner, is_signer: false, is_writable: false } as AccountMeta,
      { pubkey: mint, is_signer: false, is_writable: false } as AccountMeta,
      { pubkey: PubkeyUtil.systemProgram(), is_signer: false, is_writable: false } as AccountMeta,
      { pubkey: HUB_APL_TOKEN_PROGRAM_ID, is_signer: false, is_writable: false } as AccountMeta,
    ],
    data: idempotent ? new Uint8Array([1]) : new Uint8Array(0),
  };
}

function hubTokenTransferIx(sourceAta: Pubkey, destAta: Pubkey, owner: Pubkey, amount: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(1, amount, true);
  return {
    program_id: HUB_APL_TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: sourceAta, is_signer: false, is_writable: true } as AccountMeta,
      { pubkey: destAta, is_signer: false, is_writable: true } as AccountMeta,
      { pubkey: owner, is_signer: true, is_writable: false } as AccountMeta,
    ],
    data,
  };
}

interface HubTxOptions {
  signerAddress?: string;
  signerArch?: string;
  blockhashForPayload?: string;
  reportedBlockhash?: string;
  network?: "mainnet" | "testnet4";
  indexedSourceAta?: Pubkey;
  indexedDestAta?: Pubkey;
}

function hubTransaction(action: Exclude<HubSigningIntent, { type: "arch.sign_message" }>, opts: HubTxOptions = {}) {
  const signerAddress = opts.signerAddress ?? SIGNER.address;
  const signerArch = opts.signerArch ?? SIGNER.archAddress;
  const payer = new Uint8Array(bs58.decode(signerArch));
  const from = { taprootAddress: signerAddress, archAccountAddress: signerArch, xOnlyPubkeyHex: SIGNER.internalXOnly.toString("hex") };
  let instructions: Instruction[];
  let display: Record<string, unknown>;
  if (action.type === "arch.transfer") {
    instructions = [SystemInstruction.transfer(payer, new Uint8Array(bs58.decode(action.toAddress)), BigInt(action.lamports))];
    display = {
      kind: "arch.transfer",
      from,
      to: { input: action.toAddress, archAccountAddress: action.toAddress },
      lamports: action.lamports,
      warnings: [],
    };
  } else {
    const mint = new Uint8Array(bs58.decode(action.mintAddress));
    const to = new Uint8Array(bs58.decode(action.toAddress));
    const useIdempotentAtaCreate = (opts.network ?? "testnet4") !== "mainnet";
    let sourceAta = action.sourceTokenAccount
      ? new Uint8Array(bs58.decode(action.sourceTokenAccount))
      : hubAta(mint, payer);
    let destAta = hubAta(mint, to);
    let createDestAta = true;
    if (!useIdempotentAtaCreate && opts.indexedSourceAta) sourceAta = opts.indexedSourceAta;
    if (!useIdempotentAtaCreate && opts.indexedDestAta) {
      destAta = opts.indexedDestAta;
      createDestAta = false;
    }
    instructions = [
      ...(createDestAta ? [hubCreateAtaIx(payer, destAta, to, mint, useIdempotentAtaCreate)] : []),
      hubTokenTransferIx(sourceAta, destAta, payer, BigInt(action.amount)),
    ];
    display = {
      kind: "arch.token_transfer",
      from,
      to: { input: action.toAddress, archAccountAddress: action.toAddress },
      mint: action.mintAddress,
      amount: action.amount,
      decimals: null,
      sourceAta: bs58.encode(Buffer.from(sourceAta)),
      destAta: bs58.encode(Buffer.from(destAta)),
      createDestAta,
      createDestAtaIdempotent: createDestAta && useIdempotentAtaCreate,
    };
  }
  const blockhash = opts.blockhashForPayload ?? BLOCKHASH;
  const compiled = SanitizedMessageUtil.createSanitizedMessage(instructions, payer, new Uint8Array(Buffer.from(blockhash, "hex")));
  if (typeof compiled === "string") throw new Error(compiled);
  const messageHash = SanitizedMessageUtil.hash(compiled);
  const payloadToSign = {
    kind: "taproot_sighash_hex",
    signWith: signerAddress,
    payloadHex: hubComputeSighash(signerAddress, Buffer.from(messageHash)).toString("hex"),
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP",
    messageHashHex: Buffer.from(messageHash).toString("hex"),
    psbtBase64: hubBuildToSignPsbtBase64(signerAddress, Buffer.from(messageHash), SIGNER.internalXOnly),
    recentBlockhashHex: opts.reportedBlockhash ?? blockhash,
    internalXOnlyPubkeyHex: SIGNER.internalXOnly.toString("hex"),
    psbtTapInternalKeyHex: SIGNER.internalXOnly.toString("hex"),
  };
  return { payloadToSign, display };
}

function hubSignMessage(messageHexInput: string) {
  const messageHex = messageHexInput.toLowerCase();
  const messageBytes = Buffer.from(messageHex, "hex");
  const payloadToSign = {
    kind: "taproot_sighash_hex",
    signWith: SIGNER.address,
    payloadHex: hubComputeSighash(SIGNER.address, messageBytes).toString("hex"),
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP",
    messageHex,
    psbtBase64: hubBuildToSignPsbtBase64(SIGNER.address, messageBytes, SIGNER.internalXOnly),
    internalXOnlyPubkeyHex: SIGNER.internalXOnly.toString("hex"),
    psbtTapInternalKeyHex: SIGNER.internalXOnly.toString("hex"),
  };
  const display = {
    kind: "arch.sign_message",
    account: { taprootAddress: SIGNER.address, archAccountAddress: SIGNER.archAddress, xOnlyPubkeyHex: SIGNER.internalXOnly.toString("hex") },
    message: { hex: messageHex, utf8: null, byteLength: messageBytes.length },
  };
  return { payloadToSign, display };
}

function verify(intent: HubSigningIntent, hub: { payloadToSign: unknown; display: unknown }, account = ACCOUNT) {
  return verifyHubSigningRequest({ intent, account, ...hub });
}

// ── Tests ─────────────────────────────────────────────────────────────────

const TRANSFER: HubSigningIntent = { type: "arch.transfer", toAddress: RECIPIENT, lamports: "10000000000" };
const TOKEN: HubSigningIntent = { type: "arch.token_transfer", mintAddress: MINT, toAddress: RECIPIENT, amount: "123456789" };
const MESSAGE: HubSigningIntent = { type: "arch.sign_message", messageHex: "48656c6c6f2c20417263682021" };

describe("verifyHubSigningRequest: honest Hub", () => {
  it("accepts an arch.transfer and returns the Hub's payloadHex and PSBT", () => {
    const hub = hubTransaction(TRANSFER);
    expect(verify(TRANSFER, hub)).toEqual({
      payloadHex: hub.payloadToSign.payloadHex,
      psbtBase64: hub.payloadToSign.psbtBase64,
    });
  });

  it("accepts an arch.token_transfer that creates the destination ATA (testnet)", () => {
    const hub = hubTransaction(TOKEN);
    expect(hub.display.createDestAtaIdempotent).toBe(true);
    expect(verify(TOKEN, hub).payloadHex).toBe(hub.payloadToSign.payloadHex);
  });

  it("accepts a mainnet arch.token_transfer whose destination ATA already exists", () => {
    const mint = new Uint8Array(bs58.decode(MINT));
    const hub = hubTransaction(TOKEN, {
      network: "mainnet",
      indexedDestAta: hubAta(mint, new Uint8Array(bs58.decode(RECIPIENT))),
    });
    expect(hub.display.createDestAta).toBe(false);
    expect(verify(TOKEN, hub).payloadHex).toBe(hub.payloadToSign.payloadHex);
  });

  it("accepts arch.sign_message (BIP-322 over the raw message bytes)", () => {
    const hub = hubSignMessage(MESSAGE.messageHex);
    expect(verify(MESSAGE, hub).payloadHex).toBe(hub.payloadToSign.payloadHex);
  });

  it("matches the signer by script, not by address encoding", () => {
    const hub = hubTransaction(TRANSFER, { signerAddress: SIGNER_MAINNET_ADDRESS });
    expect(verify(TRANSFER, hub).payloadHex).toBe(hub.payloadToSign.payloadHex);
  });
});

describe("verifyHubSigningRequest: tampered Hub responses are refused", () => {
  it("rejects a tampered payloadHex", () => {
    const hub = hubTransaction(TRANSFER);
    const flipped = (hub.payloadToSign.payloadHex[0] === "0" ? "1" : "0") + hub.payloadToSign.payloadHex.slice(1);
    hub.payloadToSign.payloadHex = flipped;
    expect(() => verify(TRANSFER, hub)).toThrow(/payloadHex/);
  });

  it("rejects a Hub that built a different lamports amount", () => {
    const hub = hubTransaction({ ...TRANSFER, lamports: "20000000000" } as HubSigningIntent & { type: "arch.transfer" });
    expect(() => verify(TRANSFER, hub)).toThrow(/lamports/);
  });

  it("rejects display lamports that differ even when the payload is honest", () => {
    const hub = hubTransaction(TRANSFER);
    hub.display.lamports = "1";
    expect(() => verify(TRANSFER, hub)).toThrow(/lamports/);
  });

  it("rejects a Hub that redirected the recipient", () => {
    const hub = hubTransaction({ ...TRANSFER, toAddress: OTHER } as HubSigningIntent & { type: "arch.transfer" });
    expect(() => verify(TRANSFER, hub)).toThrow(/recipient/);
  });

  it("rejects a payload built for a different recipient behind an honest display", () => {
    const hub = hubTransaction({ ...TRANSFER, toAddress: OTHER } as HubSigningIntent & { type: "arch.transfer" });
    hub.display.to = { input: RECIPIENT, archAccountAddress: RECIPIENT };
    expect(() => verify(TRANSFER, hub)).toThrow(/messageHashHex/);
    delete (hub.payloadToSign as any).messageHashHex;
    expect(() => verify(TRANSFER, hub)).toThrow(/payloadHex/);
  });

  it("rejects a Hub that swapped the token mint", () => {
    const hub = hubTransaction({ ...TOKEN, mintAddress: OTHER_MINT } as HubSigningIntent & { type: "arch.token_transfer" });
    expect(() => verify(TOKEN, hub)).toThrow(/mint/);
  });

  it("rejects a Hub that changed the token amount", () => {
    const hub = hubTransaction({ ...TOKEN, amount: "999999999" } as HubSigningIntent & { type: "arch.token_transfer" });
    expect(() => verify(TOKEN, hub)).toThrow(/amount/);
  });

  it("rejects a non-derived destination token account", () => {
    const hub = hubTransaction(TOKEN, {
      network: "mainnet",
      indexedDestAta: new Uint8Array(bs58.decode(OTHER)),
    });
    expect(() => verify(TOKEN, hub)).toThrow(/destination token account/);
  });

  it("rejects a Hub that signs from a different account", () => {
    const hub = hubTransaction(TRANSFER, { signerArch: OTHER });
    expect(() => verify(TRANSFER, hub)).toThrow(/from account/);
  });

  it("rejects a recentBlockhashHex that is not the one the payload was built with", () => {
    const hub = hubTransaction(TRANSFER, { blockhashForPayload: BLOCKHASH, reportedBlockhash: OTHER_BLOCKHASH });
    expect(() => verify(TRANSFER, hub)).toThrow(/messageHashHex/);
    delete (hub.payloadToSign as any).messageHashHex;
    expect(() => verify(TRANSFER, hub)).toThrow(/payloadHex/);
  });

  it("rejects a malformed recentBlockhashHex", () => {
    const hub = hubTransaction(TRANSFER);
    hub.payloadToSign.recentBlockhashHex = "zz";
    expect(() => verify(TRANSFER, hub)).toThrow(/recentBlockhashHex/);
  });

  it("rejects a to_sign PSBT that commits to a different message", () => {
    const hub = hubTransaction(TRANSFER);
    hub.payloadToSign.psbtBase64 = hubTransaction({ ...TRANSFER, lamports: "1" } as HubSigningIntent & { type: "arch.transfer" }).payloadToSign.psbtBase64;
    expect(() => verify(TRANSFER, hub)).toThrow(/psbtBase64/);
  });

  it("rejects a to_sign PSBT that requests a non-ALL sighash type", () => {
    const hub = hubTransaction(TRANSFER);
    const psbt = bitcoin.Psbt.fromBase64(hub.payloadToSign.psbtBase64);
    psbt.data.inputs[0]!.sighashType = 0x81;
    hub.payloadToSign.psbtBase64 = psbt.toBase64();
    expect(() => verify(TRANSFER, hub)).toThrow(/sighash type/);
  });

  it("rejects a sign_message payload for different bytes", () => {
    const hub = hubSignMessage("deadbeef");
    expect(() => verify(MESSAGE, hub)).toThrow(/message/);
    hub.display.message.hex = MESSAGE.messageHex;
    hub.payloadToSign.messageHex = MESSAGE.messageHex;
    expect(() => verify(MESSAGE, hub)).toThrow(/payloadHex/);
  });

  it("rejects a dapp amount that is not a strict u64 decimal string", () => {
    const hub = hubTransaction(TRANSFER);
    expect(() => verify({ ...TRANSFER, lamports: "0x2540BE400" } as HubSigningIntent, hub)).toThrow(/lamports/);
  });

  it("rejects when the signing account has no Arch address", () => {
    const hub = hubTransaction(TRANSFER);
    expect(() => verify(TRANSFER, hub, { btcAddress: SIGNER.address, archAddress: undefined as any })).toThrow(/no Arch address/);
  });
});

describe("Send page: hub signing requests built from the form are verified before signing", () => {
  type ArchIntent = Extract<HubSigningIntent, { type: "arch.transfer" }>;
  type TokenIntent = Extract<HubSigningIntent, { type: "arch.token_transfer" }>;
  type TokenSend = { action: TokenIntent & { decimals: number }; intent: TokenIntent };
  const arch = buildSendHubAction({ asset: "arch", toAddress: RECIPIENT, lamports: "2500000000" }) as {
    action: ArchIntent;
    intent: ArchIntent;
  };
  const aplInput = { asset: "apl" as const, toAddress: RECIPIENT, mintAddress: MINT, amount: "4200", decimals: 6 };
  const apl = buildSendHubAction(aplInput) as TokenSend;
  const OWN_TOKEN_ACCOUNT = keyFromSeed(10, bitcoin.networks.testnet).archAddress;
  const aplOwnAccount = buildSendHubAction({ ...aplInput, sourceTokenAccount: OWN_TOKEN_ACCOUNT }) as TokenSend;
  const REFUSED = /does not match this request .* Refusing to sign/;

  it("sends the Hub the same fields it verifies against", () => {
    expect(arch.action).toEqual(arch.intent);
    expect(apl.action).toEqual({ ...apl.intent, decimals: 6 });
    expect(aplOwnAccount.intent.sourceTokenAccount).toBe(OWN_TOKEN_ACCOUNT);
  });

  it("accepts honest ARCH and APL responses (derived and extension-chosen source account)", () => {
    for (const { action, intent } of [arch, apl, aplOwnAccount]) {
      const hub = hubTransaction(action);
      expect(verify(intent, hub)).toEqual({
        payloadHex: hub.payloadToSign.payloadHex,
        psbtBase64: hub.payloadToSign.psbtBase64,
      });
    }
  });

  it("ARCH: refuses a tampered amount, recipient, payloadHex or external-wallet PSBT", () => {
    expect(() => verify(arch.intent, hubTransaction({ ...arch.action, lamports: "2500000001" }))).toThrow(REFUSED);
    expect(() => verify(arch.intent, hubTransaction({ ...arch.action, toAddress: OTHER }))).toThrow(REFUSED);
    const payload = hubTransaction(arch.action);
    payload.payloadToSign.payloadHex = hubTransaction({ ...arch.action, lamports: "1" }).payloadToSign.payloadHex;
    expect(() => verify(arch.intent, payload)).toThrow(/payloadHex/);
    const psbt = hubTransaction(arch.action);
    psbt.payloadToSign.psbtBase64 = hubTransaction({ ...arch.action, toAddress: OTHER }).payloadToSign.psbtBase64;
    expect(() => verify(arch.intent, psbt)).toThrow(/psbtBase64/);
  });

  it("APL: refuses a tampered mint, amount, recipient or payloadHex", () => {
    expect(() => verify(apl.intent, hubTransaction({ ...apl.action, mintAddress: OTHER_MINT }))).toThrow(REFUSED);
    expect(() => verify(apl.intent, hubTransaction({ ...apl.action, amount: "4201" }))).toThrow(REFUSED);
    expect(() => verify(apl.intent, hubTransaction({ ...apl.action, toAddress: OTHER }))).toThrow(REFUSED);
    const payload = hubTransaction(apl.action);
    payload.payloadToSign.payloadHex = hubTransaction({ ...apl.action, amount: "1" }).payloadToSign.payloadHex;
    expect(() => verify(apl.intent, payload)).toThrow(/payloadHex/);
  });

  it("APL: refuses a Hub that substitutes its own source token account", () => {
    const hubSource = new Uint8Array(bs58.decode(OTHER));
    for (const { action, intent } of [apl, aplOwnAccount]) {
      const hub = hubTransaction(action, { network: "mainnet", indexedSourceAta: hubSource });
      expect(() => verify(intent, hub)).toThrow(/source token account/);
    }
    const ignored = hubTransaction(apl.action);
    expect(() => verify(aplOwnAccount.intent, ignored)).toThrow(/source token account/);
  });
});
