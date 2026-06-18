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
| `POST /auth/session/revoke` | yes (by definition) |
| `POST /signing-requests/:id/sign-with-turnkey` | yes |
| `POST /turnkey/indexeddb-keys` | **yes (this PR)** — safe because no client calls it |
| everything else user-scoped | not yet (clients don't send tokens) |

## Staged rollout (one route per PR)

1. **Client groundwork (prerequisite):** after wallet unlock / passkey
   bootstrap, have chrome-wallet (and demo-dapp) call
   `createSessionChallenge` → sign → `mintSessionToken` →
   `client.setSessionToken(token)`. Refresh on 401 / expiry.
2. **Per route, in risk order**, add `preHandler: server.requireSession`
   + the `externalUserId === session.externalUserId` guard:
   1. `POST /turnkey/sign-message`
   2. `POST /arch/transfer`, `POST /arch/instructions/build`
   3. `POST /signing-requests`, `POST /signing-requests/:id/submit`
   4. `POST /turnkey/passkey-wallets`, `/email-wallets`,
      `/passkey-wallets/import`
   5. `POST /btc/build`, `/btc/estimate-fee`
   6. Reads: `GET /turnkey/wallets`, `/turnkey/wallets/:resourceId`,
      `GET /wallet-links`
3. **Exempt (must NOT require a session):** `/auth/session/challenge`,
   `/auth/session`, `/health`, `/extension/connect`, `/platform/*`.
4. **Special cases:** `GET /signing-requests/:id` and
   `POST /btc/broadcast` have no `externalUserId` today; bind them to a
   session + resource-ownership check when migrated.

## SDK / docs cleanup (tracked separately)

- `VerifyChallengeResponse` has no `sessionToken` field although the
  type docs imply it does; the real mint path is the `/auth/session*`
  endpoints. Reconcile the SDK types.
- Session TTL doc says "15 min"; server issues 24h.
