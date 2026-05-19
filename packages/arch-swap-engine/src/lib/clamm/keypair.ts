import ecc from "@bitcoinerlab/secp256k1";
import { Signer, Address, Key } from "@saturnbtcio/bip322-js";
import { bytesToHex } from "@/lib/arch/hex";
import type { NetworkConfig } from "@/lib/network/config";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data as unknown as ArrayBuffer,
  );
  return new Uint8Array(hashBuffer);
}

async function hexToWif(
  config: NetworkConfig,
  privateKeyHex: string,
): Promise<string> {
  const prefix = config.wifPrefix;
  const privBytes = hexToBytes(privateKeyHex);
  const extended = new Uint8Array([prefix, ...privBytes, 0x01]);
  const hash1 = await sha256(extended);
  const hash2 = await sha256(hash1);
  const checksum = hash2.slice(0, 4);
  const full = new Uint8Array([...extended, ...checksum]);

  let num = BigInt("0x" + bytesToHex(full));
  let result = "";
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const byte of full) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

export function deriveXOnlyPubkey(privateKeyHex: string): Uint8Array {
  const privBytes = hexToBytes(privateKeyHex);
  const xOnly = ecc.xOnlyPointFromScalar(privBytes);
  if (!xOnly) throw new Error("Failed to derive x-only pubkey from private key");
  return new Uint8Array(xOnly);
}

export function generateKeypair(): { pubkey: Uint8Array; privkeyHex: string } {
  const privBytes = crypto.getRandomValues(new Uint8Array(32));
  const privkeyHex = bytesToHex(privBytes);
  const pubkey = deriveXOnlyPubkey(privkeyHex);
  return { pubkey, privkeyHex };
}

export async function signWithKeypair(
  config: NetworkConfig,
  messageHash: Uint8Array,
  privkeyHex: string,
): Promise<number[]> {
  const challenge = new TextDecoder().decode(messageHash);
  const wif = await hexToWif(config, privkeyHex);

  const privBytes = hexToBytes(privkeyHex);
  const compressed = ecc.pointFromScalar(privBytes);
  if (!compressed) throw new Error("Failed to derive pubkey from private key");
  const xOnlyPub = Key.toXOnly(Buffer.from(compressed));
  const addrObj = Address.convertPubKeyIntoAddress(xOnlyPub, "p2tr" as "p2tr");
  const taprootAddress: string = (addrObj as Record<string, string>)[
    config.taprootAddressField
  ];

  const signatureBase64: string = Signer.sign(wif, taprootAddress, challenge);
  const witnessBuf = Buffer.from(signatureBase64, "base64");

  let offset = 0;
  const numItems = witnessBuf[offset++];
  if (numItems < 1) throw new Error("BIP-322 witness contains no items");
  const itemLen = witnessBuf[offset++];
  const item = witnessBuf.slice(offset, offset + itemLen);
  if (item.length < 64)
    throw new Error(`BIP-322 witness item too short: ${item.length}`);

  return Array.from(new Uint8Array(item.slice(0, 64)));
}
