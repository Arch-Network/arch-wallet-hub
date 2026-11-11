/**
 * Run WebAuthn on https://wallet.arch.network, not in the extension page.
 *
 * 1Password only hooks `navigator.credentials` on https and localhost
 * pages. It never sees a prompt that starts at `chrome-extension://`.
 * iCloud Keychain likewise wants a real domain as the relying party
 * id. A security key does not, which is why a YubiKey still answered
 * inside the extension while Keychain and 1Password did not.
 *
 * The static page is intentionally empty. This module injects the
 * button and the WebAuthn call so the request cannot drift from the
 * Turnkey attestation / stamp shapes below. The click is the user
 * gesture those prompts require.
 *
 * 1Password will not inject into the XML error document S3 returns
 * when passkey.html is missing. public/rules/passkey-page.json forces
 * that response to text/html so the content script still attaches.
 * The real HTML file should still be published when the bucket is writable.
 */

import { Turnkey, TurnkeyPasskeyClient, type TStamper } from "@turnkey/sdk-browser";
import { WebauthnStamper } from "@turnkey/webauthn-stamper";
import { PASSKEY_RP_ID } from "./constants";
import { effectivePasskeyRpId, passkeyCreationSelection } from "./passkey-webauthn";
import { withWalletWindowHeld } from "../utils/wallet-autoclose";
import { getPasskeyWait, setPasskeyWait, type PasskeyWait } from "./passkey-wait";

export const PASSKEY_PAGE_URL = "https://wallet.arch.network/passkey.html";

/**
 * Link under Continue on the confirm page. It retries under the
 * extension id, where builds before the hosted page saved passkeys.
 */
export const PASSKEY_NOT_LISTED_LABEL = "My passkey isn't listed";

export const PASSKEY_CANCELLED_MESSAGE = "Passkey confirmation was cancelled.";

const CEREMONY_TIMEOUT_MS = 170_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;

export function usesHostedPasskeyPage(): boolean {
  return PASSKEY_RP_ID === "wallet.arch.network";
}

export interface TurnkeyPasskeyRegistration {
  encodedChallenge: string;
  attestation: {
    credentialId: string;
    attestationObject: string;
    clientDataJson: string;
    transports: string[];
  };
}

export interface CreateArchPasskeyArgs {
  apiBaseUrl: string;
  organizationId: string;
  userName: string;
  displayName: string;
}

const TURNKEY_TRANSPORTS: Record<string, string> = {
  internal: "AUTHENTICATOR_TRANSPORT_INTERNAL",
  usb: "AUTHENTICATOR_TRANSPORT_USB",
  nfc: "AUTHENTICATOR_TRANSPORT_NFC",
  ble: "AUTHENTICATOR_TRANSPORT_BLE",
  hybrid: "AUTHENTICATOR_TRANSPORT_HYBRID",
};

