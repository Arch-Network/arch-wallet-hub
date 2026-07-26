# Chrome wallet functional E2E tests

Run from `apps/chrome-wallet`:

```bash
npm run test:e2e
```

The suite builds and loads the real WXT MV3 extension in Playwright's
Chromium channel. Each test uses a new temporary Chrome profile and creates a
synthetic encrypted keystore with a deterministic account. Indexer responses
are intercepted at the browser boundary, so BTC send preparation does not
contact the Wallet Hub, indexer, or Bitcoin network.

Covered flows:

- fresh onboarding and locked-keystore password rejection;
- recovery checkpoint route restoration;
- Bitcoin send review / PSBT preparation from fixture UTXOs and fee tiers;
- a real content-script/injected-provider dapp connect approval and a signing
  request rejection.

Passkey, email OTP, and transaction broadcast are deliberately outside this
suite: they require a live credential or production-like signing service. The
tests stop at the security-critical local boundaries (consent, request routing,
and unsigned transaction preparation) rather than using fragile credential
automation or a real wallet seed.
