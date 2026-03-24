-- Global server config (VAPID keys etc, not space-scoped)
CREATE TABLE server_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Migrate VAPID keys from config to server_config
INSERT INTO server_config (key, value)
  SELECT key, value FROM config WHERE key IN ('vapid_public_key', 'vapid_private_key')
  ON CONFLICT DO NOTHING;
DELETE FROM config WHERE key IN ('vapid_public_key', 'vapid_private_key');

-- Spaces
CREATE TABLE spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  active BOOLEAN DEFAULT true,
  created_at INTEGER DEFAULT (extract(epoch FROM now())::integer)
);

-- Default space for existing data
INSERT INTO spaces (id, name) VALUES ('00000000-0000-0000-0000-000000000000', 'default');

-- config: add space_id, change primary key
ALTER TABLE config ADD COLUMN space_id UUID REFERENCES spaces(id);
UPDATE config SET space_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE config ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE config DROP CONSTRAINT config_pkey;
ALTER TABLE config ADD PRIMARY KEY (space_id, key);

-- devices: add space_id, update unique constraint
ALTER TABLE devices ADD COLUMN space_id UUID REFERENCES spaces(id);
UPDATE devices SET space_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE devices ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE devices DROP CONSTRAINT devices_token_hash_key;
ALTER TABLE devices ADD CONSTRAINT devices_space_token_unique UNIQUE (space_id, token_hash);

-- invites: add space_id
ALTER TABLE invites ADD COLUMN space_id UUID REFERENCES spaces(id);
UPDATE invites SET space_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE invites ALTER COLUMN space_id SET NOT NULL;

-- changes: add space_id
ALTER TABLE changes ADD COLUMN space_id UUID REFERENCES spaces(id);
UPDATE changes SET space_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE changes ALTER COLUMN space_id SET NOT NULL;

-- push_subscriptions: add space_id
ALTER TABLE push_subscriptions ADD COLUMN space_id UUID REFERENCES spaces(id);
UPDATE push_subscriptions SET space_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE push_subscriptions ALTER COLUMN space_id SET NOT NULL;

-- reminders: add space_id, update unique constraint
ALTER TABLE reminders ADD COLUMN space_id UUID REFERENCES spaces(id);
UPDATE reminders SET space_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE reminders ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE reminders DROP CONSTRAINT reminders_task_id_key;
ALTER TABLE reminders ADD CONSTRAINT reminders_space_task_unique UNIQUE (space_id, task_id);
