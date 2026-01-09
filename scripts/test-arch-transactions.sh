#!/bin/bash
# Test script for Arch transaction endpoints
# Usage: ./scripts/test-arch-transactions.sh

BASE_URL="${BASE_URL:-http://localhost:3001/v1}"
IDEMPOTENCY_KEY="test-$(date +%s)"

echo "Testing Arch transaction endpoints..."
echo "Base URL: $BASE_URL"
echo ""

# First, we need a Turnkey wallet resource
echo "Step 1: Create a Turnkey wallet (if you don't have one)..."
echo "POST $BASE_URL/turnkey/wallets"
echo "Headers: Idempotency-Key: $IDEMPOTENCY_KEY-wallet"
echo "Body: {\"walletName\": \"test-wallet\"}"
echo ""

# Test system transfer endpoint
echo "Step 2: Test system transfer endpoint..."
echo "POST $BASE_URL/arch/transfer"
echo "Headers:"
echo "  Idempotency-Key: $IDEMPOTENCY_KEY-transfer"
echo "  Content-Type: application/json"
echo ""
echo "Body example:"
cat <<EOF
{
  "userId": "your-user-id",
  "resourceId": "your-turnkey-resource-id",
  "toAddress": "tb1p... (Taproot address) or arch account address",
  "lamports": "1000000"
}
EOF
echo ""
echo ""

# Test generic instruction builder
echo "Step 3: Test generic instruction builder..."
echo "POST $BASE_URL/arch/instructions/build"
echo "Headers:"
echo "  Idempotency-Key: $IDEMPOTENCY_KEY-instructions"
echo "  Content-Type: application/json"
echo ""
echo "Body example:"
cat <<EOF
{
  "userId": "your-user-id",
  "resourceId": "your-turnkey-resource-id",
  "instructions": [
    {
      "programId": "11111111111111111111111111111111",
      "accounts": [
        {
          "pubkey": "your-pubkey-base58",
          "isSigner": true,
          "isWritable": true
        }
      ],
      "data": "01020304"
    }
  ]
}
EOF
echo ""

echo ""
echo "Note: You'll need:"
echo "  1. Valid Turnkey credentials in .env"
echo "  2. A created Turnkey wallet (resourceId)"
echo "  3. ARCH_RPC_NODE_URL pointing to a valid Arch Network RPC node"
echo "  4. The server restarted to pick up new routes"
