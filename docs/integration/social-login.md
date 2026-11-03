# Social login and the Arch ID token

How an app signs a user in with Google (Apple follows the same route with a
second provider), what the Hub records about the person, and how another
Arch service learns which email owns which wallets.

## The one call

```
POST /v1/auth/oauth
x-api-key: <app key>
x-network: testnet | mainnet        (only read on sign-up: which P2TR format to create)

{ "provider": "google",
  "oidcToken": "<Google id token>",
  "publicKey": "<compressed P-256 hex, 66 chars>" }
```

`publicKey` is the browser's Turnkey session key — the same IndexedDB
stamper key the email flow registers with `STAMP_LOGIN`. The id token's
`nonce` claim MUST be `sha256(publicKey)` over the lowercase hex string as
UTF-8 text (Turnkey's rule; its worked example hashes to
`1663bba4…`). Ask Google for the token with that nonce, hand both to the Hub.

Sign-in and sign-up are one call:

| The Hub finds | It does | Answer |
| --- | --- | --- |
| `user_identities(google, sub)` | `OAUTH_LOGIN` on that person's sub-org with `publicKey` | 200, `created: false` |
| nothing, and the token's verified email belongs to no one | creates the person (`usr_…`), a Turnkey sub-org whose root user is the OIDC identity, the wallet, then `OAUTH_LOGIN` | 200, `created: true` |
| nothing, but the verified email belongs to another person | nothing — the inbox, not the token, must prove that account | 409 `{ code: "identity_exists", emailMasked }` |
| nothing, but a concurrent sign-up took the identity first | rolls its own rows back; the same call again signs in | 409 `{ code: "identity_raced" }` |
| a replayed or badly bound token | nothing | 401 |

A 200 carries the wallet (`organizationId`, `defaultAddress`,
`defaultPublicKeyHex`, `rootUserId`), a Hub session (`sessionToken`,
`whs_v1_…`, 24 h) and an Arch ID token (`idToken`, 15 min). After it the
browser holds a Turnkey login key for one hour and signs with
`signRawPayload` exactly as an email wallet does; nothing about signing
changes.

The 409 is the link flow's entry point (phase 3): the client runs the email
code for the existing wallet, opens a session, stamps
`CREATE_OAUTH_PROVIDERS` with it, and calls `POST /v1/auth/identities/link`.
Until that ships the person signs in with the email code.

## The person

Migration 019 gives `users` a `primary_email` + `email_verified_at`; 020
adds `user_identities` (google / apple / email / passkey / wallet rows under
one user) and `oidc_replay`. A new social sign-up creates a person with a
canonical `external_user_id` of the form `usr_<32 hex>`. Existing users
(install ids, web sign-up ids) are untouched; their recovery emails are
backfilled as unverified email identities.

`GET /v1/auth/me` (session) lists the person, their identities (emails
masked) and wallets. `POST /v1/auth/id-token` (session) mints a fresh ID
token.

## The Arch ID token

```json
{ "iss": "https://wallet-hub.arch.network", "sub": "usr_…", "aud": "arch",
  "app": "<app id>", "email": "jonah@arch.network", "email_verified": true,
  "wallets": ["<x-only or compressed pubkey hex>", "…"], "amr": ["google"],
  "iat": 1793300000, "exp": 1793300900, "jti": "…" }
```

ES256, `kid` in the header; public keys at `/.well-known/jwks.json` (and
`/v1/auth/jwks`). A consumer such as arch-prime-rewards verifies the
signature offline, checks `iss` / `aud` / `exp`, and accepts a write only
when the wallet that signed it is in `wallets[]`. A token alone reads
nothing anywhere.

Keys: `ID_TOKEN_PRIVATE_JWK` (P-256 private JWK) in production; dev/test
generate an ephemeral key at boot. Rotate by adding a key, waiting one TTL,
moving the old public JWK into `ID_TOKEN_PREVIOUS_JWKS`.

## Running it locally

1. `docker compose -f infra/docker-compose.yml up -d` (Postgres 16).
2. `services/wallet-hub-api/.env`: copy `env.example`; set `DATABASE_URL`,
   `DB_RUN_MIGRATIONS=true`, the Turnkey sandbox org + API key, and
   `GOOGLE_OAUTH_CLIENT_IDS=<your web client id>`.
3. `npm install && npm run dev` → `http://localhost:3001`.
4. Mint an app key: `POST /v1/platform/apps` with `PLATFORM_ADMIN_API_KEY`
   (see `routes/platform.ts`); give it to the web app's proxy as
   `WALLET_HUB_API_KEY`.
5. In Google Cloud → Credentials → the OAuth web client: add
   `http://localhost:4313` (web-v2's `next dev` port) to authorized JavaScript origins and
   `http://localhost:4313/auth/google` to authorized redirect URIs. In the
   consent screen, keep the app in *Testing* and add your account as a
   test user.

Tests: `npm test` covers the verifier (`auth/__tests__/oidc.test.ts`), the ID
token (`auth/__tests__/idToken.test.ts`) and the route
(`routes/__tests__/authOAuth.test.ts`) with Turnkey and the DB mocked. The
sandbox spike script (`scripts/oauth-spike.ts`) walks the real Turnkey
activities with a token you paste in.
