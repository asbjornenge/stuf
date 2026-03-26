import * as Automerge from '@automerge/automerge';
import { openDB } from 'idb';
import { migrateFromV1, createDocFromState } from './migration.js';

let doc = null;

// Hook for sync — called with each new local change (Uint8Array)
let _onLocalChange = null;
export function setOnLocalChange(fn) { _onLocalChange = fn; }

function emitChange(change) {
  if (_onLocalChange) _onLocalChange(change);
}

// --- New IndexedDB: snapshot + unpushed changes ---

const dbPromise = openDB('stufDB', 1, {
  upgrade(db) {
    db.createObjectStore('meta', { keyPath: 'key' });
    db.createObjectStore('unpushed', { keyPath: 'id', autoIncrement: true });
  },
});

export const saveSnapshot = async () => {
  const db = await dbPromise;
  const binary = Automerge.save(doc);
  await db.put('meta', { key: 'snapshot', value: binary });
};

const saveUnpushedChange = async (change) => {
  const db = await dbPromise;
  await db.add('unpushed', { change });
};

export const getUnpushedChanges = async () => {
  const db = await dbPromise;
  const records = await db.getAll('unpushed');
  return records.map(r => r.change);
};

export const clearUnpushedChanges = async () => {
  const db = await dbPromise;
  await db.clear('unpushed');
};

export const resetCRDT = async () => {
  const db = await dbPromise;
  await db.clear('meta');
  await db.clear('unpushed');
  doc = Automerge.init();
};

// Reset in-memory doc only (for testing — does not clear DB)
export const _resetMemory = () => {
  doc = Automerge.init();
};

// --- Snapshot for sync ---

export const saveDocumentSnapshot = () => {
  const binary = Automerge.save(doc);
  return Array.from(binary);
};

// Automerge 3.x magic bytes: 0x85 0x6f 0x4a 0x83
const AUTOMERGE_MAGIC = [0x85, 0x6f, 0x4a, 0x83];

function isAutomerge3Format(data) {
  return data.length >= 4 &&
    data[0] === AUTOMERGE_MAGIC[0] && data[1] === AUTOMERGE_MAGIC[1] &&
    data[2] === AUTOMERGE_MAGIC[2] && data[3] === AUTOMERGE_MAGIC[3];
}

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
    } catch (err) {
      throw new Error('Unable to load snapshot: unrecognized format');
    }
  }

  await saveSnapshot();
  const db = await dbPromise;
  await db.clear('unpushed');
};

// --- Init with migration support ---

export const initCRDT = async () => {
  const db = await dbPromise;

  // Fast path: load existing 3.x snapshot
  const snapshotRecord = await db.get('meta', 'snapshot');
  if (snapshotRecord) {
    doc = Automerge.load(snapshotRecord.value);
    // Replay any unpushed changes
    const unpushed = await db.getAll('unpushed');
    if (unpushed.length > 0) {
      const changes = unpushed.map(r => r.change);
      [doc] = Automerge.applyChanges(doc, changes);
    }
    return;
  }

  // Migration path: check for old crdtDB
  const migratedDoc = await migrateFromV1();
  if (migratedDoc) {
    doc = migratedDoc;
    await saveSnapshot();
    return;
  }

  // Fresh start
  doc = Automerge.init();
};

// --- Apply remote changes ---

export const applyRemoteChanges = async (changes) => {
  try {
    [doc] = Automerge.applyChanges(doc, changes);
  } catch (err) {
    // Fallback: apply one by one, skip failures
    for (let i = 0; i < changes.length; i++) {
      try {
        [doc] = Automerge.applyChanges(doc, [changes[i]]);
      } catch (e) {
        console.warn(`Failed to apply remote change ${i + 1}/${changes.length}:`, e.message);
      }
    }
  }
  await saveSnapshot();
};

export const getDocument = () => doc;

// --- Helper: change + persist + emit ---

async function localChange(message, changeFn) {
  const oldDoc = doc;
  doc = Automerge.change(doc, { message }, changeFn);
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveUnpushedChange(lastChange);
  await saveSnapshot();
  emitChange(lastChange);
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
