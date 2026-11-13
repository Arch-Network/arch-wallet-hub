import { describe, it, expect } from "vitest";
import { WalletHubClient, WalletHubError } from "../client.js";

const BASE = "http://localhost:3001";
const REQUEST_ID = "4b1f6d0e-8a55-4c0e-9c1b-2f7f3a401e29";

function clientAnswering(res: () => Response, seen: Array<{ url: string; init: RequestInit }> = []) {
  return new WalletHubClient({
    baseUrl: BASE,
    apiKey: "app-key",
    fetchImpl: (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, init });
      return res();
    }) as unknown as typeof fetch,
  });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("WalletHubError", () => {
  it("carries the status and the Hub's request id, with the message unchanged", async () => {
    const client = clientAnswering(
      () =>
        new Response(JSON.stringify({ statusCode: 404, error: "Not Found", message: "Unknown resourceId" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "x-request-id": REQUEST_ID },
        }),
    );
    const err = await rejection(client.getTurnkeyConfig());
    expect(err).toBeInstanceOf(WalletHubError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: "WalletHubError",
      status: 404,
      requestId: REQUEST_ID,
      message: "WalletHub error 404 Not Found: Not Found: Unknown resourceId",
    });
  });

  it("leaves the request id unset when the response has none", async () => {
    const client = clientAnswering(() => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
    const err = (await rejection(client.getTurnkeyConfig())) as WalletHubError;
    expect(err.status).toBe(500);
    expect(err.requestId).toBeUndefined();
    expect(err.message).toBe("WalletHub error 500 Internal Server Error: boom");
  });

  it("is not used for a request that got no response", async () => {
    const client = new WalletHubClient({
      baseUrl: BASE,
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const err = await rejection(client.getTurnkeyConfig());
    expect(err).not.toBeInstanceOf(WalletHubError);
    expect((err as Error).message).toBe("WalletHub network error: Failed to fetch");
  });
});

describe("submitErrorReport", () => {
  it("posts the report text and returns the Hub's id for it", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = clientAnswering(
      () => new Response(JSON.stringify({ id: REQUEST_ID }), { status: 202, statusText: "Accepted" }),
      seen,
    );
    await expect(client.submitErrorReport({ report: "Arch Wallet error report\nError: boom" })).resolves.toEqual({
      id: REQUEST_ID,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${BASE}/v1/error-reports`);
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ report: "Arch Wallet error report\nError: boom" });
  });

  it("sends the app key but not the session token, which would say whose report it is", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = clientAnswering(() => new Response(JSON.stringify({ id: REQUEST_ID }), { status: 202 }), seen);
    client.setSessionToken("session-token");

    await client.submitErrorReport({ report: "boom" });
    await client.getTurnkeyConfig();

    const headers = seen.map(({ init }) => new Headers(init.headers));
    expect(headers[0].get("x-api-key")).toBe("app-key");
    expect(headers[0].has("authorization")).toBe(false);
    // Other requests still carry it.
    expect(headers[1].get("authorization")).toBe("Bearer session-token");
  });
});
