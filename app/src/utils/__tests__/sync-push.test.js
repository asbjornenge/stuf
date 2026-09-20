/**
 * Sync against a fake server that behaves like the real one: an append-only
 * change log with hash de-duplication, paged pulls, and one snapshot.
 *
 * The invariant under test: after any sequence of pushes, pulls, failures
 * and reconciles, every change this device made is on the server, and the
 * server never holds a change twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import * as Automerge from '@automerge/automerge';

vi.mock('@sentry/browser', () => ({
  addBreadcrumb: () => {},
  captureException: () => {},
}));

import {
  initCRDT, resetCRDT, _resetMemory, _getDB, getDocument, addTask, updateTask,
  getUnpushed, getUnpushedChanges, needsReconcile, markUnknown, setOnLocalChange,
  setOnPersistError, changeHash,
} from '../crdt.js';
import {
  saveSyncConfig, clearSyncConfig, pushChanges, pushAllLocalChanges, pullChanges,
  pullSnapshot, recoverSync, initSync, teardownSync,
} from '../sync.js';
import { encryptChange, decryptChange } from '../crypto.js';

// --- Fake server ----------------------------------------------------------

let server;
// Hook run when the server receives a POST /changes, before storing.
// Return a rejected promise to fail the request.
let onPush;
// Request log for assertions.
let requests;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function serverStore(entries) {
  let stored = 0;
  for (const e of entries) {
    const data = typeof e === 'string' ? e : e.data;
    const hash = typeof e === 'string' ? null : e.hash;
    if (hash && server.byHash.has(hash)) continue;
    server.seq++;
    server.changes.push({ seq: server.seq, data, hash });
    if (hash) server.byHash.add(hash);
    stored++;
  }
  return { stored, duplicates: entries.length - stored, lastSeq: server.seq };
}

async function fakeFetch(url, options = {}) {
  const u = new URL(url);
  const method = options.method || 'GET';
  requests.push(`${method} ${u.pathname}${u.search}`);

  if (u.pathname === '/api/changes' && method === 'POST') {
    if (onPush) await onPush();
    const { changes } = JSON.parse(options.body);
    return jsonResponse(serverStore(changes));
  }
  if (u.pathname === '/api/changes' && method === 'GET') {
    const since = parseInt(u.searchParams.get('since')) || 0;
    if (since < server.compactedSeq) {
      return jsonResponse({ error: 'history_compacted', compactedSeq: server.compactedSeq }, 410);
    }
    const limit = parseInt(u.searchParams.get('limit')) || 0;
    const after = server.changes.filter(c => c.seq > since);
    if (!limit) return jsonResponse({ changes: after, lastSeq: server.seq });
    const page = after.slice(0, limit);
    const hasMore = after.length > limit;
    const cursor = page.length ? page[page.length - 1].seq : since;
    return jsonResponse({ changes: page, lastSeq: cursor, hasMore, latestSeq: server.seq });
  }
  if (u.pathname === '/api/changes/snapshot' && method === 'GET') {
    if (!server.snapshot) return jsonResponse({ error: 'No snapshot available' }, 404);
    return jsonResponse(server.snapshot);
  }
  if (u.pathname === '/api/changes/snapshot' && method === 'POST') {
    const { snapshot, seq } = JSON.parse(options.body);
    server.snapshot = { data: snapshot, seq: Number.isInteger(seq) ? seq : server.seq };
    return jsonResponse({ ok: true, seq: server.seq });
  }
  if (u.pathname === '/api/changes/format-version') {
    return jsonResponse({ ok: true, formatVersion: 3 });
  }
  throw new Error(`fakeFetch: unhandled ${method} ${u.pathname}`);
}

// Rebuild the document the server holds (snapshot + every change).
async function docFromServer() {
  let doc = server.snapshot
    ? Automerge.load(await decryptChange(server.snapshot.data))
    : Automerge.init();
  const changes = await Promise.all(server.changes.map(c => decryptChange(c.data)));
  [doc] = Automerge.applyChanges(doc, changes);
  return doc;
}

const serverNames = async () => ((await docFromServer()).todos || []).map(t => t.name).sort();
const localNames = () => (getDocument().todos || []).map(t => t.name).sort();

// --- Another device --------------------------------------------------------
// Shares the encryption key (same fake IndexedDB) but has its own document.

function otherDevice() {
  let doc = Automerge.init();
  return {
    get doc() { return doc; },
    // Adopt the server's document (like a device that has fully synced).
    async syncDown() { doc = await docFromServer(); },
    async change(fn) {
      const before = doc;
      doc = Automerge.change(doc, fn);
      const changes = Automerge.getChanges(before, doc);
      const entries = await Promise.all(changes.map(async c => ({ data: await encryptChange(c), hash: changeHash(c) })));
      return serverStore(entries);
    },
    async pushSnapshot() {
      server.snapshot = { data: await encryptChange(Automerge.save(doc)), seq: server.seq };
    },
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };

// --- Setup ----------------------------------------------------------------

beforeEach(async () => {
  try { (await _getDB()).close(); } catch { /* not open yet */ }
  const dbs = await indexedDB.databases();
  await Promise.all(dbs.map(db => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(db.name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  })));
  localStorage.clear();
  server = { changes: [], seq: 0, snapshot: null, byHash: new Set(), compactedSeq: 0 };
  onPush = null;
  requests = [];
  globalThis.fetch = vi.fn(fakeFetch);
  globalThis.WebSocket = class { close() {} };
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
  setOnLocalChange(null);
  setOnPersistError(null);
  await resetCRDT();
  await initCRDT();
  saveSyncConfig({ serverUrl: 'http://fake', deviceToken: 'device-1' });
});

