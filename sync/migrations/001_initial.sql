CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at INTEGER DEFAULT (extract(epoch FROM now())::integer)
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER DEFAULT (extract(epoch FROM now())::integer)
);

CREATE TABLE IF NOT EXISTS changes (
  seq SERIAL PRIMARY KEY,
  data TEXT NOT NULL,
  device_id INTEGER,
  created_at INTEGER DEFAULT (extract(epoch FROM now())::integer)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at INTEGER DEFAULT (extract(epoch FROM now())::integer)
);

CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  title TEXT,
  notify_at INTEGER NOT NULL,
  sent INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (extract(epoch FROM now())::integer)
);
