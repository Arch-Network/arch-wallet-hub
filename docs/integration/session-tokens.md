# Hub session tokens for integrators

If your app uses `@arch-network/wallet-hub-sdk` to move funds or sign on a
user's behalf, this is the one thing you need to know after upgrading.

## What changed

Money- and signing-related Hub routes now **require a per-user session
token** in addition to the app API key. The app API key is a platform gate
(rate limit + revocation); it is intentionally shippable to the browser and
is **not** sufficient on its own to act for a specific user. Per-user
authorization comes from a short-lived bearer token (`whs_v1_...`, ~24h)
that the user mints by proving control of their wallet.

Enforced routes today:

- `POST /signing-requests` (create) and `POST /signing-requests/:id/submit`
- `POST /signing-requests/:id/sign-with-turnkey`
- `POST /btc/build` and `POST /btc/estimate-fee`

Calling these without a valid session token returns:

```
401 Missing or malformed session bearer
```

## You don't have to manage the token yourself

The SDK version that ships this guide can mint and refresh the token
**automatically**. Give the client a `sessionSigner` and every enforced
call "just works": the client mints on first need, caches the token, and on
a session 401 it re-mints once and retries.

> Detect support at runtime by checking for `client.setSessionSigner` /
> the `sessionSigner` constructor option.

### Turnkey-custodied wallets

Supply a signer that schnorr-signs the 32-byte challenge payload with the
resource's default Taproot key (BIP-340, no extra hashing — i.e. Turnkey
`HASH_FUNCTION_NO_OP`), returning a 64-byte `r||s` hex string:

```ts
import { WalletHubClient } from "@arch-network/wallet-hub-sdk";

const client = new WalletHubClient({
  baseUrl: "https://wallet-hub.arch.network/v1",
  apiKey: APP_API_KEY,
  network: "mainnet",
  sessionSigner: {
    kind: "turnkey",
    externalUserId,                 // your stable per-user id
    turnkeyResourceId,              // the user's Hub resource id
    async signChallenge(payloadHex) {
      // Sign payloadHex (32 bytes) with the resource's default Taproot key.
      // Return the 64-byte schnorr signature as lowercase hex (r||s).
      return await signWithTurnkeySession(payloadHex);
    },
  },
});

// No token wrangling needed — this mints + attaches a session as needed:
await client.createSigningRequest({ /* ... */ });
```

### External / linked wallets (Xverse, UniSat, ...)

External wallets have no Turnkey key, so they prove control with a
**BIP-322** signature over a human-readable challenge message — the same
scheme you already used to link the wallet (`verifyWalletLinkChallenge`).
The wallet's address must already be linked for `externalUserId`.

```ts
const client = new WalletHubClient({
  baseUrl: "https://wallet-hub.arch.network/v1",
  apiKey: APP_API_KEY,
  network: "mainnet",
  sessionSigner: {
    kind: "external",
    externalUserId,
    walletProvider: "xverse",       // or "unisat", etc.
    address,                        // the linked Taproot (p2tr) address
    async signMessage(message) {
      // Ask the wallet to BIP-322-sign `message`. Return whatever the
      // wallet produces (typically a base64 witness blob).
      const { signature } = await wallet.signMessage(address, message);
      return signature;
    },
  },
});
```

### Apps that swap the active account

If the signing wallet can change at runtime, pass a **function** instead of
a static object. The SDK calls it whenever it needs to mint, so you never
have to rebuild the client:

```ts
client.setSessionSigner(() => signerForCurrentlySelectedAccount());
// return undefined when no wallet is available; the call then proceeds
// without a freshly-minted token (legacy behaviour).
```

## Already managing the token manually?

Nothing breaks. If you don't configure a `sessionSigner`, the client
behaves exactly as before: mint the token yourself via the
`/auth/session*` endpoints (Turnkey) or `/auth/session/external*`
(BIP-322), then call `client.setSessionToken(token)`. You are then
responsible for refreshing it on expiry.

## Mechanics (if you implement minting by hand)

Turnkey:

1. `POST /v1/auth/session/challenge` `{ externalUserId, turnkeyResourceId }`
   → `{ challengeId, payloadHex, ... }`
2. schnorr-sign `payloadHex` → `POST /v1/auth/session`
   `{ challengeId, signatureHex }` → `{ sessionToken, expiresAt }`

External / BIP-322:

1. `POST /v1/auth/session/external/challenge`
   `{ externalUserId, walletProvider, address }` → `{ challengeId, message, ... }`
2. BIP-322-sign `message` → `POST /v1/auth/session/external`
   `{ challengeId, signature }` → `{ sessionToken, expiresAt }`

Send the token as `Authorization: Bearer whs_v1_...` (the SDK does this for
you). It is scoped to one user + app and expires in ~24h.
