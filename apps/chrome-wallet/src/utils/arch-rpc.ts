import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { ArchIndexerClient } from "./indexer";

const METADATA_PROGRAM_ID = "MetaLUJnthcRKvy3ayXTnVcxaXqca1fbaQox8ChQqAk";
const METADATA_SEED = new TextEncoder().encode("metadata");

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
  indexer: ArchIndexerClient,
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
  indexer: ArchIndexerClient,
  mintBase58: string,
): Promise<MintInfo | null> {
  const acct = await readAccountInfo(indexer, mintBase58);
  if (!acct?.data) return null;
  return parseMintData(acct.data);
}

export async function fetchTokenMetadata(
  indexer: ArchIndexerClient,
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
  indexer: ArchIndexerClient,
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
