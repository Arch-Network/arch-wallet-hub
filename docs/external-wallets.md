# External Wallet Integration Guide

## Overview

This guide explains how external Bitcoin wallets (Xverse, Unisat, etc.) integrate with Wallet Hub and why UI components are required.

## The Problem

Native Bitcoin wallets are designed for Bitcoin L1. They **cannot**:
- Index Arch L2 tokens (APL, LP tokens)
- Display Arch transaction previews
- Understand Arch account mapping

## The Solution

**Wallet Hub** provides the missing Arch ecosystem layer, and **UI components** display this data in your dApp.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's dApp                          │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌─────────────────────────────────┐  │
│  │ Xverse/Unisat │  │  Wallet Hub UI Components      │  │
│  │   (Wallet)    │  │  (PortfolioPanel, etc.)        │  │
│  │               │  │                                │  │
│  │ Shows:        │  │ Shows:                         │  │
│  │ • BTC balance │  │ • Arch L2 balances             │  │
│  │ • Signs tx    │  │ • Transaction previews        │  │
│  │               │  │ • Status/readiness            │  │
│  └──────────────┘  └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
                  ┌───────────────┐
                  │  Wallet Hub   │
                  │     API       │
                  │               │
                  │ • Arch Indexer│
                  │ • BTC Indexer │
                  │ • Tx Building │
                  │ • Broadcasting│
                  └───────────────┘
```

## Integration Flow

### 1. User Connects Wallet

```typescript
// User connects Xverse/Unisat
const address = await window.xverse.requestAccounts();
// address = "tb1p..."
```

### 2. Display Portfolio (Required UI Component)

```tsx
import { PortfolioPanel, usePortfolio } from "@arch/wallet-hub-ui";

function MyApp() {
  const { data: portfolio } = usePortfolio({ 
    client, 
    address: "tb1p..." 
  });

  return (
    <div>
      {/* Wallet shows BTC, but NOT Arch L2 */}
      {/* PortfolioPanel shows Arch L2 data */}
      <PortfolioPanel portfolio={portfolio} />
    </div>
  );
}
```

**Why needed:** Bitcoin wallet cannot show Arch L2 balances. PortfolioPanel displays:
- BTC balance (also in wallet)
- ARCH balance (L2) - **only in dApp**
- APL tokens (L2) - **only in dApp**

### 3. Create Transaction

```typescript
const signingRequest = await client.createSigningRequest({
  externalUserId: "user-123",
  signer: { 
    kind: "external",  // Using Xverse/Unisat
    taprootAddress: address 
  },
  action: { 
    type: "arch.transfer", 
    toAddress: "...", 
    lamports: "1000000000" 
  }
});
```

### 4. Display Transaction Preview (Required UI Component)

```tsx
import { TransactionPreview } from "@arch/wallet-hub-ui";

<TransactionPreview signingRequest={signingRequest} />
```

**Why needed:** Bitcoin wallet shows generic "Sign message" prompt. TransactionPreview shows:
- "Send 10 APL to Alice" (human-readable)
- From/to addresses
- Warnings (e.g., insufficient confirmations)

### 5. User Signs with Wallet

```typescript
// User signs with Xverse/Unisat
// Wallet shows generic prompt (can't show Arch details)
const signature = await window.xverse.signMessage(payloadToSign);
```

### 6. Submit Signature

```typescript
await client.submitSigningRequest(signingRequestId, {
  externalUserId: "user-123",
  signature64Hex: signature
});
```

### 7. Display Status (Required UI Component)

```tsx
import { SigningRequestStatus } from "@arch/wallet-hub-ui";

<SigningRequestStatus signingRequest={signingRequest} />
```

**Why needed:** Shows:
- Transaction status
- Readiness (e.g., waiting for BTC confirmations)
- Errors

## Key Points

### Turnkey vs External Wallets

- **Turnkey (Embedded)**: User creates wallet in-app, Turnkey manages keys
- **External (Xverse/Unisat)**: User uses existing wallet, Wallet Hub provides Arch layer

**Both need UI components** because Bitcoin wallets don't show Arch L2 data.

### What Wallet Hub Provides

1. **Data Layer**: Arch L2 indexing (tokens, balances)
2. **Transaction Crafting**: Builds Arch transactions
3. **Account Mapping**: Taproot → Arch account
4. **Broadcasting**: Submits to Arch RPC

### What UI Components Provide

1. **PortfolioPanel**: Shows Arch L2 balances
2. **TransactionPreview**: Shows transaction details
3. **SigningRequestStatus**: Shows status/readiness

**These are required** - without them, users see incomplete information.

## Example: Complete Flow

```tsx
import { 
  PortfolioPanel, 
  TransactionPreview, 
  SigningRequestStatus,
  usePortfolio 
} from "@arch/wallet-hub-ui";

function CompleteExample() {
  const [address, setAddress] = useState(null);
  const [signingRequest, setSigningRequest] = useState(null);
  
  const { data: portfolio, refresh } = usePortfolio({ 
    client, 
    address 
  });

  // 1. Connect wallet
  const connectWallet = async () => {
    const addr = await window.xverse.requestAccounts();
    setAddress(addr[0]);
  };

  // 2. Create transaction
  const createTx = async () => {
    const sr = await client.createSigningRequest({
      externalUserId: "user-123",
      signer: { kind: "external", taprootAddress: address },
      action: { type: "arch.transfer", toAddress: "...", lamports: "1000000000" }
    });
    setSigningRequest(sr);
  };

  // 3. Sign with wallet
  const signTx = async () => {
    const payload = signingRequest.payloadToSign.payloadHex;
    const sig = await window.xverse.signMessage(payload);
    
    await client.submitSigningRequest(signingRequest.signingRequestId, {
      externalUserId: "user-123",
      signature64Hex: sig
    });
    
    refresh(); // Update portfolio
  };

  return (
    <div>
      <button onClick={connectWallet}>Connect Xverse</button>
      
      {address && portfolio && (
        <PortfolioPanel portfolio={portfolio} />
      )}
      
      {signingRequest && (
        <>
          <TransactionPreview signingRequest={signingRequest} />
          <button onClick={signTx}>Sign with Xverse</button>
          <SigningRequestStatus signingRequest={signingRequest} />
        </>
      )}
    </div>
  );
}
```

## Summary

**External wallets (Xverse/Unisat) can be used**, but you **must** use Wallet Hub UI components to display Arch L2 data that the wallet cannot show.

- ✅ Wallet: Signs transactions, shows BTC balance
- ✅ Wallet Hub: Provides Arch L2 data, crafts transactions
- ✅ UI Components: Display Arch L2 data in dApp

Without UI components, users miss critical Arch L2 information.
