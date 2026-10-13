CREATE TABLE IF NOT EXISTS webhook_operations (
  delivery_id uuid NOT NULL REFERENCES webhook_receipts(delivery_id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  lease_token uuid NOT NULL,
  retry_safe boolean NOT NULL,
  request_ciphertext bytea NOT NULL,
  request_nonce bytea NOT NULL,
  request_tag bytea NOT NULL,
  response_ciphertext bytea,
  response_nonce bytea,
  response_tag bytea,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (delivery_id, operation_key),
  CHECK ((response_ciphertext IS NULL AND response_nonce IS NULL AND response_tag IS NULL)
    OR (response_ciphertext IS NOT NULL AND response_nonce IS NOT NULL AND response_tag IS NOT NULL))
);
