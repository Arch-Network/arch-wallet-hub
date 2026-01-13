# Wallet Hub Demo Dapp

This is a tiny demo “dapp” that consumes **Wallet Hub** like a third-party integrator would.

It is intentionally **segregated** from the platform implementation:
- Platform/API lives in `services/wallet-hub-api`
- SDK/UI kit live in `packages/`
- This demo app lives in `apps/demo-dapp`

## Run

Prereqs:
- Wallet Hub API running (example: `http://localhost:3005/v1`)
- A platform API key (header `X-API-Key`)

Setup:

```bash
cp env.example .env
```

Then:

```bash
npm install
npm run dev
```

Open the printed local URL.

## What it demos

- Fetch unified portfolio via `GET /v1/portfolio/:address`
- Create an `arch.anchor` signing request (Turnkey signer)
- Create an `arch.transfer` signing request (Turnkey signer)
- Poll `GET /v1/signing-requests/:id` to display live `readiness`

