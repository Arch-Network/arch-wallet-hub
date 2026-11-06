import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bytesToBase64Url,
  toTurnkeyTransports,
  webauthnChallengeFromStampPayload,
} from "../passkey-hosted";

const source = readFileSync(fileURLToPath(new URL("../passkey-hosted.ts", import.meta.url)), "utf8");

describe("passkey ceremony encoding", () => {
  it("maps browser transports onto Turnkey's enum and keeps a fallback", () => {
    expect(toTurnkeyTransports(["internal", "hybrid", "nope"])).toEqual([
      "AUTHENTICATOR_TRANSPORT_INTERNAL",
      "AUTHENTICATOR_TRANSPORT_HYBRID",
    ]);
    expect(toTurnkeyTransports([])).toEqual(["AUTHENTICATOR_TRANSPORT_INTERNAL"]);
  });

  it("encodes the stamp challenge as the utf-8 bytes of the sha256 hex", async () => {
    const challenge = await webauthnChallengeFromStampPayload("abc");
    expect(challenge.length).toBe(64);
    expect(new TextDecoder().decode(challenge)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("base64url-encodes without padding", () => {
    expect(bytesToBase64Url(new Uint8Array([0xff, 0xef, 0x00]))).toBe("_-8A");
  });

  it("builds the ceremony with HTML elements so the XML error page can show them", () => {
    const body = source.slice(source.indexOf("function installPasskeyCeremony"));
    expect(body).toContain('document.createElementNS("http://www.w3.org/1999/xhtml"');
    expect(body).not.toContain("document.createElement(");
  });
});
