# Wallet Hub UI Components

React components for displaying Arch L2 data that Bitcoin wallets cannot show.

## Why These Components?

Native Bitcoin wallets (Xverse, Unisat, etc.) **cannot display Arch L2 data**:
- ❌ Arch L2 token balances (APL tokens, LP tokens)
- ❌ Arch transaction previews
- ❌ Arch account status/readiness

**Wallet Hub UI components** provide this missing functionality in your dApp frontend.

## Installation

```bash
npm install @arch/wallet-hub-ui @arch/wallet-hub-sdk
```

## Components

### PortfolioPanel

Displays unified BTC + Arch L2 balances. **Required** when using external Bitcoin wallets.

```tsx
import { PortfolioPanel, usePortfolio } from "@arch/wallet-hub-ui";
import { WalletHubClient } from "@arch/wallet-hub-sdk";

function MyApp() {
  const client = new WalletHubClient({ baseUrl: "...", apiKey: "..." });
  const { data: portfolio, refresh } = usePortfolio({ 
    client, 
    address: "tb1p..." // Taproot address
  });

  if (!portfolio) return <div>Loading...</div>;

  return (
    <PortfolioPanel portfolio={portfolio} />
  );
}
```

**Features:**
- Shows BTC balance (L1)
- Shows ARCH balance (L2) - **not visible in Bitcoin wallets**
- Shows Arch L2 tokens (APL, LP tokens) - **not visible in Bitcoin wallets**
- Highlights that L2 data is supplemental

### TransactionPreview

Displays human-readable transaction details from Wallet Hub's `display` metadata.

```tsx
import { TransactionPreview } from "@arch/wallet-hub-ui";

function SigningFlow({ signingRequest }) {
  return (
    <div>
      <h2>Review Transaction</h2>
      <TransactionPreview signingRequest={signingRequest} />
      {/* Your signing UI */}
    </div>
  );
}
```

**Features:**
- Shows "Send 10 APL to Alice" instead of opaque hash
- Displays warnings (e.g., insufficient confirmations)
- Works with `arch.transfer` and `arch.anchor` actions

### SigningRequestStatus

Shows transaction status and readiness information.

```tsx
import { SigningRequestStatus } from "@arch/wallet-hub-ui";

function TransactionStatus({ signingRequest }) {
  return (
    <SigningRequestStatus signingRequest={signingRequest} />
  );
}
```

**Features:**
- Status indicators (pending, succeeded, failed)
- Readiness status (ready, not_ready, unknown)
- BTC confirmation progress
- Account anchoring status
- Error messages

## Complete Example

```tsx
import { 
  PortfolioPanel, 
  TransactionPreview, 
  SigningRequestStatus,
  usePortfolio 
} from "@arch/wallet-hub-ui";
import { WalletHubClient } from "@arch/wallet-hub-sdk";

function MyDApp() {
  const client = new WalletHubClient({ baseUrl: "...", apiKey: "..." });
  const [address, setAddress] = useState("tb1p..."); // From Xverse/Unisat
  const { data: portfolio } = usePortfolio({ client, address });

  const [signingRequest, setSigningRequest] = useState(null);

  // Create signing request
  const handleSend = async () => {
    const sr = await client.createSigningRequest({
      externalUserId: "user-123",
      signer: { kind: "external", taprootAddress: address },
      action: { type: "arch.transfer", toAddress: "...", lamports: "1000000000" }
    });
    setSigningRequest(sr);
  };

  return (
    <div>
      {/* Show Arch L2 balances (not in Bitcoin wallet) */}
      {portfolio && <PortfolioPanel portfolio={portfolio} />}

      {signingRequest && (
        <div>
          {/* Show transaction preview (not in Bitcoin wallet) */}
          <TransactionPreview signingRequest={signingRequest} />
          
          {/* User signs with Xverse/Unisat */}
          <button onClick={signWithXverse}>Sign with Xverse</button>
        </div>
      )}

      {/* Show status */}
      {signingRequest && <SigningRequestStatus signingRequest={signingRequest} />}
    </div>
  );
}
```

## Styling

Components use inline styles by default. You can override with `className` prop or CSS:

```tsx
<PortfolioPanel 
  portfolio={portfolio} 
  className="my-portfolio" 
/>
```

```css
.my-portfolio {
  /* Your custom styles */
}
```

## Architecture

These components are **essential** when using external Bitcoin wallets because:

1. **Bitcoin wallets** can only show BTC balances
2. **Wallet Hub** provides Arch L2 data via API
3. **These components** display that data in your dApp UI

Without these components, users with Xverse/Unisat would see:
- ✅ BTC balance (in wallet)
- ❌ No Arch L2 balance (missing)
- ❌ No transaction preview (missing)
- ❌ No status information (missing)

With these components, users see:
- ✅ BTC balance (in wallet)
- ✅ Arch L2 balance (in dApp UI)
- ✅ Transaction preview (in dApp UI)
- ✅ Status information (in dApp UI)
