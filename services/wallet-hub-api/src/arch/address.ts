import { address as btcAddress } from "bitcoinjs-lib";
import bs58 from "bs58";

export type ResolveArchAccountResult =
  | { kind: "arch"; archAccountAddress: string }
  | {
      kind: "taproot";
      taprootAddress: string;
      archAccountAddress: string;
      xOnlyPubkeyHex: string;
    };

export function resolveArchAccountAddress(input: string): ResolveArchAccountResult {
  // If caller already provided an Arch account address (base58), we currently pass through.
  // TODO(phase1): validate base58 length/bytes and/or support hex form.
  if (!input.startsWith("bc1") && !input.startsWith("tb1") && !input.startsWith("bcrt1")) {
    return { kind: "arch", archAccountAddress: input };
  }

  const decoded = btcAddress.fromBech32(input);
  // Taproot is segwit v1 with 32-byte witness program.
  if (decoded.version !== 1 || decoded.data.length !== 32) {
    throw new Error("Only Taproot (p2tr) bech32m addresses can be mapped to Arch accounts");
  }

  const xOnlyPubkey = Buffer.from(decoded.data);
  const archAccountAddress = bs58.encode(xOnlyPubkey);

  return {
    kind: "taproot",
    taprootAddress: input,
    archAccountAddress,
    xOnlyPubkeyHex: xOnlyPubkey.toString("hex")
  };
}
