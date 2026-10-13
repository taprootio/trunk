ALTER TABLE installations ADD COLUMN IF NOT EXISTS credential_id uuid;
ALTER TABLE installations ADD COLUMN IF NOT EXISTS source_engagement_id uuid;
ALTER TABLE installations ADD COLUMN IF NOT EXISTS session_cutoff_revision integer NOT NULL DEFAULT 0;

ALTER TABLE settings_sessions ADD COLUMN IF NOT EXISTS credential_id uuid;
ALTER TABLE settings_sessions ADD COLUMN IF NOT EXISTS engagement_id uuid;
ALTER TABLE settings_sessions ADD COLUMN IF NOT EXISTS lifecycle_cutoff_revision integer NOT NULL DEFAULT 0;
