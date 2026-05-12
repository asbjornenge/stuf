/**
 * Sync manager — handles push/pull of encrypted Automerge changes
 * with the stuf-server, plus WebSocket for real-time updates.
 */

import * as Sentry from '@sentry/browser';
import { encryptChange, decryptChange } from './crypto.js';
import { applyRemoteChanges, getUnpushedChanges, clearUnpushedChanges, saveSnapshot, setOnLocalChange, saveDocumentSnapshot, loadDocumentSnapshot, getAllLocalChanges } from './crdt.js';

let _config = null;       // { serverUrl, deviceToken }
let _lastSeq = 0;
let _ws = null;
let _wsRetryTimer = null;
let _onRemoteChanges = null;  // callback when remote changes are applied
let _onSyncError = null;      // callback when sync errors occur
let _pushQueue = [];
let _pushing = false;

const CONFIG_KEY = 'stuf-sync-config';
const SEQ_KEY = 'stuf-last-seq';

function isNetworkError(err) {
  const msg = err.message?.toLowerCase() || '';
  return msg.includes('failed to fetch') || msg.includes('load failed') || msg.includes('networkerror');
}

function reportSyncError(context, err) {
  console.warn(`Sync error (${context}):`, err.message);
  Sentry.addBreadcrumb({ category: 'sync', message: context, level: 'error' });
  if (isNetworkError(err)) return; // Don't notify UI for network errors
  Sentry.captureException(err, { tags: { syncContext: context } });
  _onSyncError?.(context, err.message);
}

// --- Config persistence ---

export function getSyncConfig() {
  if (_config) return _config;
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      _config = JSON.parse(stored);
      return _config;
    }
  } catch {}
  return null;
}

