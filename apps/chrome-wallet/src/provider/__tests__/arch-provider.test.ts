/**
 * Provider-level smoke tests for the `window.arch` surface. Focused
 * specifically on `signArchMessageHash`, which is the new local-signing
 * primitive: dapps with custom Arch programs feed in a 32-byte
 * SanitizedMessage hash, the wallet wraps + Schnorr-signs it locally,
 * and returns 64-byte (r||s) hex.
 *
 * Strategy
 * --------
 *   - The provider talks to the background through an RpcChannel that
 *     calls `window.postMessage` / `addEventListener`. Vitest runs in
 *     a `node` environment, so we install a minimal window stub before
 *     importing the module. The stub captures every outgoing request
 *     and lets the test synthesize an "incoming" response.
 *   - We assert (a) input validation rejects non-32-byte payloads
 *     synchronously and (b) the request put on the wire matches the
 *     contract the background handler enforces (`SIGN_ARCH_MESSAGE_HASH`
 *     + lowercase 64-char hex payload).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type Listener = (event: { source: unknown; origin: string; data: unknown }) => void;

interface WindowStub {
  location: { origin: string };
  postMessage: (data: unknown, origin: string) => void;
  addEventListener: (type: string, cb: Listener) => void;
  removeEventListener: (type: string, cb: Listener) => void;
  // Self-reference so the channel's `event.source !== window` filter passes.
  self: WindowStub;
}

const messageListeners = new Set<Listener>();
const sentRequests: { data: any; origin: string }[] = [];

function makeWindowStub(): WindowStub {
  const win: WindowStub = {
    location: { origin: "https://dapp.example" },
    postMessage(data, origin) {
      sentRequests.push({ data, origin });
    },
    addEventListener(type, cb) {
      if (type === "message") messageListeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === "message") messageListeners.delete(cb);
    },
    self: undefined as unknown as WindowStub,
  };
  win.self = win;
  return win;
}

beforeAll(() => {
  const stub = makeWindowStub();
  (globalThis as any).window = stub;
});

afterEach(() => {
  messageListeners.clear();
  sentRequests.length = 0;
});

/** Drive a synthetic "to-page" response into the channel's listener. */
function dispatchResponse(id: string, response: { success: boolean; data?: unknown; error?: string }) {
  const win = (globalThis as any).window as WindowStub;
  for (const cb of messageListeners) {
    cb({
      source: win,
      origin: win.location.origin,
      data: { channel: "arch-wallet-provider", direction: "to-page", id, response },
    });
  }
}

// Importing the module here (after window is installed) so the
// internal RpcChannel binds its `pageOrigin` to our stub origin.
async function loadProvider() {
  // Lazy-import so the stub is in place first; reset modules between
  // tests so each call gets a fresh channel + listener slot.
  vi.resetModules();
  return (await import("../arch-provider")).archProvider;
}

describe("archProvider.signArchMessageHash", () => {
  it("rejects payloads that are not 32 bytes", async () => {
    const provider = await loadProvider();

    // Too short.
    await expect(
      provider.signArchMessageHash(new Uint8Array(31)),
    ).rejects.toThrow(/32-byte hash/);

    // Too long.
    await expect(
      provider.signArchMessageHash(new Uint8Array(33)),
    ).rejects.toThrow(/32-byte hash/);

    // Empty.
    await expect(
      provider.signArchMessageHash(new Uint8Array(0)),
    ).rejects.toThrow(/32-byte hash/);

    // No request was put on the wire for any of these.
    expect(sentRequests).toHaveLength(0);
  });

  it("posts a SIGN_ARCH_MESSAGE_HASH request with lowercase-hex payload", async () => {
    const provider = await loadProvider();

    // 32-byte hash: 0x00, 0x01, 0x02, ..., 0x1f.
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash[i] = i;

    const expectedHex =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    const pending = provider.signArchMessageHash(hash);

    // The channel sent exactly one message, with the wire shape the
    // background handler matches against (case-sensitive regex).
    expect(sentRequests).toHaveLength(1);
    const outgoing = sentRequests[0].data as {
      channel: string;
      direction: string;
      payload: { type: string; id: string; payload: { messageHashHex: string } };
    };
    expect(outgoing.channel).toBe("arch-wallet-provider");
    expect(outgoing.direction).toBe("to-extension");
    expect(outgoing.payload.type).toBe("SIGN_ARCH_MESSAGE_HASH");
    expect(outgoing.payload.payload.messageHashHex).toBe(expectedHex);

    // Resolve the in-flight promise so vitest doesn't complain about an
    // unhandled rejection on the channel's 120s timeout.
    dispatchResponse(outgoing.payload.id, {
      success: true,
      data: { signature64Hex: "ab".repeat(64) },
    });

    const result = await pending;
    expect(result).toEqual({ signature64Hex: "ab".repeat(64) });
  });

  it("propagates wallet-side errors verbatim", async () => {
    const provider = await loadProvider();
    const hash = new Uint8Array(32);
    const pending = provider.signArchMessageHash(hash);

    // Drain the outgoing request and reply with an error response.
    expect(sentRequests).toHaveLength(1);
    const outgoing = sentRequests[0].data as { payload: { id: string } };
    dispatchResponse(outgoing.payload.id, {
      success: false,
      error: "Site not connected",
    });

    await expect(pending).rejects.toThrow("Site not connected");
  });
});
