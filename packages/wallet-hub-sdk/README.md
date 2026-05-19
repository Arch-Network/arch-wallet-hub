# Arch Wallet Hub SDK

TypeScript client for the Arch Wallet Hub API. It wraps the Hub's HTTP surface with typed request and response objects for wallet linking, Turnkey wallet management, signing requests, Bitcoin helper endpoints, and email recovery flows.

> Package status: this package is currently marked `"private": true` in `package.json`. Remove that flag and publish it before third-party consumers can install it from npm.

## Installation

From this monorepo:

```bash
npm install
npm run build
```

Once published:

```bash
npm install @arch/wallet-hub-sdk
```

## Quick Start

```ts
import { WalletHubClient } from "@arch/wallet-hub-sdk";

const walletHub = new WalletHubClient({
  baseUrl: "https://your-wallet-hub.example.com/v1",
  apiKey: process.env.WALLET_HUB_API_KEY,
  network: "testnet",
});

const turnkeyConfig = await walletHub.getTurnkeyConfig();
console.log(turnkeyConfig.organizationId);
```

`baseUrl` may include or omit `/v1`; the client normalizes it. `network` is sent as `x-network` and defaults to `testnet`. `apiKey` is sent as `x-api-key` when provided.

## Runtime Support

The SDK uses the global `fetch` implementation by default. For older Node runtimes or custom test harnesses, pass `fetchImpl`:

```ts
const walletHub = new WalletHubClient({
  baseUrl: "http://localhost:3005/v1",
  apiKey: "dev-api-key",
  fetchImpl: customFetch,
});
```

## Wallet Linking

Use wallet linking when a dApp needs to prove control of an external wallet address.

```ts
const challenge = await walletHub.createWalletLinkChallenge({
  externalUserId: "user_123",
  walletProvider: "unisat",
  address: "tb1p...",
  network: "testnet",
});

// Ask the user's wallet to sign challenge.message, then verify it.
const linked = await walletHub.verifyWalletLinkChallenge({
  externalUserId: "user_123",
  challengeId: challenge.challengeId,
  signature: "base64-or-wallet-specific-signature",
  schemeHint: "bip322",
});
```

## Turnkey Wallets

Create a passkey-backed Turnkey wallet:

```ts
const wallet = await walletHub.createTurnkeyPasskeyWallet({
  idempotencyKey: crypto.randomUUID(),
  body: {
    externalUserId: "user_123",
    walletName: "Primary wallet",
    userEmail: "user@example.com",
    passkey: {
      challenge: "base64url-challenge",
      attestation: passkeyAttestation,
    },
  },
});
```

Create an email-only Turnkey wallet:

```ts
const wallet = await walletHub.createTurnkeyEmailWallet({
  idempotencyKey: crypto.randomUUID(),
  body: {
    externalUserId: "user_123",
    userEmail: "user@example.com",
    walletName: "Email wallet",
  },
});
```

List or fetch known wallets:

```ts
const wallets = await walletHub.listTurnkeyWallets("user_123");

const walletDetails = await walletHub.getTurnkeyWallet({
  externalUserId: "user_123",
  resourceId: wallet.resourceId,
});
```

## Email Recovery

Recovery is a three-step flow:

1. Discover wallet candidates for an email.
2. Start OTP delivery for the selected candidate.
3. Verify the OTP and receive an encrypted credential bundle.

```ts
const init = await walletHub.initRecoveryEmail({
  email: "user@example.com",
});

if (init.candidates.length === 0) {
  // Show neutral copy for anti-enumeration:
  // "If a wallet exists for this email, you'll receive recovery instructions."
}

const candidate = init.candidates[0];

await walletHub.startRecoveryEmailOtp({
  email: "user@example.com",
  challengeId: init.challengeId,
  candidateToken: candidate.candidateToken,
});

const verified = await walletHub.verifyRecoveryEmail({
  challengeId: init.challengeId,
  candidateToken: candidate.candidateToken,
  code: "123456",
  ephemeralPublicKey: "04...",
  externalUserId: "user_123",
});
```

`verified.credentialBundle` is HPKE-encrypted to the provided `ephemeralPublicKey`. The client must decrypt it locally and use the recovered credential according to `verified.authMethod`:

- `passkey`: register a new authenticator on the recovered sub-organization.
- `email`: bootstrap an IndexedDB signing session.

## Signing Requests

Create a signing request for an external signer or a Turnkey-backed wallet:

```ts
const request = await walletHub.createSigningRequest({
  externalUserId: "user_123",
  signer: {
    kind: "turnkey",
    resourceId: "wallet_resource_id",
  },
  action: {
    type: "arch.transfer",
    toAddress: "arch1...",
    lamports: "1000000",
  },
});

const status = await walletHub.getSigningRequest(request.signingRequestId);
```

Submit a client-produced signature:

```ts
await walletHub.submitSigningRequest(request.signingRequestId, {
  externalUserId: "user_123",
  signature64Hex: "deadbeef...",
});
```

Or ask the Hub to sign with Turnkey for a registered Turnkey wallet:

```ts
await walletHub.signWithTurnkey(request.signingRequestId, {
  externalUserId: "user_123",
});
```

## Bitcoin Helpers

Estimate a fee:

```ts
const fee = await walletHub.estimateBitcoinFee({
  externalUserId: "user_123",
  turnkeyResourceId: "wallet_resource_id",
  toAddress: "tb1q...",
  amountSats: 10_000,
});
```

Build and broadcast a Bitcoin transaction:

```ts
const psbt = await walletHub.buildBitcoinPsbt({
  externalUserId: "user_123",
  turnkeyResourceId: "wallet_resource_id",
  toAddress: "tb1q...",
  amountSats: 10_000,
});

// Sign and finalize psbt.unsignedPsbtHex locally, then broadcast:
const broadcast = await walletHub.broadcastBitcoinTransaction({
  signedTxHex: "0200000000...",
});
```

## Error Handling

Non-2xx responses throw an `Error` with the HTTP status and response body:

```ts
try {
  await walletHub.getTurnkeyConfig();
} catch (err) {
  console.error(err);
}
```

## Development

```bash
cd packages/wallet-hub-sdk
npm install
npm run typecheck
npm run build
```

The public entrypoint is `src/index.ts`, which re-exports `WalletHubClient` and all SDK types.
