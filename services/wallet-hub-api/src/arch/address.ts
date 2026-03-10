import { address as btcAddress } from "bitcoinjs-lib";
import bs58 from "bs58";

export type ResolveArchAccountResult =
  | { kind: "arch"; archAccountAddress: string; archAccountAddressHex: string }
  | {
      kind: "taproot";
      taprootAddress: string;
      archAccountAddress: string;
      archAccountAddressHex: string;
      xOnlyPubkeyHex: string;
    };

export function resolveArchAccountAddress(input: string): ResolveArchAccountResult {
  if (!input.startsWith("bc1") && !input.startsWith("tb1") && !input.startsWith("bcrt1")) {
    return { kind: "arch", archAccountAddress: input, archAccountAddressHex: input };
  }

  const decoded = btcAddress.fromBech32(input);
  if (decoded.version !== 1 || decoded.data.length !== 32) {
    throw new Error("Only Taproot (p2tr) bech32m addresses can be mapped to Arch accounts");
  }

  const xOnlyPubkey = Buffer.from(decoded.data);
  const xOnlyHex = xOnlyPubkey.toString("hex");
  const base58Addr = bs58.encode(xOnlyPubkey);

  return {
    kind: "taproot",
    taprootAddress: input,
    archAccountAddress: base58Addr,
    archAccountAddressHex: xOnlyHex,
    xOnlyPubkeyHex: xOnlyHex
  };
}
