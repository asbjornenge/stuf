import * as Automerge from '@automerge/automerge';
import { openDB } from 'idb';
import { migrateFromV1, needsMigration, createDocFromState } from './migration.js';

export { needsMigration };

let doc = null;

// Heads of the document as far as the server is known to have it. Everything
// the server lacks is derived from the document itself as "changes since
// these heads", so there is no separate queue that can get out of step.
// null means unknown (fresh install, after import/reset, or upgraded from the
// old storage format) and makes the next sync reconcile against the server.
let _pushedHeads = null;

// Number of incremental chunks written since the last full snapshot.
let _incrementCount = 0;
// Local storage is compacted into a full snapshot after this many increments.
const COMPACT_EVERY = 100;

// Hook for sync — called after each local change
let _onLocalChange = null;
export function setOnLocalChange(fn) { _onLocalChange = fn; }

function emitChange(change) {
  if (_onLocalChange) _onLocalChange(change);
}

// Hook so the UI can warn the user when local storage is failing.
let _onPersistError = null;
export function setOnPersistError(fn) { _onPersistError = fn; }

// --- IndexedDB ---
//
// v1: meta { snapshot }, unpushed { change }
// v2: + increments { bytes }  (Automerge.saveIncremental chunks since the last
//       full snapshot), meta { pushedHeads }. 'unpushed' is only read once to
//       migrate old data.
//
// The browser may close the connection behind our back (storage errors,
// quota, app backgrounded on mobile). Every operation on a closed connection
// throws InvalidStateError, so we never keep a permanent handle: getDB()
// reopens on demand and withDB() retries once after a forced close.
let _dbPromise = null;

function openStufDB() {
  return openDB('stufDB', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('unpushed', { keyPath: 'id', autoIncrement: true });
      }
      if (oldVersion < 2) {
        db.createObjectStore('increments', { autoIncrement: true });
      }
    },
    terminated() {
      _dbPromise = null;
    },
  });
}

function getDB() {
  if (!_dbPromise) _dbPromise = openStufDB();
  return _dbPromise;
}

function isClosedConnectionError(err) {
  return err?.name === 'InvalidStateError';
}

async function withDB(fn) {
  try {
    return await fn(await getDB());
  } catch (err) {
    if (!isClosedConnectionError(err)) throw err;
    console.warn('IndexedDB connection was closed, reopening');
    _dbPromise = null;
    return fn(await getDB());
  }
}

// Test hook: the live connection, so tests can close it and verify recovery.
export const _getDB = () => getDB();

// --- Persistence ---

// Full snapshot of the document, replacing all incremental chunks (atomic).
export const saveSnapshot = async () => {
  const binary = Automerge.save(doc);
  await withDB(async (db) => {
    const tx = db.transaction(['meta', 'increments'], 'readwrite');
    tx.objectStore('meta').put({ key: 'snapshot', value: binary });
    tx.objectStore('increments').clear();
    await tx.done;
  });
  _incrementCount = 0;
};

// Persist only what changed since the last save, as one small chunk. With a
// long history this is what keeps every edit from rewriting megabytes.
const persistIncrement = async () => {
  const bytes = Automerge.saveIncremental(doc);
  if (bytes.length === 0) return;
  try {
    await withDB(db => db.add('increments', { bytes }));
  } catch (err) {
    // Automerge has already marked these bytes as saved, so a full snapshot
    // is the only way left to get them on disk.
    console.warn('Increment write failed, falling back to full snapshot:', err.message);
    await saveSnapshot();
    return;
  }
  _incrementCount++;
  if (_incrementCount >= COMPACT_EVERY) await saveSnapshot();
};

const savePushedHeads = () =>
  withDB(db => db.put('meta', { key: 'pushedHeads', value: _pushedHeads }));

function headsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((h, i) => h === sb[i]);
}

// --- What the server has ---