export function saveSyncConfig(config) {
  _config = config;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function clearSyncConfig() {
  _config = null;
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(SEQ_KEY);
}

export function resetLastSeq() {
  _lastSeq = 0;
  localStorage.removeItem(SEQ_KEY);
}

export function isSyncing() {
  return _config !== null;
}

export async function getSpaceInfo() {
  return apiFetch('/space-info');
}

export async function updateDeviceName(name) {
  return apiFetch('/device/name', {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
}

export async function deleteDevice(deviceId) {
  return apiFetch(`/device/${deviceId}`, { method: 'DELETE' });
}

export async function cancelSubscription() {
  return apiFetch('/subscription/cancel', { method: 'POST' });
}

export async function shareNotes(content, shareId) {
  return apiFetch('/share', {
    method: 'POST',
    body: JSON.stringify({ content, shareId }),
  });
}

export async function renewSubscription() {
  const appUrl = window.location.origin;
  const data = await apiFetch('/renew', {
    method: 'POST',
    body: JSON.stringify({
      successUrl: `${appUrl}?renew=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}?renew=cancel`,
    }),
  });
  return data;
}

export async function completeRenewal(sessionId) {
  return apiFetch('/renew/complete', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

// --- Purchase ---

const HOSTED_SYNC_URL = import.meta.env.VITE_HOSTED_SYNC_URL || 'https://sync.stufapp.net';

export async function createSelfHostedSpace(serverUrl) {
  const url = serverUrl.replace(/\/+$/, '');
  const res = await fetch(`${url}/api/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Space creation failed');
  }
  const { pairingToken } = await res.json();
  return { serverUrl: url, pairingToken };
}

export async function createCheckout() {
  const appUrl = window.location.origin;
  const res = await fetch(`${HOSTED_SYNC_URL}/api/spaces/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      successUrl: `${appUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}?checkout=cancel`,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Checkout failed');
  }
  return res.json();
}

export async function purchaseSpace(sessionId) {
  const res = await fetch(`${HOSTED_SYNC_URL}/api/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Space creation failed');
  }
  const { pairingToken } = await res.json();
  return { serverUrl: HOSTED_SYNC_URL, pairingToken };
}

function loadLastSeq() {
  try {
    return parseInt(localStorage.getItem(SEQ_KEY)) || 0;
  } catch { return 0; }
}

function saveLastSeq(seq) {
  _lastSeq = seq;
  localStorage.setItem(SEQ_KEY, String(seq));
}

// --- HTTP helpers ---

async function apiFetch(path, options = {}) {
  const config = getSyncConfig();
  if (!config) throw new Error('Not configured');

  const res = await fetch(`${config.serverUrl}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.deviceToken}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error === 'space_inactive') {
      throw new Error('Your sync subscription has expired. Please renew to continue syncing.');
    }
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// --- Pairing ---

export async function pairWithServer(serverUrl, pairingToken, deviceToken) {
  const res = await fetch(`${serverUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingToken, deviceToken }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Pairing failed');
  }

  saveSyncConfig({ serverUrl, deviceToken });
}

export async function pairWithInvite(serverUrl, inviteToken, deviceToken) {
  const res = await fetch(`${serverUrl}/api/pair/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteToken, deviceToken }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Invite pairing failed');
  }

  saveSyncConfig({ serverUrl, deviceToken });
}

export async function createInvite() {
  const result = await apiFetch('/invite', { method: 'POST' });
  return result.inviteToken;
}

// --- Change serialization (Automerge 3.x changes are Uint8Array) ---

function serializeChange(change) {
  // In 3.x, changes are already Uint8Array
  return Array.from(change);
}

function deserializeChange(bytes) {
  return new Uint8Array(bytes);
}

// --- Push changes to server ---

export async function pushChanges(changes) {
  if (!getSyncConfig()) return;

  // Queue changes
  _pushQueue.push(...changes);
  if (_pushing) return;

  _pushing = true;
  try {
    while (_pushQueue.length > 0) {
      const batch = _pushQueue.splice(0, _pushQueue.length);

      // Serialize + encrypt each change
      const encrypted = await Promise.all(
        batch.map(change => encryptChange(serializeChange(change)))
      );

      await apiFetch('/changes', {
        method: 'POST',
        body: JSON.stringify({ changes: encrypted, formatVersion: 3 }),
      });
    }
    // All queued changes pushed — save snapshot and clear unpushed
    await saveSnapshot();
    await clearUnpushedChanges();
  } catch (err) {
    reportSyncError('push', err);
    // Changes remain in unpushed store for retry
  } finally {
    _pushing = false;
  }
}

// --- Pull changes from server ---

export async function pullChanges() {
  if (!getSyncConfig()) return false;

  _lastSeq = loadLastSeq();

  const result = await apiFetch(`/changes?since=${_lastSeq}`);

  if (result.changes.length > 0) {
    // Decrypt + deserialize each change back to Automerge Uint8Array
    const decrypted = await Promise.all(
      result.changes.map(async c => {
        const bytes = await decryptChange(c.data);
        return deserializeChange(bytes);
      })
    );

    // Apply to local Automerge (saves snapshot internally)
    await applyRemoteChanges(decrypted);
    _onRemoteChanges?.();
  }

  saveLastSeq(result.lastSeq);
  return result.changes.length > 0;
}

// --- Snapshot (for initial sync) ---

async function pushSnapshot() {
  const snapshot = saveDocumentSnapshot();
  const encrypted = await encryptChange(snapshot);
  await apiFetch('/changes/snapshot', {
    method: 'POST',
    body: JSON.stringify({ snapshot: encrypted }),
  });
}

export async function pullSnapshot() {
  const result = await apiFetch('/changes/snapshot');
  const decrypted = await decryptChange(result.data);
  await loadDocumentSnapshot(decrypted);
  saveLastSeq(result.seq);
}

// --- Periodic snapshot push (max once per 24h) ---

const SNAPSHOT_MIN_INTERVAL = 24 * 60 * 60 * 1000;
const SNAPSHOT_TS_KEY = 'stuf-last-snapshot-push';

async function maybePushSnapshot() {
  const unpushed = await getUnpushedChanges();
  if (unpushed.length > 0) return;

  const lastPush = parseInt(localStorage.getItem(SNAPSHOT_TS_KEY)) || 0;
  if (Date.now() - lastPush < SNAPSHOT_MIN_INTERVAL) return;

  await pushSnapshot();
  localStorage.setItem(SNAPSHOT_TS_KEY, String(Date.now()));
}

// --- Recovery: re-push every local change, then re-pull everything from server ---
// Server stores duplicates; Automerge applies them idempotently on pull.
export async function recoverSync(onProgress) {
  if (!getSyncConfig()) throw new Error('Not configured');
  await pushAllLocalChanges();
  const all = getAllLocalChanges();
  const BATCH_SIZE = 200;
  for (let i = 0; i < all.length; i += BATCH_SIZE) {
    const batch = all.slice(i, i + BATCH_SIZE);
    const encrypted = await Promise.all(
      batch.map(c => encryptChange(serializeChange(c)))
    );
    await apiFetch('/changes', {
      method: 'POST',
      body: JSON.stringify({ changes: encrypted, formatVersion: 3 }),
    });
    onProgress?.(Math.min(i + BATCH_SIZE, all.length), all.length);
  }
  resetLastSeq();
  await pullChanges();
  return all.length;
}

// --- Push unpushed local changes ---

export async function pushAllLocalChanges() {
  if (!getSyncConfig()) return;

  const unpushed = await getUnpushedChanges();
  if (unpushed.length === 0) return;

  const BATCH_SIZE = 500;
  for (let i = 0; i < unpushed.length; i += BATCH_SIZE) {
    const batch = unpushed.slice(i, i + BATCH_SIZE);
    const encrypted = await Promise.all(
      batch.map(change => encryptChange(serializeChange(change)))
    );
    await apiFetch('/changes', {
      method: 'POST',
      body: JSON.stringify({ changes: encrypted, formatVersion: 3 }),
    });
  }

  await saveSnapshot();
  await clearUnpushedChanges();
}

// --- WebSocket ---

function connectWebSocket() {
  const config = getSyncConfig();
  if (!config) return;

  // Clear any pending retry before creating new connection
  if (_wsRetryTimer) {
    clearTimeout(_wsRetryTimer);
    _wsRetryTimer = null;
  }

  if (_ws) {
    _ws.close();
    _ws = null;
  }

  const wsProtocol = config.serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = config.serverUrl.replace(/^https?/, wsProtocol);
  const ws = new WebSocket(`${wsUrl}/api/ws?token=${config.deviceToken}`);
  _ws = ws;

  ws.onopen = async () => {
    Sentry.addBreadcrumb({ category: 'sync', message: 'WebSocket connected, syncing' });
    try {
      await pushAllLocalChanges();
      await pullChanges();
    } catch (err) {
      reportSyncError('sync-on-reconnect', err);
    }
  };

  ws.onmessage = async (event) => {
    if (_ws !== ws) return; // Stale connection, ignore
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'new_changes') {
        await pullChanges();
      }
    } catch (err) {
      reportSyncError('ws-message', err);
    }
  };

  ws.onclose = (event) => {
    if (_ws !== ws) return; // This connection was replaced, don't reconnect
    console.warn(`WS closed: code=${event.code} reason=${event.reason}`);
    _ws = null;
    if (_wsRetryTimer) clearTimeout(_wsRetryTimer);
    _wsRetryTimer = setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (err) => {
    console.warn('WS error:', err);
  };
}

// --- Init / Teardown ---

/**
 * Initialize sync: push unpushed, pull remote changes, connect WebSocket.
 * @param {Function} onRemoteChanges — called when remote changes are applied
 * @param {Function} onSyncError — called with (context, message) when sync errors occur
 */
export async function initSync(onRemoteChanges, onSyncError) {
  _onRemoteChanges = onRemoteChanges;
  _onSyncError = onSyncError || null;

  // Register hook to auto-push local changes to server
  setOnLocalChange((change) => {
    pushChanges([change]);
  });

  if (!getSyncConfig()) return;

  // Post-migration: push new snapshot and set format version on space
  if (localStorage.getItem('stuf-needs-migration-push')) {
    try {
      await apiFetch('/changes/format-version', {
        method: 'POST',
        body: JSON.stringify({ version: 3 }),
      });
      await pushSnapshot();
      resetLastSeq();
      localStorage.removeItem('stuf-needs-migration-push');
    } catch (err) {
      reportSyncError('migration-push', err);
    }
  }

  // Ensure space has format_version set (idempotent)
  try {
    await apiFetch('/changes/format-version', {
      method: 'POST',
      body: JSON.stringify({ version: 3 }),
    });
  } catch (err) {
    // Non-fatal — space may already have correct version
  }

  try {
    await pushAllLocalChanges();
    await pullChanges();
    await maybePushSnapshot();
  } catch (err) {
    reportSyncError('initial-sync', err);
  }

  connectWebSocket();

  // Push + pull when app returns to foreground
  document.addEventListener('visibilitychange', _onVisibilityChange);
}

async function _onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!getSyncConfig()) return;
  Sentry.addBreadcrumb({ category: 'sync', message: 'App became visible, syncing' });

  try {
    await pushAllLocalChanges();
  } catch (err) {
    reportSyncError('push-on-visibility', err);
  }

  try {
    await pullChanges();
  } catch (err) {
    reportSyncError('pull-on-visibility', err);
  }
}

export function teardownSync() {
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  if (_wsRetryTimer) {
    clearTimeout(_wsRetryTimer);
    _wsRetryTimer = null;
  }
  document.removeEventListener('visibilitychange', _onVisibilityChange);
  _onRemoteChanges = null;
  _onSyncError = null;
}
