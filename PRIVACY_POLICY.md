# Arch Wallet — Privacy Policy

**Last Updated:** March 24, 2026

## Overview

Arch Wallet is a non-custodial cryptocurrency wallet browser extension for the Arch Network and Bitcoin. This privacy policy explains how the extension handles your data.

## Data Collection

**Arch Wallet does not collect, store, or transmit any personally identifiable information (PII).**

### What the extension stores locally

All data is stored on your device using the Chrome `storage` API:

- Wallet account metadata (labels, public addresses, public keys)
- User preferences (selected network, connected sites)
- API endpoint configuration

Private keys are never stored in the extension. Key management is handled by [Turnkey](https://www.turnkey.com/), a non-custodial key infrastructure provider. Turnkey uses passkeys (WebAuthn) tied to your device — your private keys are never exposed to the extension or any server.

### What the extension sends over the network

- **Blockchain queries**: The extension communicates with the Arch Wallet Hub API to fetch public blockchain data such as account balances, transaction history, and network status. These requests include only public blockchain addresses — no PII.
- **Transaction signing**: When you sign a transaction, the signing request is routed through Turnkey's infrastructure using your device-bound passkey. The extension never sees or transmits your private key.
- **Faucet requests**: On testnet, the extension can request test tokens from a faucet using your public Arch address.

### What the extension does NOT do

- Does not collect analytics or telemetry
- Does not use cookies or tracking pixels
- Does not transmit browsing history, form data, or personal information
- Does not share any data with third parties for advertising or marketing
- Does not store private keys or seed phrases

## Permissions

The extension requests the following browser permissions:

| Permission | Purpose |
|---|---|
| `storage` | Store wallet configuration and preferences locally on your device |
| `activeTab` | Read the current tab's URL to determine dApp connection context |
| `tabs` | Manage popup window positioning and dApp communication |
| `host_permissions: <all_urls>` | Inject the `window.arch` provider so any Arch-compatible dApp can interact with your wallet (same pattern used by MetaMask, Phantom, and other wallet extensions) |

## Third-Party Services

- **Turnkey (turnkey.com)**: Non-custodial key management. Turnkey's privacy policy applies to their service: [https://www.turnkey.com/privacy](https://www.turnkey.com/privacy)
- **Arch Network Explorer**: Public blockchain indexer used to retrieve account and transaction data.
- **Titan BTC Indexer**: Public Bitcoin blockchain indexer for balance and transaction data.

## Data Retention

All locally stored data can be cleared at any time by removing the extension from Chrome. No data is retained on any server operated by Arch Wallet.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in this document with an updated "Last Updated" date.

## Contact

If you have questions about this privacy policy, please open an issue at [https://github.com/hoffmabc/arch-wallet-hub/issues](https://github.com/hoffmabc/arch-wallet-hub/issues).
