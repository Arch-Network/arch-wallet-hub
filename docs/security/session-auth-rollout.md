# Session-auth rollout plan (IDOR remediation)

## Problem

Most user-scoped Hub routes resolve the acting user from a
**client-supplied `externalUserId`** in the request body/query. Because
every app shares one app API key, any holder of that key can pass an
arbitrary `externalUserId` and act as any user of the app (IDOR /
impersonation). See `services/wallet-hub-api/src/auth/sessionToken.ts`
for the root-cause note.

## The mechanism already exists

The server has a complete per-user session layer:

- **Mint (Turnkey):** `POST /v1/auth/session/challenge` → sign
  `payloadHex` with the user's Turnkey key → `POST /v1/auth/session`
  returns `whs_v1_<token>` (24h). (`routes/authSessions.ts`,
  `auth/sessionToken.ts`)
- **Mint (external / linked wallets):** `POST
  /v1/auth/session/external/challenge` → BIP-322-sign the returned
  `message` with the linked wallet (Xverse/UniSat/...) → `POST
  /v1/auth/session/external` returns the same `whs_v1_<token>` (24h).
  See "External wallets mint via BIP-322" below.
- **Enforce:** `server.requireSession` preHandler validates the
  `Authorization: Bearer whs_v1_...` token (in addition to the app API
  key) and populates `request.session = { sessionId, appId, userId,
  externalUserId }`. (`plugins/sessionAuth.ts`)
- **Pattern:** a protected route adds `preHandler: server.requireSession`
  and rejects when `body.externalUserId !== session.externalUserId`.

### External wallets mint via BIP-322

The Turnkey mint path verifies a schnorr signature over the challenge's
32-byte `payloadHex` against the resource's stored
`default_public_key_hex`. External / linked wallets have no
Turnkey-custodied key, so they prove control with a **BIP-322** signature
over the challenge's human-readable `message` instead — exactly the
verification the wallet-linking flow already uses
(`routes/walletLinking.ts`, `@saturnbtcio/bip322-js`).

- `POST /v1/auth/session/external/challenge` body `{ externalUserId,
  walletProvider, address }` — requires a Taproot (p2tr) address that is
  already present in `linked_wallets` for that user (proof-of-control was
  established at link time). Returns `{ challengeId, message, expiresAt }`.
- `POST /v1/auth/session/external` body `{ challengeId, signature }` —
  re-checks the `linked_wallets` ownership, verifies the BIP-322
  signature over the stored `message`, and mints the **same** `whs_v1_`
  token (same `auth_sessions` row, 24h TTL, app/user scoping) as the
  Turnkey path.

The (provider, address) a challenge targets are persisted on the
`auth_challenges` row (migration 015, nullable columns; the Turnkey path
leaves them NULL). The Turnkey path is unchanged.

**Net effect:** every client — our extension, third-party integrators, and
Arch Prime — can mint a session token regardless of wallet type, so
enforcement (below) can stay ON permanently for all clients.

## Why this can't be flipped on globally in one PR

**No shipped client mints or sends a session token today.** Both
`apps/chrome-wallet` and `apps/demo-dapp` build the SDK client with only
`{ baseUrl, apiKey, network }` and pass `externalUserId` in the body.
Turning on `requireSession` for a route therefore **401s every client
call to it** until the client implements the mint flow. Enforcement must
follow client adoption, route by route.

## Status

| Route | Enforced? |
|-------|-----------|
| `POST /auth/session/revoke` | yes (always — `requireSession`) |
| `POST /signing-requests/:id/sign-with-turnkey` | yes (always — `requireSession`) |
| `POST /turnkey/indexeddb-keys` | yes (always) — safe because no client calls it |
| money/signing routes (see "Enabled set" below) | **ENFORCED by default** (from 0.6.1) |
| wallet create/import + `turnkey.wallets.list/get` | wired, flag-gated (default OFF — pre-session) |
| everything else | not enforced |

## Phase 2a — client minting (DONE)

`apps/chrome-wallet` mints + sends a `whs_v1_` session token (see
`apps/chrome-wallet/src/utils/hub-session.ts`): on signing-session open it
runs `createSessionChallenge` → schnorr-sign the payload → `mintSessionToken`
→ caches + attaches the bearer to every request. Strictly fail-soft.
**Shipped from 0.6.1 onward; 0.6.0 does NOT send tokens** — which is why
2b enforcement stays OFF until 0.6.0 has aged out. (`demo-dapp` is out of
scope and never sends tokens.)

## Phase 2b — flag-gated enforcement (this PR)

Instead of one-route-per-PR code churn, enforcement is wired onto the
high-risk routes now but is a **zero-cost no-op until enabled** via the
`SESSION_ENFORCED_ROUTES` env var (default empty). When a route key is
enabled, `server.enforceSessionForRoute(key)`:

1. requires a valid `whs_v1_` session token (else `401`), and
2. binds the request: if the body/query carries an `externalUserId` that
   differs from the session principal, `403`.

The decision logic is unit-tested in pure form
(`plugins/__tests__/sessionEnforcement.test.ts`); see
`sessionEnforcementDecision` / `parseEnforcedRoutes`.

### Wired route keys (risk order)

```
turnkey.sign-message
arch.transfer
arch.instructions.build
signing-requests.create
signing-requests.submit
turnkey.passkey-wallets.create
turnkey.email-wallets.create
turnkey.passkey-wallets.import
btc.build
btc.estimate-fee
wallet-links.challenge
wallet-links.verify
turnkey.wallets.list
turnkey.wallets.get
wallet-links.list
```

### Enabled set (live from 0.6.1)

Given the small user base, enforcement was turned on directly via the
`SESSION_ENFORCED_ROUTES` **code default** (`config/env.ts`) for the
money/signing routes that always run post-unlock on an already-created
account — so a 0.6.1+ wallet has minted a session token by the time it calls
them:

```
turnkey.sign-message
arch.transfer
arch.instructions.build
signing-requests.create
signing-requests.submit
btc.build
btc.estimate-fee
```

These are the highest-value IDOR targets (move funds / sign). Un-updated
(<0.6.1) clients calling them now get a `401` — an accepted tradeoff.

**Deliberately NOT enforced** (would break onboarding — no session can exist
before the wallet does): `turnkey.passkey-wallets.create`,
`turnkey.email-wallets.create`, `turnkey.passkey-wallets.import`, and the
discovery reads `turnkey.wallets.list` / `turnkey.wallets.get` (called during
recovery/import before a token exists).

### Adjusting enforcement

1. Widen: set `SESSION_ENFORCED_ROUTES` (env, overrides the default) to add
   more keys, or `*` for all wired routes — only once the create/import flow
   no longer needs them pre-session.
2. Roll back instantly by setting `SESSION_ENFORCED_ROUTES=""` in the env (no
   code change / redeploy of image needed if set on the task def).

### Exempt (must NEVER be enforced)

`/auth/session/challenge`, `/auth/session`, `/health`,
`/extension/connect`, `/platform/*` (bootstrap / public / admin).

### Special cases (not yet wired)

`GET /signing-requests/:id` and `POST /btc/broadcast` carry no
`externalUserId`; they need a session + resource/output-ownership check
rather than the externalUserId binding, so they're deferred.

## SDK / docs cleanup (tracked separately)

- `VerifyChallengeResponse` has no `sessionToken` field although the
  type docs imply it does; the real mint path is the `/auth/session*`
  endpoints. Reconcile the SDK types.
- Session TTL doc says "15 min"; server issues 24h.
