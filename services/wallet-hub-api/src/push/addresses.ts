import { address as bitcoinAddress } from "bitcoinjs-lib";
import bs58 from "bs58";

export type PushChain = "arch" | "btc";

export type PushAddress = {
  chain: PushChain;
  address: string;
};

function isValidArchAddress(value: string): boolean {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 32 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function isValidBtcTaprootAddress(value: string): boolean {
  try {
    const decoded = bitcoinAddress.fromBech32(value);
    return (
      decoded.version === 1 &&
      decoded.data.length === 32 &&
      (decoded.prefix === "bc" ||
        decoded.prefix === "tb" ||
        decoded.prefix === "bcrt")
    );
  } catch {
    return false;
  }
}

export function normalizePushAddresses(
  addresses: readonly PushAddress[],
): PushAddress[] {
  const unique = new Map<string, PushAddress>();

  for (const item of addresses) {
    const address = item.address.trim();
    const valid =
      item.chain === "arch"
        ? isValidArchAddress(address)
        : isValidBtcTaprootAddress(address);
    if (!valid) {
      throw new Error(`Invalid ${item.chain} address`);
    }
    unique.set(`${item.chain}:${address}`, { chain: item.chain, address });
  }

  return [...unique.values()];
}
