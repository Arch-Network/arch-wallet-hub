import { describe, it, expect, vi } from "vitest";
import { WalletHubClient } from "../client.js";
import type { SessionSigner } from "../types.js";

const BASE = "http://localhost:3001";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * Build a fetch mock that routes by pathname. Records every request
 * (path + authorization header) so tests can assert mint ordering and
 * which calls carried a bearer.
 */
function makeFetch(routes: Record<string, Handler>) {
  const calls: Array<{ path: string; auth: string | null }> = [];
  const fetchImpl = (async (urlStr: string, init: RequestInit = {}) => {
    const path = new URL(urlStr).pathname.replace(/^\/v1/, "");
    const headers = new Headers(init.headers);
    calls.push({ path, auth: headers.get("authorization") });
    const handler = routes[path];
    if (!handler) return new Response("not found", { status: 404, statusText: "Not Found" });
    return await handler(urlStr, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
    headers: { "content-type": "application/json" },
  });
}

const SIGNING_OK = {
  signingRequestId: "sr_1",
  status: "created",
  actionType: "arch.transfer",
  payloadToSign: {},
  display: {},
  displayHash: "x",
  expiresAt: null,
};

const turnkeySigner = (signChallenge = vi.fn(async () => "ab".repeat(64))): SessionSigner => ({
  kind: "turnkey",
  externalUserId: "user-1",
  turnkeyResourceId: "11111111-1111-1111-1111-111111111111",
  signChallenge,
});

const externalSigner = (signMessage = vi.fn(async () => "base64sig")): SessionSigner => ({
  kind: "external",
  externalUserId: "user-1",
  walletProvider: "xverse",
  address: "bc1ptaproot",
  signMessage,
});

describe("auto session minting (Turnkey)", () => {
  it("mints on first enforced call and attaches the token", async () => {
    const sign = vi.fn(async () => "cd".repeat(64));
    const { fetchImpl, calls } = makeFetch({
      "/auth/session/challenge": () =>
        json({ challengeId: "c1", message: "m", payloadHex: "00".repeat(32), expiresAt: "2099" }),
      "/auth/session": () => json({ sessionToken: "whs_v1_minted", expiresAt: "2099" }),
      "/signing-requests": () => json(SIGNING_OK),
    });
    const client = new WalletHubClient({
      baseUrl: BASE,
      apiKey: "k",
      sessionSigner: turnkeySigner(sign),
      fetchImpl,
    });

    const res = await client.createSigningRequest({
      externalUserId: "user-1",
      signer: { kind: "turnkey", resourceId: "r" },
      action: { type: "arch.transfer", toAddress: "a", lamports: "1" },
    });

    expect(res.signingRequestId).toBe("sr_1");
    expect(sign).toHaveBeenCalledWith("00".repeat(32));
    expect(client.hasSession()).toBe(true);
    // Mint happened before the signing call, and the signing call carried the bearer.
    expect(calls.map((c) => c.path)).toEqual([
      "/auth/session/challenge",
      "/auth/session",
      "/signing-requests",
    ]);
    expect(calls[2]!.auth).toBe("Bearer whs_v1_minted");
  });

  it("does not re-mint when a token is already present", async () => {
    const challenge = vi.fn(() =>
      json({ challengeId: "c1", message: "m", payloadHex: "00".repeat(32), expiresAt: "2099" }),
    );
    const { fetchImpl, calls } = makeFetch({
      "/auth/session/challenge": challenge,
      "/auth/session": () => json({ sessionToken: "whs_v1_x", expiresAt: "2099" }),
      "/signing-requests": () => json(SIGNING_OK),
    });
    const client = new WalletHubClient({
      baseUrl: BASE,
      sessionToken: "whs_v1_preset",
      sessionSigner: turnkeySigner(),
      fetchImpl,
    });

    await client.createSigningRequest({
      externalUserId: "user-1",
      signer: { kind: "turnkey", resourceId: "r" },
      action: { type: "arch.transfer", toAddress: "a", lamports: "1" },
    });

    expect(challenge).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toEqual(["/signing-requests"]);
    expect(calls[0]!.auth).toBe("Bearer whs_v1_preset");
  });

  it("dedupes concurrent mints into a single challenge/mint", async () => {
    let challengeCount = 0;
    const { fetchImpl } = makeFetch({
      "/auth/session/challenge": () => {
        challengeCount += 1;
        return json({ challengeId: "c1", message: "m", payloadHex: "00".repeat(32), expiresAt: "2099" });
      },
      "/auth/session": () => json({ sessionToken: "whs_v1_x", expiresAt: "2099" }),
      "/signing-requests": () => json(SIGNING_OK),
      "/btc/estimate-fee": () => json({ feeSats: 1, feeRate: 1, inputCount: 1, changeSats: 0 }),
    });
    const client = new WalletHubClient({ baseUrl: BASE, sessionSigner: turnkeySigner(), fetchImpl });

    await Promise.all([
      client.createSigningRequest({
        externalUserId: "user-1",
        signer: { kind: "turnkey", resourceId: "r" },
        action: { type: "arch.transfer", toAddress: "a", lamports: "1" },
      }),
      client.estimateBitcoinFee({
        externalUserId: "user-1",
        turnkeyResourceId: "r",
        toAddress: "a",
        amountSats: 1,
      }),
    ]);

    expect(challengeCount).toBe(1);
  });
});

describe("auto session minting (external / BIP-322)", () => {
  it("mints via the external endpoints and attaches the token", async () => {
    const sign = vi.fn(async () => "witnessblob");
    const { fetchImpl, calls } = makeFetch({
      "/auth/session/external/challenge": () =>
        json({ challengeId: "c1", message: "please-sign", expiresAt: "2099" }),
      "/auth/session/external": () => json({ sessionToken: "whs_v1_ext", expiresAt: "2099" }),
      "/signing-requests": () => json(SIGNING_OK),
    });
    const client = new WalletHubClient({ baseUrl: BASE, sessionSigner: externalSigner(sign), fetchImpl });

    await client.createSigningRequest({
      externalUserId: "user-1",
      signer: { kind: "external", taprootAddress: "bc1ptaproot" },
      action: { type: "arch.transfer", toAddress: "a", lamports: "1" },
    });

    expect(sign).toHaveBeenCalledWith("please-sign");
    expect(calls.map((c) => c.path)).toEqual([
      "/auth/session/external/challenge",
      "/auth/session/external",
      "/signing-requests",
    ]);
    expect(calls[2]!.auth).toBe("Bearer whs_v1_ext");
  });
});

describe("refresh + retry on session 401", () => {
  it("re-mints and retries once on a 'session bearer' 401", async () => {
    let signingCalls = 0;
    const { fetchImpl, calls } = makeFetch({
      "/auth/session/challenge": () =>
        json({ challengeId: "c1", message: "m", payloadHex: "00".repeat(32), expiresAt: "2099" }),
      "/auth/session": () => json({ sessionToken: "whs_v1_fresh", expiresAt: "2099" }),
      "/signing-requests": (_u, init) => {
        signingCalls += 1;
        const auth = new Headers(init.headers).get("authorization");
        if (auth === "Bearer whs_v1_stale") {
          return json(
            { statusCode: 401, error: "Unauthorized", message: "Invalid or expired session token" },
            401,
          );
        }
        return json(SIGNING_OK);
      },
    });
    const client = new WalletHubClient({
      baseUrl: BASE,
      sessionToken: "whs_v1_stale",
      sessionSigner: turnkeySigner(),
      fetchImpl,
    });

    const res = await client.createSigningRequest({
      externalUserId: "user-1",
      signer: { kind: "turnkey", resourceId: "r" },
      action: { type: "arch.transfer", toAddress: "a", lamports: "1" },
    });

    expect(res.signingRequestId).toBe("sr_1");
    expect(signingCalls).toBe(2); // initial 401 + one retry
    const retried = calls.filter((c) => c.path === "/signing-requests");
    expect(retried[1]!.auth).toBe("Bearer whs_v1_fresh");
  });

  it("does NOT retry a non-session 401 (e.g. bad app key)", async () => {
    let challengeCount = 0;
    let signingCalls = 0;
    const { fetchImpl } = makeFetch({
      "/auth/session/challenge": () => {
        challengeCount += 1;
        return json({ challengeId: "c1", message: "m", payloadHex: "00".repeat(32), expiresAt: "2099" });
      },
      "/auth/session": () => json({ sessionToken: "whs_v1_fresh", expiresAt: "2099" }),
      "/signing-requests": () => {
        signingCalls += 1;
        return json({ statusCode: 401, error: "Unauthorized", message: "Invalid API key" }, 401);
      },
    });
    const client = new WalletHubClient({ baseUrl: BASE, sessionSigner: turnkeySigner(), fetchImpl });

    await expect(
      client.createSigningRequest({
        externalUserId: "user-1",
        signer: { kind: "turnkey", resourceId: "r" },
        action: { type: "arch.transfer", toAddress: "a", lamports: "1" },
      }),
    ).rejects.toThrow(/401/);
    // It minted once pre-flight, but the app-key 401 is not retried.
    expect(signingCalls).toBe(1);
    expect(challengeCount).toBe(1);
  });
});

describe("backward compatibility", () => {
  it("without a signer, an enforced call proceeds with the explicit token and does not loop on 401", async () => {
    let signingCalls = 0;
    const { fetchImpl } = makeFetch({
      "/signing-requests": () => {
        signingCalls += 1;
        return json({ statusCode: 401, error: "Unauthorized", message: "Missing or malformed session bearer" }, 401);
      },
    });
    const client = new WalletHubClient({ baseUrl: BASE, sessionToken: "whs_v1_x", fetchImpl });

    await expect(
      client.createSigningRequest({
        externalUserId: "user-1",
        signer: { kind: "turnkey", resourceId: "r" },
        action: { type: "arch.transfer", toAddress: "a", lamports: "1" },
      }),
    ).rejects.toThrow(/401/);
    expect(signingCalls).toBe(1); // no signer -> no retry loop
  });

  it("non-enforced routes never mint", async () => {
    const challenge = vi.fn();
    const { fetchImpl, calls } = makeFetch({
      "/auth/session/challenge": challenge as unknown as Handler,
      "/signing-requests/sr_1": () =>
        json({
          signingRequestId: "sr_1",
          status: "created",
          actionType: "arch.transfer",
          payloadToSign: {},
          display: {},
          displayHash: "x",
          result: null,
          error: null,
          expiresAt: null,
          createdAt: "t",
          updatedAt: "t",
          readiness: { status: "ready" },
        }),
    });
    const client = new WalletHubClient({ baseUrl: BASE, sessionSigner: turnkeySigner(), fetchImpl });

    await client.getSigningRequest("sr_1");
    expect(challenge).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toEqual(["/signing-requests/sr_1"]);
  });
});
