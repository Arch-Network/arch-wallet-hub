CREATE TABLE IF NOT EXISTS signing_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'succeeded', 'failed')),

  -- signer selection
  signer_kind TEXT NOT NULL CHECK (signer_kind IN ('external', 'turnkey')),
  signer_address TEXT, -- taproot address for external signer (optional)
  turnkey_resource_id UUID REFERENCES turnkey_resources(id) ON DELETE SET NULL,

  -- what is being signed
  action_type TEXT NOT NULL, -- e.g. arch.transfer
  payload_to_sign JSONB NOT NULL, -- canonical object for clients (e.g., {kind:'bip322_psbt_base64', psbtBase64:'...'})
  display_json JSONB NOT NULL, -- human-readable intent preview for app UI

  -- submission results
  submitted_signature_json JSONB, -- client-provided signature payload (or turnkey activity)
  result_json JSONB, -- txid, activity ids, etc
  error_json JSONB,

  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signing_requests_app_user ON signing_requests(app_id, user_id);
CREATE INDEX IF NOT EXISTS idx_signing_requests_status ON signing_requests(status);
