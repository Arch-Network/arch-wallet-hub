import { describe, expect, it } from "vitest";
import {
  extractTapKeySigFromPsbtBase64,
  extractTapKeySigFromPsbtHex,
} from "../psbt-signature";

describe("psbt-signature helpers", () => {
  it("extracts a taproot key signature from a PSBT-like byte stream", () => {
    const sig = "11".repeat(64);
    const psbtHex = `00011340${sig}00`;

    expect(extractTapKeySigFromPsbtHex(psbtHex)).toBe(sig);
  });

  it("supports base64-encoded PSBT payloads", () => {
    const sig = "22".repeat(64);
    const bytes = Uint8Array.from(
      `00011340${sig}00`.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
    );
    const base64 = btoa(String.fromCharCode(...bytes));

    expect(extractTapKeySigFromPsbtBase64(base64)).toBe(sig);
  });
});
