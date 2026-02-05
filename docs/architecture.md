# Wallet Hub Architecture

## Overview

Wallet Hub is a **multi-tenant, API-first platform** that bridges the gap between Bitcoin wallets (like Xverse, Unisat) and the Arch Network L2 ecosystem. It provides the **data layer and transaction orchestration** that native Bitcoin wallets cannot provide.

## Core Problem

Native Bitcoin wallets (Xverse, Unisat, etc.) are designed for Bitcoin L1. They:
- ✅ Can sign Bitcoin transactions
- ✅ Display BTC balances
- ❌ **Cannot index Arch L2 tokens** (ARCH gas, APL tokens, LP tokens, etc.)
- ❌ **Cannot display Arch transaction previews** (they see opaque hashes)
- ❌ **Don't understand Arch account mapping** (Taproot → Arch account address)

## Solution: Wallet Hub as Supplemental Layer

Wallet Hub **supplements** external Bitcoin wallets by providing:

### 1. **Arch L2 Data Layer**
- Indexes and aggregates Arch L2 balances (ARCH, APL tokens, LP positions)
- Queries both Arch Indexer (for L2 data) and Titan BTC Indexer (for L1 data)
- Provides unified portfolio view that Bitcoin wallets cannot show

### 2. **Transaction Orchestration**
- Crafts canonical Arch transactions
- Maps Taproot addresses to Arch account addresses
- Builds BIP-322 signing payloads
- Broadcasts signed transactions to Arch RPC

### 3. **Transaction Previews**
- Generates human-readable `display` metadata for transactions
- Shows "Send 10 APL to Alice" instead of opaque hash
- Provides Phantom/MetaMask-like UX in dApp UI

## Architecture Patterns

### Pattern 1: External Wallet (Xverse/Unisat)

```
User → Xverse/Unisat Wallet → Signs Transaction
  ↓
dApp Frontend → Wallet Hub API → Provides:
  - Arch L2 balances (displayed in dApp UI)
  - Transaction preview (displayed in dApp UI)
  - Transaction crafting (BIP-322 payload)
  - Broadcasting (to Arch RPC)
```

**Key Points:**
- User signs with their existing Bitcoin wallet
- Wallet Hub provides all Arch-specific functionality
- dApp UI displays Arch L2 data (wallet cannot)
- Wallet Hub orchestrates the transaction flow

### Pattern 2: Embedded Wallet (Turnkey)

```
User → dApp → Wallet Hub API → Turnkey
  ↓
Creates embedded wallet (passkey-based)
  ↓
Wallet Hub provides:
  - Wallet creation/management
  - Signing orchestration
  - Arch L2 data layer
  - Transaction crafting & broadcasting
```

**Key Points:**
- User creates new wallet within dApp
- Turnkey handles key management/signing
- Wallet Hub provides Arch ecosystem layer
- Full non-custodial experience via passkeys

## Why This Design?

### Separation of Concerns

1. **Bitcoin Wallets** = Signing infrastructure
   - Handle key management
   - Sign transactions
   - Display BTC balances

2. **Wallet Hub** = Arch ecosystem layer
   - Arch L2 indexing
   - Transaction crafting
   - Account mapping
   - Unified portfolio

3. **dApp Frontend** = User experience
   - Displays Arch L2 balances (via Wallet Hub)
   - Shows transaction previews (via Wallet Hub)
   - Orchestrates signing flow

### Benefits

- **No wallet modifications needed**: Xverse/Unisat work as-is
- **Consistent UX**: All dApps use same Wallet Hub APIs
- **Rich previews**: dApps show Arch transaction details
- **Unified data**: Single source of truth for Arch L2 state

## Data Flow Example

### User with Xverse Wallet Wants to Send APL

1. **dApp calls Wallet Hub**: `POST /signing-requests`
   - Provides: Xverse Taproot address, recipient, amount
   - Wallet Hub returns:
     - `payloadToSign`: BIP-322 hash to sign
     - `display`: `{ from: "Alice", to: "Bob", amount: "10 APL", token: "APL" }`

2. **dApp displays preview** (using `display` metadata):
   ```
   Send 10 APL to Bob
   From: tb1p... (Alice's address)
   ```

3. **User signs with Xverse**:
   - dApp prompts Xverse to sign `payloadToSign`
   - Xverse shows generic "Sign message" (can't show Arch details)
   - User approves in Xverse
   - Xverse returns signature

4. **dApp submits signature**: `POST /signing-requests/:id/submit`
   - Wallet Hub verifies signature
   - Wallet Hub crafts Arch transaction
   - Wallet Hub broadcasts to Arch RPC

5. **dApp displays result**:
   - Transaction hash
   - Updated balances (fetched from Wallet Hub)

## UI Components

Since Bitcoin wallets cannot display Arch L2 data, Wallet Hub provides UI components:

- **PortfolioPanel**: Shows unified BTC + Arch L2 balances
- **TransactionPreview**: Displays human-readable transaction details
- **SigningRequestStatus**: Shows transaction readiness/status

These components are **required** when using external wallets, as the wallet itself cannot show this information.

## API Design

### Signer Types

```typescript
signer: 
  | { kind: "external", taprootAddress: string }  // Xverse/Unisat
  | { kind: "turnkey", resourceId: string }       // Embedded wallet
```

### Signing Request Response

```typescript
{
  payloadToSign: { ... },  // What wallet signs (opaque to wallet)
  display: { ... }         // What dApp shows (human-readable)
}
```

This separation allows:
- Wallet to sign generic payload (works with any Bitcoin wallet)
- dApp to show rich preview (Arch-aware)

## Summary

**Wallet Hub = The Arch ecosystem layer that Bitcoin wallets don't have**

- External wallets (Xverse/Unisat) handle signing
- Wallet Hub handles everything Arch-specific
- dApp UI displays Arch L2 data using Wallet Hub components
- Result: Seamless experience despite wallet limitations