export const getHeads = () => Automerge.getHeads(doc);
export const getPushedHeads = () => _pushedHeads;
export const needsReconcile = () => _pushedHeads === null;
export const changeHash = (change) => Automerge.decodeChange(change).hash;

// Changes the server does not have yet, plus the heads that are fully pushed
// once those changes are stored. null when unknown (reconcile needed).
export const getUnpushed = () => {
  if (_pushedHeads === null) return null;
  const heads = Automerge.getHeads(doc);
  if (headsEqual(heads, _pushedHeads)) return { changes: [], heads };
  try {
    return { changes: Automerge.getChanges(Automerge.view(doc, _pushedHeads), doc), heads };
  } catch (err) {
    console.warn('pushedHeads not in document history, reconcile needed:', err.message);
    return null;
  }
};

// All changes not known to be on the server (everything, when unknown).
export const getUnpushedChanges = async () => {
  const unpushed = getUnpushed();
  return unpushed ? unpushed.changes : Automerge.getAllChanges(doc);
};

export const markPushed = async (heads) => {
  _pushedHeads = heads;
  await savePushedHeads();
};

export const markUnknown = async () => {
  _pushedHeads = null;
  await savePushedHeads();
};

// "Everything currently in the document is on the server."
export const clearUnpushedChanges = async () => markPushed(Automerge.getHeads(doc));

