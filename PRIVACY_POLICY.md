# Arch Wallet — Privacy Policy

**Last Updated:** November 13, 2026

## Overview

Arch Wallet is a non-custodial cryptocurrency wallet browser extension for the Arch Network and Bitcoin. This privacy policy explains how the extension handles your data.

## Data Collection

**Arch Wallet does not collect, store, or transmit any personally identifiable information (PII).** An error report is sent only if you choose to send one, and is built to leave such information out. What it contains, and where that falls short of a guarantee, is described under "Error reports you send" below.

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
- **Error reports you send**: When the extension shows an error, you can press "Send report". Nothing is sent unless you press it and then confirm. The report goes to the Arch Wallet Hub API and contains the error message, the Wallet Hub's reference id for the request that failed (when there is one), the extension version, the time, the screen you were on, the selected network, the type of wallet (for example passkey or email), your browser's user-agent string (browser and operating system version), and the extension's recent diagnostic log (failed requests, errors, and sign-in and session steps). Before it is sent, account ids are removed from the log, and anything that looks like a blockchain address, a transaction id, a public key, or an email address is replaced with a placeholder. Both steps work by recognising patterns and are not a guarantee: an identifier in a form or place they do not recognise would be sent as it is. The reference id lets the team that operates the Wallet Hub find the failed request in the Wallet Hub's own logs, and that request can include your public blockchain address. "Copy error details" puts the same text on your clipboard without sending it, so you can read it first (the sent copy may leave out the oldest log lines to fit a size limit).

### What the extension does NOT do

- Does not collect analytics or telemetry; an error report is sent only when you choose to send one
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

All locally stored data can be cleared at any time by removing the extension from Chrome. No data is retained on any server operated by Arch Wallet, except error reports you choose to send. These are written to the Wallet Hub's server logs, where the team that operates the Wallet Hub can read them. The logs are kept for up to 365 days, after which the logging service removes them, usually within a few days.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in this document with an updated "Last Updated" date.

## Contact

If you have questions about this privacy policy, please open an issue at [https://github.com/hoffmabc/arch-wallet-hub/issues](https://github.com/hoffmabc/arch-wallet-hub/issues).
