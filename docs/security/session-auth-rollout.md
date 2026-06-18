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

- **Mint:** `POST /v1/auth/session/challenge` → sign `payloadHex` with
  the user's Turnkey key → `POST /v1/auth/session` returns
  `whs_v1_<token>` (24h). (`routes/authSessions.ts`, `auth/sessionToken.ts`)
- **Enforce:** `server.requireSession` preHandler validates the
  `Authorization: Bearer whs_v1_...` token (in addition to the app API
  key) and populates `request.session = { sessionId, appId, userId,
  externalUserId }`. (`plugins/sessionAuth.ts`)
- **Pattern:** a protected route adds `preHandler: server.requireSession`
  and rejects when `body.externalUserId !== session.externalUserId`.

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
| high-risk user-scoped routes (see keys below) | **wired, flag-gated** (default OFF) |
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

### Enable procedure (after 0.6.1 adoption)

1. Confirm via telemetry that token-sending builds dominate (look for the
   `Authorization: Bearer whs_v1_` header / a server-side metric).
2. Turn on a small batch, highest risk first, e.g.
   `SESSION_ENFORCED_ROUTES=turnkey.sign-message,arch.transfer,arch.instructions.build`,
   and redeploy. Watch `401`/`403` rates.
3. Widen in batches; `SESSION_ENFORCED_ROUTES=*` enforces all wired routes.
4. Roll back instantly by removing keys from the env var (no code change).

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
