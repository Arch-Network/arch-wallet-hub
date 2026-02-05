# Test Script Usage

## Test Signing Request Flow

Run the test script to programmatically test the signing request flow:

```bash
cd services/wallet-hub-api

# Set required environment variables
export WALLET_HUB_API_KEY="your-api-key-here"
export WALLET_HUB_BASE_URL="http://localhost:3005"
export EXTERNAL_USER_ID="test-user-1"  # Optional, defaults to "test-user-1"

# For Turnkey signing (required for Step 4)
export TURNKEY_ORG_ID="your-turnkey-org-id"
export TURNKEY_API_PUBLIC_KEY="your-turnkey-api-public-key"
export TURNKEY_API_PRIVATE_KEY="your-turnkey-api-private-key"

# Run the test
tsx scripts/test-signing-request.ts
```

The script will:
1. List existing wallets for the user
2. Create a signing request for an `arch.transfer` action
3. Check readiness status
4. Sign the payload using Turnkey
5. Submit the signature to the Wallet Hub
6. Display the result (transaction ID or error)

## Getting Your API Key

1. Set `PLATFORM_ADMIN_API_KEY` in `services/wallet-hub-api/.env`
2. Create an app:
   ```bash
   curl -X POST http://localhost:3005/v1/platform/apps \
     -H "X-API-Key: $PLATFORM_ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"name": "Test App"}'
   ```
3. Create an API key for the app:
   ```bash
   curl -X POST http://localhost:3005/v1/platform/apps/{appId}/api-keys \
     -H "X-API-Key: $PLATFORM_ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"name": "Test Key"}'
   ```
4. Use the returned `apiKey` as `WALLET_HUB_API_KEY`
