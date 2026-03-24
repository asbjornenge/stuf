import pg from 'pg';
import { randomBytes, createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { DATABASE_URL, MODE } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SPACE_ID = '00000000-0000-0000-0000-000000000000';

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
});

// --- Migrations ---

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const appliedSet = new Set(applied.rows.map(r => r.version));

  const migrationsDir = join(__dirname, 'migrations');
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.log(`Applying migration: ${file}`);
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
}

export async function initDB() {
  await runMigrations();

  // In standalone mode, ensure the default space exists
  if (getMode() === 'standalone') {
    const { rows } = await pool.query('SELECT id FROM spaces WHERE id = $1', [DEFAULT_SPACE_ID]);
    if (rows.length === 0) {
      await pool.query("INSERT INTO spaces (id, name) VALUES ($1, 'default')", [DEFAULT_SPACE_ID]);
    }
  }
}

// --- Mode helpers ---

export function getMode() {
  return MODE;
}

export function getDefaultSpaceId() {
  return DEFAULT_SPACE_ID;
}

// --- Server config (global, not space-scoped) ---

export async function getServerConfig(key) {
  const { rows } = await pool.query('SELECT value FROM server_config WHERE key = $1', [key]);
  return rows.length > 0 ? rows[0].value : null;
}

export async function setServerConfig(key, value) {
  await pool.query(
    'INSERT INTO server_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value]
  );
}

// --- Spaces ---

export async function createSpace(name) {
  const { rows } = await pool.query(
    'INSERT INTO spaces (name) VALUES ($1) RETURNING id',
    [name || null]
  );
  return rows[0].id;
}

export async function getSpace(spaceId) {
  const { rows } = await pool.query('SELECT * FROM spaces WHERE id = $1', [spaceId]);
  return rows[0] || null;
}

export async function setSpaceActive(spaceId, active) {
  await pool.query('UPDATE spaces SET active = $1 WHERE id = $2', [active, spaceId]);
}

// --- Config (space-scoped) ---