export const resetCRDT = async () => {
  await withDB(async (db) => {
    const tx = db.transaction(['meta', 'unpushed', 'increments'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('unpushed').clear();
    tx.objectStore('increments').clear();
    await tx.done;
  });
  doc = Automerge.init();
  _pushedHeads = null;
  _incrementCount = 0;
};

// Reset in-memory state only (for testing — does not clear DB)
export const _resetMemory = () => {
  doc = Automerge.init();
  _pushedHeads = null;
  _incrementCount = 0;
};

// --- Snapshot for sync / backup ---

export const saveDocumentSnapshot = () => {
  const binary = Automerge.save(doc);
  return Array.from(binary);
};

export const getAllLocalChanges = () => Automerge.getAllChanges(doc);

// Automerge 3.x magic bytes: 0x85 0x6f 0x4a 0x83
const AUTOMERGE_MAGIC = [0x85, 0x6f, 0x4a, 0x83];

function isAutomerge3Format(data) {
  return data.length >= 4 &&
    data[0] === AUTOMERGE_MAGIC[0] && data[1] === AUTOMERGE_MAGIC[1] &&
    data[2] === AUTOMERGE_MAGIC[2] && data[3] === AUTOMERGE_MAGIC[3];
}

// Replace the document wholesale (backup import). What the server has is
// unknown afterwards, so the next sync reconciles.
export const loadDocumentSnapshot = async (data) => {
  const binary = new Uint8Array(data);

  if (isAutomerge3Format(binary)) {
    // Native Automerge 3.x format
    doc = Automerge.load(binary);
  } else {
    // Legacy 0.14 format (JSON string as bytes) — convert via plain state
    try {
      const str = new TextDecoder().decode(binary);
      const OldAutomerge = await import('automerge-legacy');
      const oldDoc = OldAutomerge.default.load(str);
      const plainState = JSON.parse(JSON.stringify(oldDoc));
      doc = createDocFromState(plainState);
    } catch {
      throw new Error('Unable to load snapshot: unrecognized format');
    }
  }

  _pushedHeads = null;
  await saveSnapshot();
  await savePushedHeads();
  await withDB(db => db.clear('unpushed'));
};

// --- Init with migration support ---

// Check if space already migrated on server
async function spaceAlreadyMigrated(syncConfig) {
  if (!syncConfig) return false;
  try {
    const res = await fetch(`${syncConfig.serverUrl}/api/space-info`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${syncConfig.deviceToken}`,
      },
    });
    if (!res.ok) return false;
    const info = await res.json();
    return info.formatVersion >= 3;
  } catch {
    return false; // Offline — can't check
  }
}

// Pull snapshot from server (used when space is already migrated by another device)
async function pullServerSnapshot(syncConfig, decryptChange) {
  const res = await fetch(`${syncConfig.serverUrl}/api/changes/snapshot`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${syncConfig.deviceToken}`,
    },
  });
  if (!res.ok) return null;
  const { data, seq } = await res.json();
  if (!data) return null;
  const decrypted = await decryptChange(data);
  return { binary: new Uint8Array(decrypted), seq };
}

export const initCRDT = async (onMigrationProgress, syncConfig, decryptChange) => {
  // Fast path: load existing snapshot + incremental chunks. A document that
  // has only ever been saved incrementally has chunks but no snapshot yet.
  const snapshotRecord = await withDB(db => db.get('meta', 'snapshot'));
  const increments = await withDB(db => db.getAll('increments'));
  if (snapshotRecord || increments.length > 0) {
    doc = snapshotRecord ? Automerge.load(snapshotRecord.value) : Automerge.init();

    let corrupt = false;
    for (const inc of increments) {
      try {
        doc = Automerge.loadIncremental(doc, inc.bytes);
      } catch (err) {
        corrupt = true;
        console.warn('Skipping unreadable increment:', err.message);
      }
    }
    _incrementCount = increments.length;

    const headsRecord = await withDB(db => db.get('meta', 'pushedHeads'));
    _pushedHeads = headsRecord?.value ?? null;

    // Old storage format: changes waiting in 'unpushed'. Fold them in and let
    // the next sync reconcile against the server.
    const unpushed = await withDB(db => db.getAll('unpushed'));
    if (unpushed.length > 0) {
      [doc] = Automerge.applyChanges(doc, unpushed.map(r => r.change));
      _pushedHeads = null;
      await withDB(db => db.clear('unpushed'));
    }

    if (corrupt || unpushed.length > 0 || _incrementCount >= COMPACT_EVERY) {
      await saveSnapshot();
    }
    return;
  }

  // Migration path: check for old crdtDB
  const needsMig = await needsMigration();
  if (needsMig) {
    // If space is already migrated by another device, pull snapshot instead
    if (syncConfig && decryptChange) {
      const alreadyMigrated = await spaceAlreadyMigrated(syncConfig);
      if (alreadyMigrated) {
        onMigrationProgress?.({ step: 'pull', message: 'Space already migrated — pulling snapshot from server...', progress: 0.5 });
        const snapshot = await pullServerSnapshot(syncConfig, decryptChange);
        if (snapshot) {
          doc = Automerge.load(snapshot.binary);
          _pushedHeads = Automerge.getHeads(doc);
          await saveSnapshot();
          await savePushedHeads();
          // Delete old DB
          await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('crdtDB');
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
          });
          onMigrationProgress?.({ step: 'done', message: 'Migration complete!', progress: 1 });
          localStorage.setItem('stuf-last-seq', String(snapshot.seq));
          return;
        }
      }
    }

    // First device to migrate, or offline — do local migration
    const migratedDoc = await migrateFromV1(onMigrationProgress);
    if (migratedDoc) {
      doc = migratedDoc;
      _pushedHeads = null;
      await saveSnapshot();
      return;
    }
  }

  // Fresh start
  doc = Automerge.init();
  _pushedHeads = null;
};

// --- Apply remote changes ---

