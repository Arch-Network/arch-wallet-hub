# Chrome Web Store Listing

Use the content below when filling out the Chrome Web Store developer dashboard.

---

## Name

Arch Wallet

## Short Description (132 characters max)

A Bitcoin, ARCH & APL wallet for Arch Network — send, receive, and connect to dApps with passkey-secured keys.

## Detailed Description

Arch Wallet is a non-custodial browser extension for the Arch Network and Bitcoin. It gives you a single interface to manage BTC and ARCH assets, view transaction history, and connect to decentralized applications.

KEY FEATURES

• Unified Dashboard — View your Bitcoin and Arch balances, pending transactions, and token holdings in one place.

• Send & Receive — Send BTC and ARCH to any address. Generate QR codes for easy receiving.

• Transaction History — Browse confirmed and pending transactions across both Bitcoin (L1) and Arch (L2) with links to block explorers.

• dApp Browser Integration — Arch Wallet injects a provider (window.arch) so compatible dApps can request wallet connections, account info, and transaction signing — just like MetaMask or Phantom.

• Passkey-Secured Keys — Private keys are managed by Turnkey, a non-custodial key infrastructure. Signing uses device-bound passkeys (WebAuthn) so your keys never leave your hardware.

• Token Support — View and manage APL tokens and other Arch Network fungible tokens.

• Testnet Ready — Built-in testnet4 support with one-click ARCH faucet airdrop for developers.

• Open Source — Fully open-source at https://github.com/Arch-Network/arch-wallet-hub

SUPPORTED NETWORKS

• Bitcoin (Testnet4 / Mainnet)
• Arch Network (Testnet / Mainnet)

PERMISSIONS

This extension requests host access on all URLs to inject the dApp provider script, following the same pattern used by other wallet extensions (MetaMask, Phantom, Keplr). No browsing data is collected. See our privacy policy for details.

---

## Category

Productivity

## Language

English

## Privacy Policy URL

https://github.com/Arch-Network/arch-wallet-hub/blob/main/PRIVACY_POLICY.md

## Single Purpose Description

Arch Wallet serves a single purpose: it is a cryptocurrency wallet that lets users manage Bitcoin and Arch Network assets and connect to decentralized applications. The extension requires host_permissions on all URLs because it injects a JavaScript provider object (window.arch) into web pages so that Arch-compatible dApps can communicate with the wallet. This is the standard pattern used by all major browser wallet extensions (MetaMask, Phantom, Keplr, etc.). No user browsing data is collected or transmitted.

## Screenshots & Store Icon

Generate the real extension captures before uploading:

```bash
cd apps/chrome-wallet
npm run screenshots
```

The command loads the built MV3 extension with a synthetic encrypted testnet
wallet and intercepted fixture responses. It needs no live credentials or
services. The generated images are intentionally gitignored in
`apps/chrome-wallet/.screenshots/`; review and upload them manually rather
than adding them to this repository.

Screenshots (1280x800, recommended upload order):

1. `.screenshots/dashboard-light.png` — portfolio dashboard with fixture BTC and ARCH balances
2. `.screenshots/send-light.png` — send flow with available asset balances and fee tiers
3. `.screenshots/receive-dark.png` — receive screen and QR code
4. `.screenshots/settings-dark.png` — wallet preferences

Do not use the onboarding or unlock captures in the public listing. They are
generated for visual regression coverage, not product marketing.

Store icon (128x128):

- store-icon-128.png — Rebranded store icon

Chrome Web Store accepts screenshots at 1280×800 or 640×400; this harness
outputs 1280×800. See `apps/chrome-wallet/screenshots/README.md` for
prerequisites, capture details, and the manual dashboard upload steps.
