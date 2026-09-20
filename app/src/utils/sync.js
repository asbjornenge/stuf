/**
 * Sync manager — push/pull of encrypted Automerge changes with the
 * stuf-server, plus WebSocket for real-time updates.
 *
 * Model:
 * - The server keeps an append-only log of encrypted changes (with a
 *   plaintext change hash for de-duplication) and one encrypted snapshot.
 * - What to push is derived from the document: "changes since the heads the
 *   server is known to have" (see crdt.js). Re-pushing is always safe.
 * - Pulls are paged by seq cursor. A device with unknown server state
 *   (fresh, imported, upgraded, or after "Recover Sync") reconciles: it loads
 *   the server snapshot + changes since, merges, and pushes what the server
 *   lacks. It never downloads the whole log.
 */

import * as Sentry from '@sentry/browser';
import * as Automerge from '@automerge/automerge';
import { encryptChange, decryptChange } from './crypto.js';
import {
  applyRemoteChanges, getUnpushed, needsReconcile, markPushed, markUnknown,
  mergeServerDoc, changeHash, setOnLocalChange, saveDocumentSnapshot,
} from './crdt.js';

let _config = null;           // { serverUrl, deviceToken }
let _ws = null;
let _wsRetryTimer = null;
let _onRemoteChanges = null;  // callback when remote changes are applied
let _onSyncError = null;      // callback when sync errors occur
let _pushing = null;          // in-flight push promise
let _pushAgain = false;       // a change arrived while pushing
let _pulling = null;          // in-flight pull promise
let _reconciling = null;      // in-flight reconcile promise

const CONFIG_KEY = 'stuf-sync-config';
const SEQ_KEY = 'stuf-last-seq';
const PULL_PAGE = 500;   // changes per pull request
const PUSH_BATCH = 200;  // changes per push request

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
  } catch { /* corrupt config, treat as none */ }
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
    let err;
    if (body.error === 'space_inactive') {
      err = new Error('Your sync subscription has expired. Please renew to continue syncing.');
    } else {
      err = new Error(body.error || `HTTP ${res.status}`);
    }
    err.status = res.status;
    err.body = body;
    throw err;
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

// --- Push ---

async function toEntry(change) {
  return { data: await encryptChange(change), hash: changeHash(change) };
}

async function postChanges(changes, onProgress) {
  for (let i = 0; i < changes.length; i += PUSH_BATCH) {
    const batch = changes.slice(i, i + PUSH_BATCH);
    const entries = await Promise.all(batch.map(toEntry));
    await apiFetch('/changes', {
      method: 'POST',
      body: JSON.stringify({ changes: entries, formatVersion: 3 }),
    });
    onProgress?.(Math.min(i + PUSH_BATCH, changes.length), changes.length);
  }
}

// Push everything the server lacks. The heads are captured together with
// the changes, so a local change made while the request is in flight is
// not covered by them and is picked up by the next push.
async function pushOnce() {
  if (needsReconcile()) {
    await reconcile();
    return;
  }
  const unpushed = getUnpushed();
  if (unpushed === null) {
    await reconcile();
    return;
  }
  if (unpushed.changes.length === 0) return;
  await postChanges(unpushed.changes);
  await markPushed(unpushed.heads);
}

// Single-flight push. Calls while a push is running mark it to run again
// afterwards, so nothing is skipped. Never throws; errors are reported and
// the changes stay unpushed until the next attempt.
function schedulePush() {
  if (!getSyncConfig()) return Promise.resolve(false);
  if (_pushing) {
    _pushAgain = true;
    return _pushing;
  }
  _pushing = (async () => {
    let ok = true;
    try {
      do {
        _pushAgain = false;
        await pushOnce();
      } while (_pushAgain);
    } catch (err) {
      ok = false;
      reportSyncError('push', err);
    } finally {
      _pushing = null;
    }
    return ok;
  })();
  return _pushing;
}

// Kept for callers that pass the change they just made; the push itself is
// derived from the document, so the argument is not needed.
export function pushChanges() {
  return schedulePush();
}

export async function pushAllLocalChanges() {
  return schedulePush();
}

// --- Pull ---

async function decryptAll(entries) {
  return Promise.all(entries.map(c => decryptChange(c.data)));
}

async function pullLoop() {
  if (needsReconcile()) {
    await reconcile();
    return true;
  }
  let received = false;
  for (;;) {
    let page;
    try {
      page = await apiFetch(`/changes?since=${loadLastSeq()}&limit=${PULL_PAGE}`);
    } catch (err) {
      if (err.status === 410) {
        // Our cursor predates compacted history: start over from the snapshot.
        await reconcile();
        return true;
      }
      throw err;
    }

    if (page.changes.length > 0) {
      const decrypted = await decryptAll(page.changes);
      let persisted = true;
      try {
        await applyRemoteChanges(decrypted);
      } catch (err) {
        // Applied in memory but not on disk. Show them, but keep the cursor so
        // they are pulled again (idempotent) once storage works.
        persisted = false;
        reportSyncError('persist-remote', err);
      }
      _onRemoteChanges?.();
      if (!persisted) return true;
      received = true;
    }

    saveLastSeq(page.lastSeq);
    if (!page.hasMore) return received;
  }
}

