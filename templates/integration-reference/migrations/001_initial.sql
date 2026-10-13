CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  installation_id uuid PRIMARY KEY,
  integration_id uuid NOT NULL,
  site_id uuid NOT NULL,
  status text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  granted_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  publish_policy text NOT NULL,
  contract_version text NOT NULL,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_tag bytea,
  credential_issued_at timestamptz,
  credential_revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((credential_ciphertext IS NULL AND credential_nonce IS NULL AND credential_tag IS NULL)
    OR (credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL AND credential_tag IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  delivery_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  installation_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  site_id uuid NOT NULL,
  signing_key_id uuid NOT NULL,
  body_sha256 text NOT NULL,
  payload_ciphertext bytea NOT NULL,
  payload_nonce bytea NOT NULL,
  payload_tag bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('received', 'processing', 'retry', 'completed', 'terminal')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code text,
  CHECK ((lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS webhook_receipts_lease_index
  ON webhook_receipts (status, available_at, received_at);
CREATE INDEX IF NOT EXISTS webhook_receipts_installation_index
  ON webhook_receipts (installation_id, received_at);

CREATE TABLE IF NOT EXISTS settings_sessions (
  session_hash text PRIMARY KEY,
  handoff_jti text NOT NULL UNIQUE,
  installation_id uuid NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settings_sessions_expiry_index ON settings_sessions (expires_at);