afterEach(() => {
  teardownSync();
  clearSyncConfig();
});

// --- Push ------------------------------------------------------------------

describe('push', () => {
  it('a fresh device with no server state reconciles and pushes everything', async () => {
    expect(needsReconcile()).toBe(true);
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();

    expect(await serverNames()).toEqual(['A']);
    expect(needsReconcile()).toBe(false);
    expect(getUnpushed().changes).toHaveLength(0);
  });

  it('pushes only what the server lacks', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();
    await addTask({ id: 2, name: 'B', completed: false });
    expect(getUnpushed().changes).toHaveLength(1);
    await pushChanges();

    expect(server.changes).toHaveLength(2);
    expect(await serverNames()).toEqual(['A', 'B']);
  });

  it('keeps changes unpushed when the push fails, and retries later', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();

    onPush = () => Promise.reject(new Error('HTTP 500'));
    await addTask({ id: 2, name: 'B', completed: false });
    expect(await pushChanges()).toBe(false);
    expect(getUnpushed().changes).toHaveLength(1);
    expect(await serverNames()).toEqual(['A']);

    onPush = null;
    await pushAllLocalChanges();
    expect(await serverNames()).toEqual(['A', 'B']);
    expect(getUnpushed().changes).toHaveLength(0);
  });

  it('race (a): a change orphaned by a failed push is included in the next push', async () => {
    await addTask({ id: 0, name: 'base', completed: false });
    await pushChanges();

    onPush = () => Promise.reject(new Error('HTTP 500'));
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();

    onPush = null;
    await addTask({ id: 2, name: 'B', completed: false });
    await pushChanges();

    expect(await serverNames()).toEqual(['A', 'B', 'base']);
    expect(getUnpushed().changes).toHaveLength(0);
  });

  it('race (b): a change made while a push is in flight is not lost', async () => {
    await addTask({ id: 0, name: 'base', completed: false });
    await pushChanges();

    // While the server is handling the push of A, the user adds B.
    let injected = false;
    onPush = async () => {
      if (injected) return;
      injected = true;
      await addTask({ id: 2, name: 'B', completed: false });
    };
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();
    await settle();

    // B is either on the server or still known to be unpushed — never lost.
    const unpushed = getUnpushed().changes.length;
    const onServer = await serverNames();
    expect(onServer.includes('A')).toBe(true);
    expect(onServer.includes('B') || unpushed === 1).toBe(true);

    await pushChanges();
    expect(await serverNames()).toEqual(['A', 'B', 'base']);
    expect(getUnpushed().changes).toHaveLength(0);
  });

  it('race (b) survives a reload before the next push', async () => {
    await addTask({ id: 0, name: 'base', completed: false });
    await pushChanges();

    let injected = false;
    onPush = async () => {
      if (injected) return;
      injected = true;
      await addTask({ id: 2, name: 'B', completed: false });
    };
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();
    await settle();

    // Reload: only what is on disk survives.
    _resetMemory();
    await initCRDT();
    expect(localNames()).toEqual(['A', 'B', 'base']);
    await pushAllLocalChanges();
    expect(await serverNames()).toEqual(['A', 'B', 'base']);
  });

  it('never stores the same change twice on the server', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();
    const rows = server.changes.length;

    await recoverSync();
    await recoverSync();
    await markUnknown();
    await pushAllLocalChanges();

    expect(server.changes).toHaveLength(rows);
    expect(getUnpushed().changes).toHaveLength(0);
  });
});

