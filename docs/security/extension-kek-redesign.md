# Extension KEK in-memory redesign (design)

Status: **proposed** — design only, no code change yet. This is the
careful precursor to a crypto-core refactor that warrants review before
implementation.

## Vulnerability

`apps/chrome-wallet/src/crypto/keystore.ts` derives a 256-bit AES-GCM
Key-Encryption-Key (KEK) from the user's password (PBKDF2, 600k iters)
and uses it to encrypt the wallet state blob in `chrome.storage.local`.
The KEK is held in the service-worker's in-memory `sessionKey` **and**
mirrored, raw and `extractable`, into `chrome.storage.session`
(`saveSessionKey` → `exportKeyBase64`, keystore.ts:143-152).

Any code running in an **extension page context** (popup, sidepanel, an
options page, or a compromised dependency executing in one of those
realms) can call `chrome.storage.session.get("arch_wallet_session_key")`,
import the raw key, and decrypt the entire wallet state — keys, linked
wallets, everything — for as long as the wallet is unlocked. The KEK is
the crown jewel and it is sitting in cleartext (base64) in a store that
every extension realm can read.

Note on scope: `chrome.storage.session` defaults to the
`TRUSTED_CONTEXTS` access level, so **content scripts and web pages
cannot read it** — the exposure is to extension-page contexts, i.e. an
XSS/compromise inside our own UI or a malicious/compromised bundled
dependency, not arbitrary websites.

## Why it's there

The popup/sidepanel run in **different JS realms** from the service
worker. The current keystore module is imported directly by both, and
each realm needs the KEK to `read()`/`write()` state. In-memory state
isn't shared across realms, so `chrome.storage.session` is used as the
shared cache to avoid re-prompting for the password in every realm.

`chrome.storage.session` is browser-session-scoped (cleared on browser
restart, never written to disk), which is why it was chosen over
`local`. But it is still readable by every extension realm.

## Goal

The KEK must exist **only in the service-worker's memory** and never be
written to any `chrome.storage` area. UI realms must never hold the KEK;
they obtain plaintext state (or commit writes) by **messaging the SW**,
which is the only context that can encrypt/decrypt.

## Options considered

### A. SW-owned crypto, message-passing for the UI (recommended)

- Move all `seal/unlock/read/write/lock/changePassword` so the KEK only
  ever lives in the SW's `sessionKey` variable. Remove `saveSessionKey`/
  `loadSessionKeyFromStorage`/`exportKeyBase64`/`importKeyBase64` and the
  `SESSION_KEY_KEY` storage entirely.
- The popup/sidepanel call new SW messages (e.g. `KEYSTORE_UNLOCK`,
  `KEYSTORE_READ`, `KEYSTORE_WRITE`, `KEYSTORE_LOCK`) guarded by
  `isInternalUiSender` (see entrypoints/background.ts). The SW returns
  **plaintext state** to trusted UI realms but never the KEK.
- Make the derived `CryptoKey` **non-extractable** (`deriveKey(...,
  extractable=false, ...)`) since it no longer needs to be exported.

**Tradeoff (must be decided):** MV3 service workers are terminated when
idle. When the SW restarts, in-memory `sessionKey` is gone, so the
wallet effectively **re-locks and the user must re-enter the password**.
Today's `chrome.storage.session` mirror is precisely what avoids that.
Mitigations:
  - Accept re-prompt on SW eviction (simplest, most secure). Pair with
    the existing auto-lock so the UX delta is "you re-enter your password
    after long idle" — acceptable for a wallet.
  - Keep the SW alive during active use (e.g. a port from an open popup,
    periodic alarms) to reduce eviction frequency. Does not eliminate
    re-prompts but makes them rare.

### B. Store a wrapped KEK in session storage

Encrypt the KEK with a second key. Rejected: any unwrapping key must be
available to the same SW context, so storing the wrapped KEK in a store
readable by UI realms doesn't help — either the UI can unwrap (no gain)
or only the SW can (then there's no reason to store it at all → that's
option A).

### C. Status quo + shorten exposure window

Keep the mirror but reduce TTL / clear aggressively. Rejected: does not
address the core issue (raw KEK readable while unlocked).

## Recommended migration (one reviewable PR, behind tests)

1. Refactor `keystore.ts`: remove the session-storage KEK mirror; make
   the KEK non-extractable; keep `sessionKey` SW-memory-only.
2. Add SW message handlers (`KEYSTORE_*`) in `entrypoints/background.ts`,
   restricted to `isInternalUiSender`.
3. Introduce a thin client (`crypto/keystore-client.ts`) the UI realms
   call instead of importing `keystore` directly; it round-trips via
   `chrome.runtime.sendMessage`. Audit every `keystore.*` / `walletStore`
   call site to route through it.
4. Decide and implement the SW-lifecycle policy (re-prompt vs keepalive).
5. Tests: unlock → read/write → lock; SW-restart simulation; auto-lock;
   change-password; migration from a legacy `arch_wallet_session_key`
   entry (delete it on first unlock).

## Test / acceptance criteria

- `chrome.storage.session` never contains the KEK (grep + runtime check).
- The derived `CryptoKey` is non-extractable.
- UI realms never import the raw KEK; all crypto goes through the SW.
- Existing vitest suites pass; new tests cover unlock/read/write/lock and
  the SW-restart re-lock behavior.

## Why this is a design doc, not a patch

This touches the wallet's crypto core across two realms and carries a
real UX tradeoff (SW eviction → re-prompt) that needs a product call.
Shipping it requires its own focused PR with the message-passing layer,
call-site audit, and the test matrix above — not a tail-end change folded
into a larger batch.