// Single-flight pull of everything after our cursor, page by page.
export function pullChanges() {
  if (!getSyncConfig()) return Promise.resolve(false);
  if (_pulling) return _pulling;
  _pulling = (async () => {
    try {
      return await pullLoop();
    } finally {
      _pulling = null;
    }
  })();
  return _pulling;
}

// --- Reconcile ---
//
// Build the server's document from its snapshot plus the changes after it,
// merge it into ours, push whatever the server lacks, and record the result
// as the new known server state. This is the only path that ever loads
// server history without a cursor, and it is bounded by snapshot size +
// changes since the snapshot, never by total history.
function reconcile(onProgress) {
  if (_reconciling) return _reconciling;
  _reconciling = (async () => {
    Sentry.addBreadcrumb({ category: 'sync', message: 'reconcile' });

    let serverDoc;
    let cursor = 0;
    try {
      const snap = await apiFetch('/changes/snapshot');
      serverDoc = Automerge.load(await decryptChange(snap.data));
      cursor = snap.seq || 0;
    } catch (err) {
      if (err.status !== 404) throw err;
      serverDoc = Automerge.init();
    }

    for (;;) {
      const page = await apiFetch(`/changes?since=${cursor}&limit=${PULL_PAGE}`);
      if (page.changes.length > 0) {
        [serverDoc] = Automerge.applyChanges(serverDoc, await decryptAll(page.changes));
      }
      cursor = page.lastSeq;
      if (!page.hasMore) break;
    }

    const { toPush, heads } = await mergeServerDoc(serverDoc);
    saveLastSeq(cursor);
    _onRemoteChanges?.();

    await postChanges(toPush, onProgress);
    await markPushed(heads);
    return toPush.length;
  })().finally(() => {
    _reconciling = null;
  });
  return _reconciling;
}

// "Recover Sync": forget what we think the server has and reconcile.
// Safe to run any time; cost is one snapshot download plus the local diff.
export async function recoverSync(onProgress) {
  if (!getSyncConfig()) throw new Error('Not configured');
  await markUnknown();
  return reconcile(onProgress);
}

// Used when joining a space on a fresh device: adopt the server's document.
export async function pullSnapshot() {
  await markUnknown();
  await reconcile();
}

// --- Snapshot push ---

async function pushSnapshot() {
  const snapshot = saveDocumentSnapshot();
  const encrypted = await encryptChange(snapshot);
  await apiFetch('/changes/snapshot', {
    method: 'POST',
    // `seq` tells the server which changes the snapshot already contains.
    body: JSON.stringify({ snapshot: encrypted, seq: loadLastSeq() }),
  });
}

// Periodic snapshot push (max once per 24h), only when fully in sync so the
// reported seq is exact.
const SNAPSHOT_MIN_INTERVAL = 24 * 60 * 60 * 1000;
const SNAPSHOT_TS_KEY = 'stuf-last-snapshot-push';

async function maybePushSnapshot() {
  if (needsReconcile()) return;
  const unpushed = getUnpushed();
  if (!unpushed || unpushed.changes.length > 0) return;

  const lastPush = parseInt(localStorage.getItem(SNAPSHOT_TS_KEY)) || 0;
  if (Date.now() - lastPush < SNAPSHOT_MIN_INTERVAL) return;

  await pushSnapshot();
  localStorage.setItem(SNAPSHOT_TS_KEY, String(Date.now()));
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
 * Initialize sync: push what the server lacks, pull remote changes, connect WebSocket.
 * @param {Function} onRemoteChanges — called when remote changes are applied
 * @param {Function} onSyncError — called with (context, message) when sync errors occur
 */
export async function initSync(onRemoteChanges, onSyncError) {
  _onRemoteChanges = onRemoteChanges;
  _onSyncError = onSyncError || null;

  // Every local change kicks a push; what to send is derived from the document.
  setOnLocalChange(() => { schedulePush(); });

  if (!getSyncConfig()) return;

  // Post-migration: push new snapshot and set format version on space
  if (localStorage.getItem('stuf-needs-migration-push')) {
    try {
      await apiFetch('/changes/format-version', {
        method: 'POST',
        body: JSON.stringify({ version: 3 }),
      });
      await pushSnapshot();
      await markUnknown();
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
  } catch {
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

  await pushAllLocalChanges();

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
