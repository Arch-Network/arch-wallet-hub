import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64Url,
  HostedWebauthnStamper,
  PASSKEY_CANCELLED_MESSAGE,
  PASSKEY_PAGE_URL,
  toTurnkeyTransports,
  webauthnChallengeFromStampPayload,
} from "../passkey-hosted";
import { getPasskeyWait, subscribePasskeyWait } from "../passkey-wait";

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
});

describe("waiting on the passkey window", () => {
  const windowsUpdate = vi.fn(async () => undefined);
  const windowsRemove = vi.fn(async () => undefined);
  let windowOpen = true;

  beforeEach(() => {
    windowOpen = true;
    windowsUpdate.mockClear();
    windowsRemove.mockReset();
    windowsRemove.mockImplementation(async () => {
      windowOpen = false;
      return undefined;
    });
    vi.stubGlobal("chrome", {
      windows: {
        create: vi.fn(async () => ({ id: 7, tabs: [{ id: 11 }] })),
        update: windowsUpdate,
        remove: windowsRemove,
      },
      tabs: {
        get: vi.fn(async () => ({ status: "complete", url: PASSKEY_PAGE_URL })),
      },
      scripting: {
        // The page never reports a result: the user has not answered.
        executeScript: vi.fn(async () => {
          if (!windowOpen) throw new Error("No tab with id: 11");
          return [{ result: null }];
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells the UI while the window is open, and reports a cancel as a cancel", async () => {
    const notified = vi.fn();
    const unsubscribe = subscribePasskeyWait(notified);
    const outcome = new HostedWebauthnStamper().stamp("payload").catch((err: unknown) => err);

    await vi.waitFor(() => expect(getPasskeyWait()).not.toBeNull());
    expect(notified).toHaveBeenCalledTimes(1);

    getPasskeyWait()!.focus();
    expect(windowsUpdate).toHaveBeenCalledWith(7, { focused: true });

    getPasskeyWait()!.cancel();
    const err = await outcome;
    unsubscribe();

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(PASSKEY_CANCELLED_MESSAGE);
    expect(windowsRemove).toHaveBeenCalledWith(7);
    expect(getPasskeyWait()).toBeNull();
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("still reports a window the user closed themselves as closed, not cancelled", async () => {
    const outcome = new HostedWebauthnStamper().stamp("payload").catch((err: unknown) => err);
    await vi.waitFor(() => expect(getPasskeyWait()).not.toBeNull());

    windowOpen = false;
    const err = await outcome;

    expect((err as Error).message).toBe(
      "The passkey window was closed before a passkey was chosen",
    );
    expect(getPasskeyWait()).toBeNull();
  });
});
