import bs58 from "bs58";

export function deriveArchAccountAddress(publicKeyHex: string): string {
  const xOnlyHex =
    publicKeyHex.length === 66 ? publicKeyHex.slice(2) : publicKeyHex;
  const buf = new Uint8Array(
    xOnlyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );
  return bs58.encode(buf);
}
