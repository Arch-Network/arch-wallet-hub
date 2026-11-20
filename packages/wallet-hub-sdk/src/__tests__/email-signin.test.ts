import { describe, expect, it } from "vitest";
import { WalletHubClient } from "../client.js";

const BASE = "http://localhost:3001";

function clientFor(routes: Record<string, unknown>) {
  const calls: Array<{ path: string; body: unknown; network: string | null }> = [];
  const fetchImpl = (async (urlStr: string, init: RequestInit = {}) => {
    const url = new URL(urlStr);
    const path = url.pathname.replace(/^\/v1/, "");
    const headers = new Headers(init.headers);
    calls.push({
      path,
      body: init.body ? JSON.parse(String(init.body)) : null,
      network: headers.get("x-network"),
    });
    const body = routes[path];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new WalletHubClient({ baseUrl: BASE, network: "mainnet", fetchImpl });
  return { client, calls };
}

describe("email sign-in client", () => {
  it("posts the email, then the encrypted code, and sends the wallet network", async () => {
    const { client, calls } = clientFor({
      "/recovery/email/signin": {
        challengeId: "chal-1",
        otpEncryptionTargetBundle: "target",
        emailMasked: "a***@example.com",
        expiresAt: "2026-11-20T05:00:00.000Z",
      },
      "/recovery/email/signin/verify": {
        verificationToken: "token",
        organizationId: "org",
        resourceId: "resource-1",
        sessionToken: "whs_v1_token",
        authMethod: "email",
      },
    });

    const started = await client.startEmailSignIn({ email: "ada@example.com" });
    const verified = await client.verifyEmailSignIn({
      challengeId: started.challengeId,
      encryptedOtpBundle: "bundle",
    });

    expect(calls.map((c) => c.path)).toEqual([
      "/recovery/email/signin",
      "/recovery/email/signin/verify",
    ]);
    expect(calls[0]?.body).toEqual({ email: "ada@example.com" });
    expect(calls[1]?.body).toEqual({ challengeId: "chal-1", encryptedOtpBundle: "bundle" });
    expect(calls.every((c) => c.network === "mainnet")).toBe(true);
    expect(verified.resourceId).toBe("resource-1");
  });
});