// Applies remote changes to the in-memory document, then persists them. If
// persisting fails the changes are still in memory (so the UI can show
// them), but the error propagates so the caller does not advance its cursor
// — the changes will simply be pulled again, which is idempotent.
export const applyRemoteChanges = async (changes) => {
  const before = Automerge.getHeads(doc);
  const fullyPushed = _pushedHeads !== null && headsEqual(before, _pushedHeads);

  try {
    [doc] = Automerge.applyChanges(doc, changes);
  } catch (err) {
    // Fallback: apply one by one, skip failures
    console.warn('Batch apply failed, applying one by one:', err.message);
    for (let i = 0; i < changes.length; i++) {
      try {
        [doc] = Automerge.applyChanges(doc, [changes[i]]);
      } catch (e) {
        console.warn(`Failed to apply remote change ${i + 1}/${changes.length}:`, e.message);
      }
    }
  }

  // Everything local was already on the server and these came from the
  // server, so the server now has exactly this document. (If local changes
  // were pending, the next push re-sends the remote ones too; the server
  // de-duplicates them.)
  if (fullyPushed) _pushedHeads = Automerge.getHeads(doc);

  await persistIncrement();
  if (fullyPushed) await savePushedHeads();
};

// Merge the server's document (snapshot + changes) into ours. Returns the
// changes the server is missing and the heads that are fully pushed once
// those are stored.
export const mergeServerDoc = async (serverDoc) => {
  doc = Automerge.merge(doc, serverDoc);
  const heads = Automerge.getHeads(doc);
  const toPush = Automerge.getChanges(serverDoc, doc);
  await saveSnapshot();
  return { toPush, heads };
};

export const getDocument = () => doc;

// --- Epochs: replacing the document with a history-free one ---

const clonePlain = (v) => JSON.parse(JSON.stringify(v));

export const getPlainState = () => clonePlain(doc);

export const getChangeCount = () => Automerge.getAllChanges(doc).length;

// Same state, no history. Automerge keeps every historical value of every
// field in memory, so a long-lived document grows far beyond its state.
export const buildFreshDoc = (state) => createDocFromState(state, 'Compact history');

// Adopt `newDoc` as our document. Everything in it is on the server.
export const replaceDocument = async (newDoc) => {
  doc = newDoc;
  _pushedHeads = Automerge.getHeads(doc);
  await saveSnapshot();
  await savePushedHeads();
};

// After adopting a new epoch, re-apply edits this device had not pushed:
// tasks that are missing, or newer here than in the adopted document
// (by `updated`), plus tags and projects that are missing. Deletions cannot
// be told apart from "not synced yet" and are not replayed.
export const replayLocalState = async (local) => {
  const current = getPlainState();
  const byId = new Map((current.todos || []).map(t => [t.id, t]));
  const toAdd = [];
  const toUpdate = [];
  for (const t of local.todos || []) {
    const c = byId.get(t.id);
    if (!c) toAdd.push(t);
    else if ((t.updated || 0) > (c.updated || 0)) toUpdate.push(t);
  }
  const tags = (local.tags || []).filter(x => !(current.tags || []).includes(x));
  const projects = (local.projects || []).filter(p => !(current.projects || []).some(q => q.id === p.id));
  const count = toAdd.length + toUpdate.length + tags.length + projects.length;
  if (count === 0) return 0;
  await localChange('Replay after compaction', (d) => {
    if (!d.todos) d.todos = [];
    for (const t of toAdd) d.todos.push(clonePlain(t));
    for (const t of toUpdate) {
      const task = d.todos.find(x => x.id === t.id);
      if (!task) continue;
      for (const key of Object.keys(task)) {
        if (key !== 'id' && !(key in t)) delete task[key];
      }
      for (const [key, value] of Object.entries(t)) {
        if (key !== 'id') task[key] = clonePlain(value);
      }
    }
    if (tags.length) {
      if (!d.tags) d.tags = [];
      for (const x of tags) d.tags.push(x);
    }
    if (projects.length) {
      if (!d.projects) d.projects = [];
      for (const p of projects) d.projects.push({ id: p.id, name: p.name });
    }
  });
  return count;
};

// --- Helper: change + persist + emit ---

