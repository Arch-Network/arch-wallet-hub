# Wallet Hub: Signing Requests (v1)

This doc describes the **Signing Requests** API surface used to build a Phantom/MetaMask-like UX while supporting:

- **Embedded wallets** (Turnkey signer, **user-initiated** / non-custodial)
- **Confirmation-gated execution** (BTC UTXO confirmations required by Arch validator)

## Auth

All endpoints require a developer API key:

- Header: `X-API-Key: <app_api_key>`

## Endpoints

### `POST /v1/signing-requests`

Creates a signing request. Wallet Hub returns:

- `display`: a human-readable preview
- `payloadToSign`: the digest to be signed by the user’s wallet (e.g. Turnkey via passkey)

Wallet Hub **does not sign server-side**. The client must submit a signature via `POST /v1/signing-requests/:id/submit`.

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

- `toAddress` must be an **Arch account address** (base58 32-byte pubkey).
- Execution may be gated by the Arch validator’s BTC confirmation policy for the payer’s **anchored UTXO**.

Execution gating is surfaced via `GET /v1/signing-requests/:id` as `readiness`, and is enforced on submit.

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

### `POST /v1/signing-requests/:id/submit`

Submit a user-produced signature and have Wallet Hub submit the Arch transaction.

Request body (Turnkey `SIGN_RAW_PAYLOAD` result):

```json
{
  "externalUserId": "user-123",
  "signature64Hex": "<128 hex chars r||s>",
  "turnkeyActivityId": "optional"
}
```

If the request is not ready (e.g. insufficient BTC confirmations), Wallet Hub responds with HTTP **409** and a structured readiness payload.

## Configuration

Wallet Hub uses:

- `BTC_PLATFORM_BASE_URL`: base URL for the BTC platform API (e.g. `http://localhost:3101`)
- `BTC_MIN_CONFIRMATIONS`: required confirmations for readiness checks (default `20`)
