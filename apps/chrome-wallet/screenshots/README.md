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

No `.env.local`, real wallet, passkey, or network service is required. The
harness creates an encrypted synthetic wallet and intercepts its fixture
Indexer responses at the browser boundary. The resulting screens are real
extension renders populated with non-sensitive testnet data.

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
| `dashboard`  | synthetic  | Portfolio with fixture balances        |
| `send`       | synthetic  | Send form with fixture fee tiers       |
| `receive`    | synthetic  | Receive / QR                           |
| `history`    | synthetic  | Activity empty state                   |
| `settings`   | synthetic  | Settings                               |

Each is captured in both `light` and `dark`.

The `unlock` screen uses a structurally valid but empty sealed keystore (same
AES-GCM/PBKDF2 crypto as the app) with **no session key**. The data-rich
screens use a separate encrypted synthetic wallet with a temporary session key
and testnet fixture data. Neither state contains a real credential, private
key, or live account.

## Uploading to the Chrome Web Store

1. Review the PNGs in `.screenshots/`.
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   → the Arch Wallet item → **Store listing** → **Screenshots**.
3. Upload the chosen 1280×800 PNGs (CWS also accepts 640×400). Recommended
   order: `dashboard-light`, `send-light`, `receive-dark`, then `settings-dark`.
4. Save the draft and submit for review.

Do not upload onboarding or unlock captures: they are valid harness coverage
but do not communicate the wallet's primary user value. If the listing needs
live-account data instead of the deterministic fixtures, capture it manually
from an unlocked testnet-only wallet and redact addresses or balances as
needed; never export or commit extension storage.
