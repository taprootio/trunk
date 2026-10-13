-- A deployment can briefly overlap its replacement. At most one receipt for
-- an installation may perform effects at a time, even across processes.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_receipts_one_processing_installation
  ON webhook_receipts (installation_id)
  WHERE status = 'processing';