export async function getConfig(spaceId, key) {
  const { rows } = await pool.query(
    'SELECT value FROM config WHERE space_id = $1 AND key = $2',
    [spaceId, key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

export async function setConfig(spaceId, key, value) {
  await pool.query(
    `INSERT INTO config (space_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (space_id, key) DO UPDATE SET value = $3`,
    [spaceId, key, value]
  );
}

// --- Pairing ---

export async function initPairing(spaceId) {
  const existing = await getConfig(spaceId, 'pairing_token');
  if (existing) return existing;

  const isPaired = await getConfig(spaceId, 'paired');
  if (isPaired === 'true') return null;

  const token = randomBytes(32).toString('hex');
  await setConfig(spaceId, 'pairing_token', token);
  return token;
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function findSpaceByPairingToken(token) {
  const { rows } = await pool.query(
    "SELECT space_id FROM config WHERE key = 'pairing_token' AND value = $1",
    [token]
  );
  return rows.length > 0 ? rows[0].space_id : null;
}

export async function completePairing(spaceId, deviceTokenHash) {
  await pool.query(
    'INSERT INTO devices (space_id, token_hash) VALUES ($1, $2)',
    [spaceId, deviceTokenHash]
  );
  await setConfig(spaceId, 'paired', 'true');
  await pool.query(
    "DELETE FROM config WHERE space_id = $1 AND key = 'pairing_token'",
    [spaceId]
  );
}

// --- Devices ---

export async function findDevice(tokenHash) {
  const { rows } = await pool.query('SELECT * FROM devices WHERE token_hash = $1', [tokenHash]);
  return rows[0] || null;
}

export async function getDeviceCount(spaceId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as count FROM devices WHERE space_id = $1',
    [spaceId]
  );
  return parseInt(rows[0].count);
}

export async function getDevicesForSpace(spaceId) {
  const { rows } = await pool.query(
    'SELECT id, name, created_at FROM devices WHERE space_id = $1 ORDER BY created_at ASC',
    [spaceId]
  );
  return rows;
}

export async function updateDeviceName(deviceId, name) {
  await pool.query('UPDATE devices SET name = $1 WHERE id = $2', [name, deviceId]);
}

export async function deleteDevice(deviceId) {
  await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [deviceId]);
  await pool.query('DELETE FROM devices WHERE id = $1', [deviceId]);
}

// --- Invites ---

export async function createInvite(spaceId) {
  const token = randomBytes(32).toString('hex');
  const hash = hashToken(token);
  await pool.query('INSERT INTO invites (space_id, token_hash) VALUES ($1, $2)', [spaceId, hash]);
  return token;
}

export async function verifyAndConsumeInvite(token) {
  const hash = hashToken(token);
  const { rows } = await pool.query('SELECT * FROM invites WHERE token_hash = $1', [hash]);
  if (rows.length === 0) return null;
  const invite = rows[0];
  await pool.query('DELETE FROM invites WHERE token_hash = $1', [hash]);
  return invite.space_id;
}

export async function addDevice(spaceId, tokenHash) {
  await pool.query(
    'INSERT INTO devices (space_id, token_hash) VALUES ($1, $2)',
    [spaceId, tokenHash]
  );
}

// --- Snapshot ---

export async function storeSnapshot(spaceId, data, deviceId) {
  const lastSeq = await getLastSeq(spaceId);
  await setConfig(spaceId, 'snapshot', data);
  await setConfig(spaceId, 'snapshot_seq', String(lastSeq));
  await setConfig(spaceId, 'snapshot_device', String(deviceId));
}

export async function getSnapshot(spaceId) {
  const data = await getConfig(spaceId, 'snapshot');
  const seqStr = await getConfig(spaceId, 'snapshot_seq');
  const seq = parseInt(seqStr) || 0;
  return data ? { data, seq } : null;
}

// --- Changes ---

export async function storeChanges(spaceId, changes, deviceId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seqs = [];
    for (const data of changes) {
      const { rows } = await client.query(
        'INSERT INTO changes (space_id, data, device_id) VALUES ($1, $2, $3) RETURNING seq',
        [spaceId, data, deviceId]
      );
      seqs.push(rows[0].seq);
    }
    await client.query('COMMIT');
    return seqs;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getChangesSince(spaceId, since) {
  const { rows } = await pool.query(
    'SELECT seq, data FROM changes WHERE space_id = $1 AND seq > $2 ORDER BY seq ASC',
    [spaceId, since]
  );
  return rows;
}

export async function getLastSeq(spaceId) {
  const { rows } = await pool.query(
    'SELECT MAX(seq) as lastseq FROM changes WHERE space_id = $1',
    [spaceId]
  );
  return rows[0].lastseq || 0;
}

// --- Push Subscriptions ---

export async function storePushSubscription(spaceId, deviceId, subscription) {
  await pool.query(
    `INSERT INTO push_subscriptions (space_id, device_id, endpoint, keys_p256dh, keys_auth)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET device_id = $2, keys_p256dh = $4, keys_auth = $5`,
    [spaceId, deviceId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
}

export async function deletePushSubscription(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export async function getPushSubscriptionsForSpace(spaceId) {
  const { rows } = await pool.query(
    'SELECT * FROM push_subscriptions WHERE space_id = $1',
    [spaceId]
  );
  return rows;
}

// --- Reminders ---

export async function storeReminder(spaceId, taskId, title, notifyAt) {
  await pool.query(
    `INSERT INTO reminders (space_id, task_id, title, notify_at, sent)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (space_id, task_id) DO UPDATE SET title = $3, notify_at = $4, sent = 0`,
    [spaceId, taskId, title, Math.floor(notifyAt / 1000)]
  );
}

export async function deleteReminder(spaceId, taskId) {
  await pool.query(
    'DELETE FROM reminders WHERE space_id = $1 AND task_id = $2',
    [spaceId, taskId]
  );
}

export async function getDueReminders() {
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await pool.query(
    'SELECT * FROM reminders WHERE notify_at <= $1 AND sent = 0',
    [now]
  );
  return rows;
}

export async function markReminderSent(id) {
  await pool.query('UPDATE reminders SET sent = 1 WHERE id = $1', [id]);
}

export async function setSpaceSubscription(spaceId, customerId, subscriptionId) {
  await pool.query(
    'UPDATE spaces SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3',
    [customerId, subscriptionId, spaceId]
  );
}

export async function getSpaceBySubscription(subscriptionId) {
  const { rows } = await pool.query(
    'SELECT * FROM spaces WHERE stripe_subscription_id = $1',
    [subscriptionId]
  );
  return rows[0] || null;
}

export async function setSubscriptionStatus(spaceId, status) {
  const active = status === 'active';
  await pool.query(
    'UPDATE spaces SET subscription_status = $1, active = $2 WHERE id = $3',
    [status, active, spaceId]
  );
}

export async function upsertSharedNote(id, content) {
  if (id) {
    const { rows } = await pool.query(
      'UPDATE shared_notes SET content = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [content, id]
    );
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await pool.query(
    'INSERT INTO shared_notes (content) VALUES ($1) RETURNING id',
    [content]
  );
  return rows[0].id;
}

export async function getSharedNote(id) {
  const { rows } = await pool.query('SELECT * FROM shared_notes WHERE id = $1', [id]);
  return rows[0] || null;
}

export default pool;
