import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import type { IndexerClient } from "./indexer";

const METADATA_PROGRAM_ID = "MetaLUJnthcRKvy3ayXTnVcxaXqca1fbaQox8ChQqAk";
const METADATA_SEED = new TextEncoder().encode("metadata");
const TOKEN_PROGRAM_ID = new Uint8Array([
  6, 221, 246, 225, 185, 234, 132, 65, 44, 16, 184, 223, 2, 28, 16, 15,
  200, 135, 25, 7, 195, 9, 195, 53, 53, 222, 32, 156, 52, 23, 99, 191,
]);

interface AccountInfo {
  data: number[];
  owner: number[];
  lamports: number;
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

export function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): { address: Uint8Array; bump: number } | null {
  for (let bump = 255; bump >= 0; bump--) {
    const combined: number[] = [];
    for (const s of seeds) combined.push(...s);
    combined.push(bump);
    combined.push(...programId);
    const hash = sha256(new Uint8Array(combined));
    if (!isOnCurve(hash)) {
      return { address: hash, bump };
    }
  }
  return null;
}

export function deriveMetadataPda(mintBase58: string): string | null {
  const mintBytes = bs58.decode(mintBase58);
  const programBytes = bs58.decode(METADATA_PROGRAM_ID);
  const result = findProgramAddress([METADATA_SEED, mintBytes], programBytes);
  return result ? bs58.encode(result.address) : null;
}

