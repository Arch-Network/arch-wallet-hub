/**
 * WebAuthn options shared by onboarding, recovery, and session
 * bootstrap.
 *
 * Password managers (1Password, Bitwarden) only offer a passkey when
 * the request looks like one they are allowed to answer:
 *
 *   - `rpId` must match the document origin. Production ceremonies
 *     run on https://wallet.arch.network (`passkey-hosted.ts`) because
 *     1Password only hooks https pages and iCloud Keychain will not
 *     take an extension id. This helper is the dev and extension-page
 *     fallback: there the rpId is the extension id, since 1Password
 *     treats `wallet.arch.network` on `chrome-extension://` as phishing.
 *   - Assertions must be discoverable (empty `allowCredentials`) or,
 *     if we name a credential, include the `hybrid` transport.
 *     Naming a credential with no transports makes Brave/Chrome's
 *     native passkey UI look only at platform authenticators.
 *   - Registration must not set `authenticatorAttachment: "platform"`
 *     and must not force `requireResidentKey: true` via Turnkey's
 *     defaults — both hide password-manager authenticators.
 */

import { PASSKEY_RP_ID } from "./constants";

export const PASSKEY_TRANSPORTS: AuthenticatorTransport[] = [
  "internal",
  "hybrid",
  "usb",
  "nfc",
  "ble",
];

export function effectivePasskeyRpId(): string {
  try {
    const host = globalThis.location?.hostname ?? "";
    const extensionId = typeof chrome !== "undefined" ? chrome.runtime?.id : undefined;
    if (extensionId && host === extensionId) return extensionId;
    if (host === "localhost" || host === "127.0.0.1") return "localhost";
    if (host === "wallet.arch.network") return "wallet.arch.network";
  } catch {
    /* node tests / non-browser */
  }
  return PASSKEY_RP_ID;
}

/**
 * Registration options that keep Face ID / Touch ID *and* password
 * managers on the picker. Callers must pass this object in full —
 * Turnkey defaults `requireResidentKey` to true when the field is
 * omitted.
 */
export function passkeyCreationSelection(): AuthenticatorSelectionCriteria {
  return {
    userVerification: "required",
    residentKey: "preferred",
    requireResidentKey: false,
  };
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Optional credential filter for assertions. Prefer omitting this
 * (discoverable get) so password managers can answer. When a stored
 * id is supplied, include every transport — missing `hybrid` is what
 * makes 1Password show up as "not a valid option" in Brave's native
 * passkey UI.
 */
export function passkeyAllowCredentials(
  credentialId: string | undefined | null,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!credentialId) return undefined;
  return [
    {
      type: "public-key",
      id: base64UrlToBytes(credentialId),
      transports: PASSKEY_TRANSPORTS,
    },
  ];
}
