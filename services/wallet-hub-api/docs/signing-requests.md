# Wallet Hub: Signing Requests (v1)

This doc describes the **Signing Requests** API surface used to build a Phantom/MetaMask-like UX while supporting:

- **Embedded wallets** (Turnkey signer, server signs + submits)
- **Confirmation-gated execution** (BTC UTXO confirmations required by Arch validator)

## Auth

All endpoints require a developer API key:

- Header: `X-API-Key: <app_api_key>`

## Endpoints

### `POST /v1/signing-requests`

Creates a signing request. For `signer.kind="turnkey"`, Wallet Hub will **sign and submit immediately**.

#### `arch.transfer`

Request body:

```json
{
  "externalUserId": "user-123",
  "signer": { "kind": "turnkey", "resourceId": "<turnkey_resource_uuid>" },
  "action": { "type": "arch.transfer", "toAddress": "<arch_account_base58>", "lamports": "1" }
}
```

Notes:
- `toAddress` must be an **Arch account address** (base58 32-byte pubkey). Taproot addresses cannot be inverted to Arch account pubkeys.
- Execution may be gated by the Arch validator’s BTC confirmation policy for the payer’s **anchored UTXO**.

If the payer is anchored but the BTC UTXO is not confirmed enough, Wallet Hub responds with:

- HTTP **409**
- `error: "BtcUtxoNotConfirmed"`
- includes `confirmations`, `requiredConfirmations`, `btcAccountAddress`, `anchoredUtxo`

#### `arch.anchor`

Anchors an Arch account to a BTC UTXO (required before BTC-backed execution can proceed).

```json
{
  "externalUserId": "user-123",
  "signer": { "kind": "turnkey", "resourceId": "<turnkey_resource_uuid>" },
  "action": { "type": "arch.anchor", "btcTxid": "<btc_txid_hex>", "vout": 1 }
}
```

### `GET /v1/signing-requests/:id`

Returns the stored signing request and a **live `readiness`** section that can be polled by the UI.

`readiness.status` can be:
- `ready`
- `not_ready`
- `unknown`

Example `readiness` when waiting on BTC confirmations:

```json
{
  "status": "not_ready",
  "reason": "BtcUtxoNotConfirmed",
  "anchoredUtxo": { "txid": "...", "vout": 1 },
  "btcAccountAddress": "tb1p...",
  "confirmations": 9,
  "requiredConfirmations": 20
}
```

## Configuration

Wallet Hub uses:

- `BTC_PLATFORM_BASE_URL`: base URL for the BTC platform API (e.g. `http://localhost:3101`)
- `BTC_MIN_CONFIRMATIONS`: required confirmations for readiness checks (default `20`)