// --- Pull ------------------------------------------------------------------

describe('pull', () => {
  it('applies changes from another device and does not push them back', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();

    const other = otherDevice();
    await other.syncDown();
    await other.change(d => { d.todos.push({ id: 2, name: 'B', completed: false }); });

    expect(await pullChanges()).toBe(true);
    expect(localNames()).toEqual(['A', 'B']);
    // Remote changes are now known to be on the server: nothing to push.
    expect(getUnpushed().changes).toHaveLength(0);
    const rows = server.changes.length;
    await pushChanges();
    expect(server.changes).toHaveLength(rows);
  });

  it('pages through a large backlog', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();

    const other = otherDevice();
    await other.syncDown();
    for (let i = 0; i < 1200; i++) {
      await other.change(d => { d.todos[0].name = `A${i}`; });
    }
    requests = [];
    await pullChanges();

    expect(getDocument().todos[0].name).toBe('A1199');
    const pulls = requests.filter(r => r.startsWith('GET /api/changes?'));
    expect(pulls.length).toBe(3); // 1200 changes / 500 per page, plus the empty tail
    expect(localStorage.getItem('stuf-last-seq')).toBe(String(server.seq));
  }, 20000);

  it('does not advance the cursor when remote changes could not be persisted', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();
    const other = otherDevice();
    await other.syncDown();
    await other.change(d => { d.todos.push({ id: 2, name: 'B', completed: false }); });

    // Break storage for the duration of the pull.
    const realOpen = indexedDB.open.bind(indexedDB);
    (await _getDB()).close();
    indexedDB.open = () => { throw Object.assign(new Error('closing'), { name: 'InvalidStateError' }); };
    const seqBefore = localStorage.getItem('stuf-last-seq');
    try {
      await pullChanges();
    } finally {
      indexedDB.open = realOpen;
    }
    expect(localNames()).toEqual(['A', 'B']); // shown to the user
    expect(localStorage.getItem('stuf-last-seq')).toBe(seqBefore); // but pulled again next time

    await pullChanges();
    expect(localStorage.getItem('stuf-last-seq')).toBe(String(server.seq));
  });

  it('falls back to reconcile when the server has compacted history', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();

    const other = otherDevice();
    await other.syncDown();
    await other.change(d => { d.todos.push({ id: 2, name: 'B', completed: false }); });
    await other.pushSnapshot();
    await other.change(d => { d.todos.push({ id: 3, name: 'C', completed: false }); });
    // Server deletes everything up to the snapshot.
    server.compactedSeq = server.snapshot.seq;
    server.changes = server.changes.filter(c => c.seq > server.compactedSeq);

    await pullChanges();
    expect(localNames()).toEqual(['A', 'B', 'C']);
    expect(needsReconcile()).toBe(false);
    expect(localStorage.getItem('stuf-last-seq')).toBe(String(server.seq));
  });
});

// --- Reconcile ---------------------------------------------------------------

