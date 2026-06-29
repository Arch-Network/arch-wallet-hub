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

• Open Source — Fully open-source at https://github.com/hoffmabc/arch-wallet-hub

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

https://github.com/hoffmabc/arch-wallet-hub/blob/main/PRIVACY_POLICY.md

## Single Purpose Description

Arch Wallet serves a single purpose: it is a cryptocurrency wallet that lets users manage Bitcoin and Arch Network assets and connect to decentralized applications. The extension requires host_permissions on all URLs because it injects a JavaScript provider object (window.arch) into web pages so that Arch-compatible dApps can communicate with the wallet. This is the standard pattern used by all major browser wallet extensions (MetaMask, Phantom, Keplr, etc.). No user browsing data is collected or transmitted.

## Screenshots & Store Icon

These assets reflect the v0.7.0 design-system rebrand. Upload the screenshots and store icon manually via the Chrome Web Store developer dashboard.

Screenshots (1280x800):

1. screenshot-home-light.png — Home dashboard in light theme with BTC + ARCH balances and quick actions
2. screenshot-home-dark.png — Home dashboard in dark theme, showing the same view in the alternate theme
3. screenshot-send-light.png — Send screen with address input, amount, and network fee
4. screenshot-activity-dark.png — Activity screen with recent transaction history

Store icon (128x128):

- store-icon-128.png — Rebranded store icon

> Note: The screenshots above are stylized promo mockups of the v0.7.0 design. Real-capture screenshots from the built extension are planned as a follow-up.
