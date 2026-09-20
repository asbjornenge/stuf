-- Change de-duplication: clients send the Automerge change hash (plaintext,
-- reveals nothing about content) so re-pushing the same change is a no-op.
-- Legacy rows keep hash NULL; the unique index is partial so they never conflict.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS changes_space_hash_unique
  ON changes (space_id, hash) WHERE hash IS NOT NULL;
-- Paged pulls filter on (space_id, seq).
CREATE INDEX IF NOT EXISTS changes_space_seq ON changes (space_id, seq);
