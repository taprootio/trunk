CREATE TABLE IF NOT EXISTS pending_settings_handoffs (
  state uuid PRIMARY KEY,
  handoff_jti text NOT NULL UNIQUE,
  installation_id uuid NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  token_ciphertext bytea NOT NULL,
  token_nonce bytea NOT NULL,
  token_tag bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS pending_settings_handoffs_expiry_index
  ON pending_settings_handoffs (expires_at);