// A local change is (1) applied in memory, (2) persisted, (3) handed to sync.
// Step 2 can fail if local storage is broken; the change must still reach
// the server, so step 3 always happens. The server is the durable copy of
// last resort, and pushes are derived from the document, not from disk.
async function localChange(message, changeFn) {
  const oldDoc = doc;
  doc = Automerge.change(doc, { message }, changeFn);
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  let persistError = null;
  try {
    await persistIncrement();
  } catch (err) {
    persistError = err;
    console.error('Failed to persist local change, pushing anyway:', err.message);
  }
  emitChange(lastChange);
  if (persistError) _onPersistError?.(persistError);
  return lastChange;
}

// --- Task operations ---

export const addTask = async (task) => {
  return localChange('Add Task', (d) => {
    if (!d.todos) d.todos = [];
    d.todos.push(task);
  });
};

export const updateTask = async (id, fields) => {
  return localChange('Update Task', (d) => {
    if (!d.todos) return;
    const task = d.todos.find(t => t.id === id);
    if (!task) return;
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'id') continue;
      if (value === undefined || value === null) {
        delete task[key];
      } else if (Array.isArray(value)) {
        task[key] = value.map(item =>
          typeof item === 'object' ? { ...item } : item
        );
      } else {
        task[key] = value;
      }
    }
  });
};

export const deleteTask = async (id) => {
  return localChange('Delete Task', (d) => {
    if (!d.todos) return;
    const index = d.todos.findIndex((task) => task.id === id);
    if (index !== -1) {
      d.todos.splice(index, 1);
    }
  });
};

// --- Tags ---

export const getGlobalTags = () => {
  return doc.tags ? Array.from(doc.tags).map(t => String(t)) : [];
};

export const addGlobalTag = async (name) => {
  return localChange('Add Tag', (d) => {
    if (!d.tags) d.tags = [];
    if (!d.tags.find(t => t === name)) {
      d.tags.push(name);
    }
  });
};

export const deleteGlobalTag = async (name) => {
  return localChange('Delete Tag', (d) => {
    if (!d.tags) return;
    const index = d.tags.findIndex(t => t === name);
    if (index !== -1) {
      d.tags.splice(index, 1);
    }
  });
};

export const getRecentTags = () => {
  return doc.recentTags ? Array.from(doc.recentTags).map(t => String(t)) : [];
};

export const updateRecentTags = async (tags) => {
  return localChange('Update Recent Tags', (d) => {
    d.recentTags = tags.slice(0, 3);
  });
};

// --- Projects ---

export const getProjects = () => {
  return doc.projects ? Array.from(doc.projects).map(p => ({ id: p.id, name: String(p.name) })) : [];
};

export const addProject = async (name) => {
  return localChange('Add Project', (d) => {
    if (!d.projects) d.projects = [];
    d.projects.push({ id: Date.now(), name });
  });
};

export const deleteProject = async (id) => {
  return localChange('Delete Project', (d) => {
    if (!d.projects) return;
    const index = d.projects.findIndex(p => p.id === id);
    if (index !== -1) {
      d.projects.splice(index, 1);
    }
  });
};

// --- Task ordering ---

export const updateTaskOrder = async (taskUpdates) => {
  return localChange('Update Order', (d) => {
    if (!d.todos) return;
    taskUpdates.forEach(({ id, order }) => {
      const task = d.todos.find(t => t.id === id);
      if (task) task.order = order;
    });
  });
};

// --- Settings ---

export const getSettings = () => {
  if (!doc.settings) return { morningHour: 9, eveningHour: 17, somedayMinDays: 10, somedayMaxDays: 60 };
  return {
    morningHour: doc.settings.morningHour ?? 9,
    eveningHour: doc.settings.eveningHour ?? 17,
    somedayMinDays: doc.settings.somedayMinDays ?? 10,
    somedayMaxDays: doc.settings.somedayMaxDays ?? 60,
  };
};

export const updateSettings = async (newSettings) => {
  return localChange('Update Settings', (d) => {
    if (!doc.settings) d.settings = {};
    for (const [key, value] of Object.entries(newSettings)) {
      d.settings[key] = value;
    }
  });
};
