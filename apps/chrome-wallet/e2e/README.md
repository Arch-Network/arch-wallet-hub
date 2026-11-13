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
- an error banner's "Copy error details": the report on the clipboard;
- an error banner's "Send report": the reference shown for a failed Hub
  request, nothing posted before the confirmation, and the report the mocked
  Hub receives, including the service worker's log;
- the passkey window: the wait banner and its Cancel, and a passkey that
  belongs to another wallet being reported at unlock with a retry;
- recovery checkpoint route restoration;
- Bitcoin send review / PSBT preparation from fixture UTXOs and fee tiers;
- a real content-script/injected-provider dapp connect approval and a signing
  request rejection.

A passkey sign-in that succeeds, email OTP, and transaction broadcast are
deliberately outside this suite: they require a live credential or
production-like signing service. The passkey tests use Chromium's virtual
authenticator and a stubbed Turnkey reply, so they cover the wallet's handling
of a rejected passkey, not Turnkey itself. The other tests stop at the
security-critical local boundaries (consent, request routing, and unsigned
transaction preparation) rather than using fragile credential automation or a
real wallet seed.