describe('reconcile', () => {
  it('a new device adopts the server snapshot plus the changes after it', async () => {
    const other = otherDevice();
    await other.change(d => { d.todos = [{ id: 1, name: 'A', completed: false }]; });
    await other.pushSnapshot();
    await other.change(d => { d.todos.push({ id: 2, name: 'B', completed: false }); });
    const rows = server.changes.length;

    await pullSnapshot();
    expect(localNames()).toEqual(['A', 'B']);
    expect(needsReconcile()).toBe(false);
    expect(server.changes).toHaveLength(rows); // nothing pushed back
    expect(localStorage.getItem('stuf-last-seq')).toBe(String(server.seq));
    // Only the snapshot and the changes after it were requested.
    const since = requests.filter(r => r.startsWith('GET /api/changes?')).map(r => parseInt(new URL('http://x' + r.split(' ')[1]).searchParams.get('since')));
    expect(Math.min(...since)).toBe(server.snapshot.seq);
  });

  it('merges divergent devices and uploads only the local difference', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();

    const other = otherDevice();
    await other.syncDown();
    await other.change(d => { d.todos.push({ id: 2, name: 'B', completed: false }); });
    await other.pushSnapshot();

    // This device edits offline, then loses track of the server (e.g. reinstall).
    await addTask({ id: 3, name: 'C', completed: false });
    await markUnknown();
    const rows = server.changes.length;

    const pushed = await recoverSync();
    expect(pushed).toBe(1);
    expect(localNames()).toEqual(['A', 'B', 'C']);
    expect(await serverNames()).toEqual(['A', 'B', 'C']);
    expect(server.changes).toHaveLength(rows + 1);
  });

  it('two devices that both recover end up identical', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();
    const other = otherDevice();
    await other.syncDown();
    await other.change(d => { d.todos.push({ id: 2, name: 'B', completed: false }); });
    await updateTask(1, { name: 'A2' });

    await recoverSync();
    await other.syncDown();
    expect(localNames()).toEqual(['A2', 'B']);
    expect((other.doc.todos || []).map(t => t.name).sort()).toEqual(['A2', 'B']);
  });

  it('works before any snapshot exists on the server', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await pushChanges();
    expect(server.snapshot).toBeNull();

    const other = otherDevice();
    await other.syncDown();
    await other.change(d => { d.todos.push({ id: 2, name: 'B', completed: false }); });
    await addTask({ id: 3, name: 'C', completed: false });
    await markUnknown();

    await recoverSync();
    expect(localNames()).toEqual(['A', 'B', 'C']);
    expect(await serverNames()).toEqual(['A', 'B', 'C']);
  });
});

// --- initSync wiring -----------------------------------------------------------

describe('initSync', () => {
  it('auto-pushes local changes', async () => {
    await initSync(() => {}, () => {});
    await addTask({ id: 1, name: 'A', completed: false });
    await settle();
    expect(await serverNames()).toEqual(['A']);
  });

  it('never loses a local change under a burst of edits with a slow server', async () => {
    onPush = () => new Promise(r => setTimeout(r, 5));
    await initSync(() => {}, () => {});

    await addTask({ id: 1, name: 'A', completed: false });
    for (let i = 0; i < 10; i++) {
      await updateTask(1, { name: `A${i}`, updated: i });
    }
    await new Promise(r => setTimeout(r, 200));

    expect(getUnpushed().changes).toHaveLength(0);
    expect((await docFromServer()).todos[0].name).toBe(getDocument().todos[0].name);
  });

  it('pushes a snapshot with the exact cursor once fully in sync', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    await initSync(() => {}, () => {});
    await settle();
    expect(server.snapshot).not.toBeNull();
    expect(server.snapshot.seq).toBe(server.seq);
    const snapDoc = Automerge.load(await decryptChange(server.snapshot.data));
    expect(snapDoc.todos.map(t => t.name)).toEqual(['A']);
  });
});

describe('getUnpushedChanges (legacy helper)', () => {
  it('reports everything when server state is unknown', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    expect(await getUnpushedChanges()).toHaveLength(1);
  });
});
