import type { NetworkId } from "../state/types";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ BECH32M_CONST;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 31);
  return ret;
}

function decode(addr: string): { hrp: string; data5bit: number[] } | null {
  const lower = addr.toLowerCase();
  const sepIdx = lower.lastIndexOf("1");
  if (sepIdx < 1 || sepIdx + 7 > lower.length) return null;
  const hrp = lower.slice(0, sepIdx);
  const data5bit: number[] = [];
  for (let i = sepIdx + 1; i < lower.length; i++) {
    const d = CHARSET.indexOf(lower[i]);
    if (d === -1) return null;
    data5bit.push(d);
  }
  if (polymod(hrpExpand(hrp).concat(data5bit)) !== BECH32M_CONST) return null;
  return { hrp, data5bit: data5bit.slice(0, -6) };
}

function encode(hrp: string, data5bit: number[]): string {
  const checksum = createChecksum(hrp, data5bit);
  let ret = hrp + "1";
  for (const d of data5bit.concat(checksum)) ret += CHARSET[d];
  return ret;
}

/**
 * Re-encode a taproot bech32m address for a different network.
 * tb1p... ↔ bc1p... — the witness program bytes are identical,
 * only the human-readable part changes.
 */
export function reEncodeTaprootAddress(
  address: string,
  network: NetworkId
): string {
  const isTestnet = address.startsWith("tb1p");
  const isMainnet = address.startsWith("bc1p");
  if (!isTestnet && !isMainnet) return address;
  if (network === "mainnet" && isMainnet) return address;
  if (network !== "mainnet" && isTestnet) return address;

  const decoded = decode(address);
  if (!decoded) return address;

  const newHrp = network === "mainnet" ? "bc" : "tb";
  return encode(newHrp, decoded.data5bit);
}
