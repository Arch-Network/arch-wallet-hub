# Handoff: Arch Prime signing 401 + reset-to-connect-screen

**Audience:** Arch Prime web dapp engineers (the app at `arch-swap-nine.vercel.app`).
**From:** Wallet Hub / Chrome extension team.
**You do not need access to our repo to act on this** — everything you need is below.

## 1. Summary

A user ("Abhay") connected a wallet through our Chrome extension while using Arch
Prime, then tried to approve a **Sign Message** request. The extension popup showed
*"Wallet Hub rejected the API key…"*, and when he **retried**, the Arch Prime UI
showed nothing and **bounced him back to the connect-wallet screen**, losing his
session.

There are **two distinct problems** here, and they live in different places:

1. **A 401 on the sign path** (our side). The underlying failure is an HTTP `401`
   from the Wallet Hub because the signing call had no valid Hub *session token*.
   Our extension also currently **mislabels** that 401 as an "API key" error. Both
   are being fixed on our side — see section 3. **No action needed from you here.**
2. **An over-aggressive disconnect-on-error** (your side, most likely). When the
   sign request fails with the 401, the Arch Prime UI appears to treat the
   wallet/session as invalid and **resets to the connect screen**. A failed sign is
   a transient, recoverable action failure — it should not tear down the connection.
   **This is the part we need Arch Prime to fix** — see section 4.

## 2. What's happening end-to-end

The request flow for a Sign Message (and similarly for transfers) is:

```
Arch Prime dapp  →  Chrome extension  →  Wallet Hub API
                                         signing-requests.create
                                         signing-requests.submit
```

The Hub routes `signing-requests.create` and `signing-requests.submit` are part of
the Hub's **session-enforced** set. When the caller presents a valid app API key but
**no (or expired) Hub session bearer token**, the Hub rejects the call with:

```
HTTP 401  "Missing or malformed session bearer"
```

**Why session enforcement exists (briefly):** historically these routes trusted a
client-supplied user id to decide *who* is acting, which means anyone holding the
shared app API key could act as any user (an impersonation / IDOR risk). The session
token binds each money/signing request to a **cryptographically verified wallet
session** instead of trusting a client-supplied id. So the money/signing routes now
require a per-user session bearer in addition to the app key.

The net effect for the user: if the extension hasn't attached a valid Hub session
token at sign time, the Hub returns 401, and that 401 is what bubbles up into the UI.

### Benign logs you can ignore

If you're staring at the console while reproducing, these are **not** the cause and
**not** errors:

- `[WalletConnect] identity_resolved`
- `token_accounts_creation_recovered { reason: 'post_verify' }`

These come from the `arch-swap-engine` package and just indicate that
onboarding / associated-token-account verification succeeded. They are noise relative
to this bug.

## 3. What we're fixing on our side (so you don't duplicate it)

- **(a) Mint + attach a Hub session token on the dapp-sign path.** The extension will
  mint a Hub session token for Turnkey wallets and attach it as the `Authorization`
  bearer when it relays the dapp's sign/transfer to the Hub, so
  `signing-requests.create/submit` get a valid session and stop 401-ing.
- **(b) Stop mislabeling session-401s as API-key errors.** The
  *"Wallet Hub rejected the API key…"* string is wrong for this case; the extension
  will distinguish a session 401 (`"Missing or malformed session bearer"`) from an
  actual app-key/config problem and message accordingly.
- **(c) External-wallet posture (open decision, FYI).** External wallets
  (e.g. Xverse / UniSat) currently **cannot** mint a Hub session token, so they would
  hit the same 401 on enforced routes. We may temporarily exempt those wallets from
  enforcement until they can mint a session. We'll keep you posted; it doesn't change
  the asks below.

## 4. What Arch Prime should change (the asks)

Framed as "most likely / please verify" since we can't see your code — but the
disconnect behavior is on the Arch Prime side (we confirmed there is no
disconnect-on-error path in our shared engine; only a `providerId` type lives there).

- **Do NOT disconnect / reset to the connect-wallet screen on a transient signing
  error or 401.** Treat a failed sign as a **failed action**, keep the wallet
  connected, and offer a **retry**. The user shouldn't lose their connection because
  one sign attempt failed on a recoverable error.
- **Surface an actionable, differentiated error** to the user. Distinguish between:
  - *session expired / please re-unlock your wallet in the extension* (the 401 case),
  - *wallet disconnected* (genuine disconnect), and
  - *bad API key / configuration* (a real config error).
  Today these appear to collapse into a single "something's wrong → reconnect" path.
- **Optional, nicer UX:** detect the specific 401 shape
  `"Missing or malformed session bearer"` and prompt the user to **re-unlock their
  wallet in the extension** (which lets the extension mint a fresh session token),
  rather than forcing a full reconnect.

## 5. How to reproduce

1. Connect a **Turnkey** wallet to Arch Prime via the Chrome extension.
2. Get into a state where the Hub **session token is absent or expired** (e.g. let it
   age out, or use a build/path where the extension hasn't attached one).
3. Trigger a **Sign Message** (or a transfer) from Arch Prime and approve it.
4. **Observe:** the call returns `401 "Missing or malformed session bearer"`, and the
   Arch Prime UI **resets to the connect-wallet screen** instead of keeping the wallet
   connected and showing a retry.

Once our side fix (3a) ships, the 401 should stop occurring on the happy path — but
the disconnect-on-error behavior should still be fixed so future transient failures
(expired session, network blips) don't kick users back to connect.

## 6. Ready-to-paste GitHub issue body

```markdown
### Bug: signing failure (Hub 401) resets the app to the connect-wallet screen

**Summary**
When a Sign Message / transfer fails with an HTTP 401 from the Wallet Hub, the Arch
Prime UI resets back to the connect-wallet screen and the user loses their wallet
connection. A failed sign is a transient, recoverable action failure and should not
tear down the connection.

**Context (what causes the 401)**
The Hub's `signing-requests.create` / `signing-requests.submit` routes are
session-enforced: they require a per-user Hub session bearer token in addition to the
app API key, to bind money/signing requests to a verified wallet session. If the
session token is missing/expired, the Hub returns:
`401 "Missing or malformed session bearer"`.
The Wallet Hub + Chrome extension team is separately fixing the extension to (a) mint
and attach a Hub session token on the dapp-sign path for Turnkey wallets, and (b) stop
mislabeling session-401s as "API key" errors. That work is on our side — this issue is
specifically about the UI's disconnect-on-error behavior.

**Asks (Arch Prime side)**
1. Do NOT disconnect / reset to the connect-wallet screen on a transient signing error
   or 401. Keep the wallet connected, treat it as a failed action, and offer a retry.
2. Surface a differentiated, actionable error: distinguish "session expired / re-unlock
   your wallet in the extension" (the 401) from "wallet disconnected" and from
   "bad API key/config."
3. Optional: detect the 401 shape `"Missing or malformed session bearer"` and prompt
   re-unlock rather than a full reconnect.

**Repro**
1. Connect a Turnkey wallet via the Chrome extension.
2. Reach a state where the Hub session token is absent/expired.
3. Trigger a Sign Message from Arch Prime and approve.
4. Observe: 401 "Missing or malformed session bearer" → app resets to connect screen.

**Note**
Console logs `[WalletConnect] identity_resolved` and
`token_accounts_creation_recovered { reason: 'post_verify' }` come from
arch-swap-engine and are benign (onboarding/ATA verification succeeded); they are not
the cause.
```