export function toTurnkeyTransports(transports: readonly string[] | undefined): string[] {
  const source = transports?.length ? transports : ["internal"];
  const mapped = source
    .map((transport) => TURNKEY_TRANSPORTS[transport])
    .filter((transport): transport is string => !!transport);
  return mapped.length > 0 ? mapped : ["AUTHENTICATOR_TRANSPORT_INTERNAL"];
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Same challenge bytes `@turnkey/webauthn-stamper` signs over. */
export async function webauthnChallengeFromStampPayload(payload: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new TextEncoder().encode(hex);
}

interface CreateCeremonyRequest {
  kind: "create";
  rpId: string;
  rpName: string;
  userName: string;
  displayName: string;
  challenge: number[];
  userId: number[];
  allowExtensionFallback: boolean;
}

interface GetCeremonyRequest {
  kind: "get";
  rpId: string;
  challenge: number[];
  allowExtensionFallback: boolean;
  /** The page function cannot read module constants, so the label rides along. */
  fallbackLabel: string;
}

type CeremonyRequest = CreateCeremonyRequest | GetCeremonyRequest;

type CeremonyResult =
  | {
      status: "create";
      rawId: string;
      attestationObject: string;
      clientDataJson: string;
      transports: string[];
    }
  | {
      status: "get";
      authenticatorData: string;
      clientDataJson: string;
      credentialId: string;
      signature: string;
    }
  | { status: "extension" }
  | { status: "error"; message: string };

export async function createArchPasskey(
  args: CreateArchPasskeyArgs,
): Promise<TurnkeyPasskeyRegistration> {
  if (!usesHostedPasskeyPage()) {
    return withWalletWindowHeld(() => createPasskeyLocally(args));
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(32));
  const result = await runHostedPasskey({
    kind: "create",
    rpId: PASSKEY_RP_ID,
    rpName: "Arch Wallet",
    userName: args.userName,
    displayName: args.displayName,
    challenge: Array.from(challenge),
    userId: Array.from(userId),
    allowExtensionFallback: false,
  });
  if (result.status !== "create") {
    throw new Error(
      result.status === "error" ? result.message : "Passkey creation did not finish",
    );
  }
  return {
    encodedChallenge: bytesToBase64Url(challenge),
    attestation: {
      credentialId: result.rawId,
      attestationObject: result.attestationObject,
      clientDataJson: result.clientDataJson,
      transports: toTurnkeyTransports(result.transports),
    },
  };
}

async function createPasskeyLocally(
  args: CreateArchPasskeyArgs,
): Promise<TurnkeyPasskeyRegistration> {
  const rpId = effectivePasskeyRpId();
  const tk = new Turnkey({
    apiBaseUrl: args.apiBaseUrl,
    defaultOrganizationId: args.organizationId,
    rpId,
  });
  return tk.passkeyClient().createUserPasskey({
    publicKey: {
      rp: { id: rpId, name: "Arch Wallet" },
      user: { name: args.userName, displayName: args.displayName },
      authenticatorSelection: passkeyCreationSelection(),
    },
  });
}

/**
 * Stamper whose WebAuthn assertion happens on wallet.arch.network.
 * The PASSKEY_NOT_LISTED_LABEL link falls back to the extension id,
 * for a passkey registered before this page existed.
 */
export class HostedWebauthnStamper implements TStamper {
  async stamp(payload: string) {
    const challenge = await webauthnChallengeFromStampPayload(payload);
    const result = await runHostedPasskey({
      kind: "get",
      rpId: PASSKEY_RP_ID,
      challenge: Array.from(challenge),
      allowExtensionFallback: true,
      fallbackLabel: PASSKEY_NOT_LISTED_LABEL,
    });
    if (result.status === "extension") {
      const extensionId = chrome.runtime?.id;
      if (!extensionId) throw new Error("This browser did not report an extension id");
      return new WebauthnStamper({
        rpId: extensionId,
        userVerification: "required",
        timeout: CEREMONY_TIMEOUT_MS,
      }).stamp(payload);
    }
    if (result.status !== "get") {
      throw new Error(result.status === "error" ? result.message : "Passkey confirmation did not finish");
    }
    return {
      stampHeaderName: "X-Stamp-Webauthn",
      stampHeaderValue: JSON.stringify({
        authenticatorData: result.authenticatorData,
        clientDataJson: result.clientDataJson,
        credentialId: result.credentialId,
        signature: result.signature,
      }),
    };
  }
}

export function hostedPasskeyClient(organizationId: string, apiBaseUrl: string): TurnkeyPasskeyClient {
  return new TurnkeyPasskeyClient({
    stamper: new HostedWebauthnStamper(),
    apiBaseUrl,
    organizationId,
  });
}

async function runHostedPasskey(request: CeremonyRequest): Promise<CeremonyResult> {
  return withWalletWindowHeld(async () => {
    const opened = await openPasskeyPage();
    let cancelled = false;
    const wait: PasskeyWait = {
      focus: () => void focusPasskeyPage(opened),
      cancel: () => {
        cancelled = true;
        void closePasskeyPage(opened);
      },
    };
    setPasskeyWait(wait);
    try {
      await waitForPasskeyPage(opened.tabId);
      await chrome.scripting.executeScript({
        target: { tabId: opened.tabId },
        world: "MAIN",
        func: installPasskeyCeremony,
        args: [request],
      });
      const started = Date.now();
      for (;;) {
        if (cancelled) throw new Error(PASSKEY_CANCELLED_MESSAGE);
        if (Date.now() - started > CEREMONY_TIMEOUT_MS) {
          throw new Error("Timed out waiting for a passkey");
        }
        let result: unknown;
        try {
          const [injected] = await chrome.scripting.executeScript({
            target: { tabId: opened.tabId },
            world: "MAIN",
            func: () =>
              (window as unknown as { __archPasskeyResult?: CeremonyResult }).__archPasskeyResult ??
              null,
          });
          result = injected?.result ?? null;
        } catch {
          throw new Error("The passkey window was closed before a passkey was chosen");
        }
        if (result && typeof result === "object" && "status" in result) {
          return result as CeremonyResult;
        }
        await delay(250);
      }
    } catch (err) {
      // Cancelling closes the window, so whichever call was in flight
      // fails with its own "window is gone" error. Report the cancel.
      if (cancelled) throw new Error(PASSKEY_CANCELLED_MESSAGE);
      throw err;
    } finally {
      if (getPasskeyWait() === wait) setPasskeyWait(null);
      await closePasskeyPage(opened);
    }
  });
}

async function focusPasskeyPage(opened: { tabId: number; windowId?: number }): Promise<void> {
  try {
    if (opened.windowId != null) await chrome.windows.update(opened.windowId, { focused: true });
    else await chrome.tabs.update(opened.tabId, { active: true });
  } catch {
    /* the window is already gone; the poll reports that */
  }
}

async function openPasskeyPage(): Promise<{ tabId: number; windowId?: number }> {
  if (chrome.windows?.create) {
    try {
      const win = await chrome.windows.create({
        url: PASSKEY_PAGE_URL,
        type: "popup",
        focused: true,
        width: 440,
        height: 640,
      });
      const tabId = win?.tabs?.[0]?.id ?? (win?.id != null
        ? (await chrome.tabs.query({ windowId: win.id }))[0]?.id
        : undefined);
      if (tabId != null) return { tabId, windowId: win?.id };
      if (win?.id != null) {
        try {
          await chrome.windows.remove(win.id);
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* popup windows are unavailable; open a tab instead */
    }
  }
  const tab = await chrome.tabs.create({ url: PASSKEY_PAGE_URL, active: true });
  if (tab.id == null) throw new Error("Could not open the passkey page");
  return { tabId: tab.id };
}

async function waitForPasskeyPage(tabId: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      if (!tab.url?.startsWith("https://wallet.arch.network/")) {
        throw new Error("Passkey page opened on an unexpected site");
      }
      return;
    }
    if (Date.now() - started > PAGE_LOAD_TIMEOUT_MS) {
      throw new Error("The passkey page did not load. Check your connection and try again.");
    }
    await delay(150);
  }
}

async function closePasskeyPage(opened: { tabId: number; windowId?: number }): Promise<void> {
  try {
    if (opened.windowId != null) await chrome.windows.remove(opened.windowId);
    else await chrome.tabs.remove(opened.tabId);
  } catch {
    /* the user already closed it */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialized into the wallet.arch.network page. Must not close over
 * extension modules: Chrome calls this function in the page world.
 */
function installPasskeyCeremony(request: CeremonyRequest): void {
  const root = document.createElement("div");
  root.style.cssText =
    "font-family:system-ui,sans-serif;background:#0e0f12;color:#f4f4f5;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;";
  const card = document.createElement("div");
  card.style.cssText = "max-width:380px;";
  const title = document.createElement("h1");
  title.textContent = "Confirm your passkey";
  title.style.cssText = "font-size:20px;margin:0 0 8px;";
  const copy = document.createElement("p");
  copy.textContent =
    "Choose iCloud Keychain, 1Password, or a security key. This page is wallet.arch.network, which those providers require.";
  copy.style.cssText = "font-size:14px;line-height:1.45;margin:0 0 16px;color:#d4d4d8;";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Continue";
  button.style.cssText =
    "background:#f97316;color:#111;border:0;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:650;cursor:pointer;";
  const error = document.createElement("p");
  error.style.cssText = "font-size:13px;color:#fca5a5;min-height:1.2em;margin:12px 0 0;";
  card.append(title, copy, button, error);
  if (request.kind === "get" && request.allowExtensionFallback) {
    const fallback = document.createElement("button");
    fallback.type = "button";
    fallback.textContent = request.fallbackLabel;
    fallback.style.cssText =
      "display:block;margin-top:14px;background:transparent;color:#d4d4d8;border:0;padding:0;font-size:13px;text-decoration:underline;cursor:pointer;";
    fallback.addEventListener("click", () => {
      (window as unknown as { __archPasskeyResult?: { status: "extension" } }).__archPasskeyResult =
        { status: "extension" };
    });
    card.append(fallback);
  }
  root.append(card);
  if (!document.body) {
    document.documentElement.append(document.createElement("body"));
  }
  document.body.replaceChildren(root);
  document.body.style.margin = "0";

  const toBase64Url = (value: ArrayBuffer) => {
    const bytes = new Uint8Array(value);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    error.textContent = "";
    try {
      const challenge = new Uint8Array(request.challenge);
      if (request.kind === "create") {
        const credential = (await navigator.credentials.create({
          publicKey: {
            rp: { id: request.rpId, name: request.rpName },
            challenge,
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            user: {
              id: new Uint8Array(request.userId),
              name: request.userName,
              displayName: request.displayName,
            },
            authenticatorSelection: {
              residentKey: "preferred",
              requireResidentKey: false,
              userVerification: "required",
            },
            timeout: 300_000,
          },
        })) as PublicKeyCredential | null;
        if (!credential) throw new Error("No passkey was created");
        const attestation = credential.response as AuthenticatorAttestationResponse;
        (window as unknown as { __archPasskeyResult?: CeremonyResult }).__archPasskeyResult = {
          status: "create",
          rawId: toBase64Url(credential.rawId),
          attestationObject: toBase64Url(attestation.attestationObject),
          clientDataJson: toBase64Url(attestation.clientDataJSON),
          transports: attestation.getTransports?.() ?? [],
        };
        return;
      }
      const credential = (await navigator.credentials.get({
        publicKey: {
          rpId: request.rpId,
          challenge,
          userVerification: "required",
          timeout: 300_000,
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error("No passkey was selected");
      const assertion = credential.response as AuthenticatorAssertionResponse;
      (window as unknown as { __archPasskeyResult?: CeremonyResult }).__archPasskeyResult = {
        status: "get",
        authenticatorData: toBase64Url(assertion.authenticatorData),
        clientDataJson: toBase64Url(assertion.clientDataJSON),
        credentialId: credential.id,
        signature: toBase64Url(assertion.signature),
      };
    } catch (err) {
      button.disabled = false;
      const message = err instanceof Error ? err.message : "The passkey prompt was dismissed";
      error.textContent = /not allowed|timed out|abort/i.test(message)
        ? "The passkey prompt was dismissed. Continue to try again."
        : message;
    }
  });
}
