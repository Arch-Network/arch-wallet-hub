# Chrome Web Store screenshot harness

Captures **real** screenshots of the built Arch Wallet popup UI for the Chrome
Web Store (CWS) listing. It loads the unpacked MV3 extension in Chromium with
Playwright, forces light **and** dark themes, captures each screen, and
composites the 400×600 popup onto a branded **1280×800** canvas (the CWS tile
size).

Generated PNGs land in `apps/chrome-wallet/.screenshots/` and are
**gitignored** — they are produced on demand, not committed.

## Prerequisites

```bash
cd apps/chrome-wallet
npm install
npx playwright install chromium   # required; new-headless build loads MV3 extensions
```

- **`.env.local`** (optional but recommended): the Wallet Hub / Indexer keys
  (`WXT_HUB_API_KEY_DEV`, `WXT_INDEXER_API_KEY_DEV`) are baked in at **build**
  time, so they are picked up automatically by the `npm run build` step inside
  `npm run screenshots`. Without them, a seeded wallet's data-rich screens
  (balances, history) may render empty. See `.env.example`.
- **`WALLET_SEED_FILE`** (optional): path to a JSON seed describing a real,
  unlocked wallet's storage so data-rich screens can be captured. See
  [Seeding a wallet](#seeding-a-wallet-for-data-rich-screens) below. Defaults
  to `screenshots/seed.local.json` (gitignored) if present.

## Run

```bash
cd apps/chrome-wallet
npm run screenshots          # builds the extension, then captures
# Debug visibly (headed) if the extension won't load headlessly:
HEADED=1 npm run screenshots
```

Outputs: `apps/chrome-wallet/.screenshots/<screen>-<theme>.png` plus a
`manifest.json` listing exactly which screens were captured vs skipped (and
why).

## Screens

| Screen       | Needs seed? | Notes                                  |
| ------------ | ----------- | -------------------------------------- |
| `onboarding` | no          | Welcome / create-wallet landing        |
| `unlock`     | no          | Locked keystore (synthesized, no secret) |
| `dashboard`  | yes         | Portfolio                              |
| `send`       | yes         | Send form                              |
| `receive`    | yes         | Receive / QR                           |
| `history`    | yes         | Activity                               |
| `settings`   | yes         | Settings                               |

Each is captured in both `light` and `dark`.

The `unlock` screen needs no real wallet: the harness synthesizes a
structurally valid but empty sealed keystore (same AES-GCM/PBKDF2 crypto as the
app) with **no session key**, which the app renders as the Unlock screen.

## Seeding a wallet (for data-rich screens)

Real onboarding uses passkey/email auth (Turnkey + Wallet Hub) and cannot be
automated headlessly, so data-rich screens are driven from a developer-provided
storage snapshot of an already-unlocked wallet.

1. Build and load the extension, then unlock your wallet normally.
2. Open the popup's DevTools console and run:

   ```js
   copy(JSON.stringify({
     local: await chrome.storage.local.get(null),
     session: await chrome.storage.session.get(null),
   }))
   ```

3. Save the clipboard to `apps/chrome-wallet/screenshots/seed.local.json`
   (or any path, then set `WALLET_SEED_FILE` to it).
4. Re-run `npm run screenshots`.

> ⚠️ **The seed file contains key material. It is gitignored. NEVER commit it.**

If no seed is provided, the harness still runs end-to-end and captures the
reachable screens (`onboarding`, `unlock`); the data-rich screens are logged as
skipped.

## Uploading to the Chrome Web Store

1. Review the PNGs in `.screenshots/`.
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   → the Arch Wallet item → **Store listing** → **Screenshots**.
3. Upload the chosen 1280×800 PNGs (CWS also accepts 640×400). Order them so
   the most compelling screen (e.g. dashboard) is first.
4. Save the draft and submit for review.
