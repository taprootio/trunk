ALTER TABLE webhook_operations
  ADD COLUMN IF NOT EXISTS response_reservation_bytes integer NOT NULL DEFAULT 4096
  CHECK (response_reservation_bytes >= 0);