async function readAccountInfo(
  indexer: IndexerClient,
  addressBase58: string,
): Promise<AccountInfo | null> {
  const pubkeyBytes = Array.from(bs58.decode(addressBase58));
  try {
    const result = await indexer.rpc<AccountInfo | null>("read_account_info", pubkeyBytes);
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort lookup of an Arch account's current lamport balance,
 * used by the Approve modal's pre-flight balance check.
 *
 * Discriminates three outcomes the UI needs to render differently:
 *
 *   { kind: "found", lamports }     The account exists; render
 *                                   current/post balance, gate Approve
 *                                   on (lamports >= requestedAmount).
 *
 *   { kind: "not_found" }           Account doesn't exist on chain yet
 *                                   (fresh wallet, never received).
 *                                   UI shows "balance unknown"; we do
 *                                   NOT block the user since a 0
 *                                   balance is materially different
 *                                   from "we couldn't tell".
 *
 *   { kind: "error", reason }       Indexer call failed (network,
 *                                   timeout, auth). Same UI treatment
 *                                   as not_found: warn but don't
 *                                   block, since a transient indexer
 *                                   outage shouldn't strand the user.
 */
export type ArchBalanceSnapshot =
  | { kind: "found"; lamports: bigint }
  | { kind: "not_found" }
  | { kind: "error"; reason: string };

export async function fetchArchAccountBalance(
  indexer: IndexerClient,
  addressBase58: string,
): Promise<ArchBalanceSnapshot> {
  const pubkeyBytes = Array.from(bs58.decode(addressBase58));
  try {
    const result = await indexer.rpc<AccountInfo | null>("read_account_info", pubkeyBytes);
    if (!result || typeof result.lamports !== "number") {
      return { kind: "not_found" };
    }
    return { kind: "found", lamports: BigInt(result.lamports) };
  } catch (e: any) {
    return { kind: "error", reason: e?.message || "Unknown indexer error" };
  }
}

/**
 * Read and validate the raw balance of a deterministic associated token
 * account. We deliberately verify both mint and owner before trusting the
 * amount: a malformed indexer response must never make the approval screen
 * claim that a different token is available.
 */
export type TokenBalanceSnapshot =
  | { kind: "found"; amount: bigint }
  | { kind: "not_found" }
  | { kind: "error"; reason: string };

export async function fetchAssociatedTokenBalance(
  indexer: IndexerClient,
  tokenAccountBase58: string,
  mintBase58: string,
  ownerPublicKeyHex: string,
): Promise<TokenBalanceSnapshot> {
  try {
    const tokenAccount = Array.from(bs58.decode(tokenAccountBase58));
    const expectedMint = bs58.decode(mintBase58);
    const xOnlyOwnerHex =
      ownerPublicKeyHex.length === 66 ? ownerPublicKeyHex.slice(2) : ownerPublicKeyHex;
    if (
      expectedMint.length !== 32 ||
      !/^[0-9a-f]{64}$/i.test(xOnlyOwnerHex)
    ) {
      return { kind: "error", reason: "Invalid token account, mint, or wallet public key" };
    }
    const expectedOwner = new Uint8Array(
      xOnlyOwnerHex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)),
    );
    const account = await indexer.rpc<AccountInfo | null>("read_account_info", tokenAccount);
    if (!account?.data || account.data.length < 165) return { kind: "not_found" };

    const data = new Uint8Array(account.data);
    if (
      account.owner.length !== TOKEN_PROGRAM_ID.length ||
      !account.owner.every((byte, index) => byte === TOKEN_PROGRAM_ID[index]) ||
      !data.slice(0, 32).every((byte, index) => byte === expectedMint[index]) ||
      !data.slice(32, 64).every((byte, index) => byte === expectedOwner[index])
    ) {
      return { kind: "error", reason: "Associated token account does not match this token or wallet" };
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const amount =
      BigInt(view.getUint32(68, true)) * 0x1_0000_0000n +
      BigInt(view.getUint32(64, true));
    return { kind: "found", amount };
  } catch (e: any) {
    return { kind: "error", reason: e?.message || "Failed to read token balance" };
  }
}

export interface MintInfo {
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
}

/**
 * Parse the SPL/APL Token Mint account layout (82 bytes).
 * Layout: COption<Pubkey>(36) | supply(8) | decimals(1) | is_initialized(1) | COption<Pubkey>(36)
 */
function parseMintData(data: number[]): MintInfo | null {
  if (data.length < 82) return null;
  const buf = new Uint8Array(data);
  const view = new DataView(buf.buffer);

  const mintAuthOption = view.getUint32(0, true);
  const mintAuthority = mintAuthOption === 1
    ? bs58.encode(buf.slice(4, 36))
    : null;

  const supplyLo = view.getUint32(36, true);
  const supplyHi = view.getUint32(40, true);
  const supply = BigInt(supplyHi) * BigInt(0x100000000) + BigInt(supplyLo);

  const decimals = buf[44];
  const isInitialized = buf[45] === 1;

  const freezeAuthOption = view.getUint32(46, true);
  const freezeAuthority = freezeAuthOption === 1
    ? bs58.encode(buf.slice(50, 82))
    : null;

  return { decimals, supply, mintAuthority, freezeAuthority, isInitialized };
}

export interface TokenMetadataInfo {
  name: string;
  symbol: string;
  image: string;
  description: string;
  updateAuthority: string | null;
}

/**
 * Parse Borsh-encoded TokenMetadata from the PDA account data.
 * Layout: is_initialized(1) | mint(32) | name(4+N) | symbol(4+N) | image(4+N) | description(4+N) | Option<Pubkey>(1+32)
 */
function parseMetadataData(data: number[]): TokenMetadataInfo | null {
  try {
    const buf = new Uint8Array(data);
    const view = new DataView(buf.buffer);
    let offset = 0;

    const isInit = buf[offset]; offset += 1;
    if (isInit !== 1) return null;

    offset += 32; // skip mint pubkey

    const readString = (): string => {
      const len = view.getUint32(offset, true); offset += 4;
      const str = new TextDecoder().decode(buf.slice(offset, offset + len)); offset += len;
      return str;
    };

    const name = readString();
    const symbol = readString();
    const image = readString();
    const description = readString();

    const hasAuthority = buf[offset]; offset += 1;
    const updateAuthority = hasAuthority === 1
      ? bs58.encode(buf.slice(offset, offset + 32))
      : null;

    return { name, symbol, image, description, updateAuthority };
  } catch {
    return null;
  }
}

export async function fetchMintInfo(
  indexer: IndexerClient,
  mintBase58: string,
): Promise<MintInfo | null> {
  const acct = await readAccountInfo(indexer, mintBase58);
  if (!acct?.data) return null;
  return parseMintData(acct.data);
}

export async function fetchTokenMetadata(
  indexer: IndexerClient,
  mintBase58: string,
): Promise<TokenMetadataInfo | null> {
  const pda = deriveMetadataPda(mintBase58);
  if (!pda) return null;
  const acct = await readAccountInfo(indexer, pda);
  if (!acct?.data) return null;
  return parseMetadataData(acct.data);
}

export interface EnrichedTokenData {
  decimals?: number;
  name?: string;
  symbol?: string;
  image?: string;
  description?: string;
  uiAmount?: string;
}

/**
 * Enrich a token with on-chain data when the indexer returns missing decimals
 * or metadata. Uses the indexer's legacy /rpc compat for `read_account_info`.
 */
export async function enrichTokenFromRpc(
  indexer: IndexerClient,
  token: {
    mint_address: string;
    amount?: string | number;
    decimals?: number | null;
    name?: string | null;
    symbol?: string | null;
    image?: string | null;
    [key: string]: unknown;
  },
): Promise<EnrichedTokenData> {
  const result: EnrichedTokenData = {};

  const needsDecimals = !token.decimals && token.decimals !== undefined;
  const needsMetadata = !token.name || !token.symbol;

  const promises: Promise<void>[] = [];

  if (needsDecimals) {
    promises.push(
      fetchMintInfo(indexer, token.mint_address).then((mint) => {
        if (mint && mint.decimals > 0) {
          result.decimals = mint.decimals;
          const raw = Number(token.amount) || 0;
          result.uiAmount = (raw / Math.pow(10, mint.decimals)).toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: mint.decimals,
          });
        }
      }),
    );
  }

  if (needsMetadata) {
    promises.push(
      fetchTokenMetadata(indexer, token.mint_address).then((md) => {
        if (md) {
          if (md.name) result.name = md.name;
          if (md.symbol) result.symbol = md.symbol;
          if (md.image) result.image = md.image;
          if (md.description) result.description = md.description;
        }
      }),
    );
  }

  await Promise.allSettled(promises);
  return result;
}
