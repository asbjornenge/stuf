import * as Automerge from '@automerge/automerge';

// Check if old crdtDB exists
async function oldDbExists() {
  return new Promise((resolve) => {
    const req = indexedDB.open('crdtDB');
    req.onsuccess = () => {
      const db = req.result;
      const hasStore = db.objectStoreNames.contains('crdt');
      db.close();
      resolve(hasStore);
    };
    req.onerror = () => resolve(false);
  });
}

// Load old changes from crdtDB
async function loadOldChanges() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('crdtDB', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('crdt', 'readonly');
      const store = tx.objectStore('crdt');
      const getAll = store.getAll();
      getAll.onsuccess = () => {
        db.close();
        const changes = getAll.result.map(r => r.change).filter(Boolean);
        resolve(changes);
      };
      getAll.onerror = () => {
        db.close();
        reject(getAll.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

// Delete old crdtDB
async function deleteOldDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('crdtDB');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Yield to event loop so UI can update
function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Replay old changes with legacy Automerge and extract plain state
async function replayWithLegacy(changes, onProgress) {
  onProgress?.({ step: 'replay', message: 'Loading legacy Automerge...', progress: 0 });
  await yieldToUI();

  const OldAutomerge = await import('automerge-legacy');
  let oldDoc = OldAutomerge.default.init();

  onProgress?.({ step: 'replay', message: `Replaying ${changes.length} changes...`, progress: 0 });
  await yieldToUI();

  const BATCH_SIZE = 100;
  for (let i = 0; i < changes.length; i += BATCH_SIZE) {
    const batch = changes.slice(i, i + BATCH_SIZE);
    oldDoc = OldAutomerge.default.applyChanges(oldDoc, batch);
    const done = Math.min(i + BATCH_SIZE, changes.length);
    const progress = done / changes.length;
    onProgress?.({ step: 'replay', message: `Replaying changes: ${done}/${changes.length}`, progress });
    await yieldToUI();
  }

  onProgress?.({ step: 'convert', message: 'Extracting document state...', progress: 1 });
  await yieldToUI();

  return JSON.parse(JSON.stringify(oldDoc));
}

// Create a new Automerge 3.x document from plain JS state
export function createDocFromState(state) {
  return Automerge.change(Automerge.init(), { message: 'Migration from v1' }, (d) => {
    if (state.todos) {
      d.todos = [];
      for (const todo of state.todos) {
        const t = {};
        for (const [k, v] of Object.entries(todo)) {
          if (Array.isArray(v)) {
            t[k] = v.map(item => typeof item === 'object' ? { ...item } : item);
          } else {
            t[k] = v;
          }
        }
        d.todos.push(t);
      }
    }
    if (state.tags) {
      d.tags = [];
      for (const tag of state.tags) d.tags.push(String(tag));
    }
    if (state.recentTags) {
      d.recentTags = [];
      for (const tag of state.recentTags) d.recentTags.push(String(tag));
    }
    if (state.projects) {
      d.projects = [];
      for (const proj of state.projects) {
        d.projects.push({ id: proj.id, name: String(proj.name) });
      }
    }
    if (state.settings) {
      d.settings = {};
      for (const [k, v] of Object.entries(state.settings)) {
        d.settings[k] = v;
      }
    }
  });
}

// Check if migration is needed (without running it)
export async function needsMigration() {
  return oldDbExists();
}

// Main migration function — returns Automerge 3.x doc or null
export async function migrateFromV1(onProgress) {
  onProgress?.({ step: 'check', message: 'Checking for existing data...', progress: 0 });
  await yieldToUI();

  const exists = await oldDbExists();
  if (!exists) return null;

  onProgress?.({ step: 'load', message: 'Loading existing changes from database...', progress: 0 });
  await yieldToUI();

  const changes = await loadOldChanges();
  onProgress?.({ step: 'load', message: `Loaded ${changes.length} changes`, progress: 0 });
  await yieldToUI();

  if (changes.length === 0) {
    await deleteOldDb();
    return null;
  }

  const plainState = await replayWithLegacy(changes, onProgress);

  onProgress?.({ step: 'create', message: 'Creating new document format...', progress: 1 });
  await yieldToUI();

  const newDoc = createDocFromState(plainState);

  onProgress?.({ step: 'cleanup', message: 'Cleaning up old database...', progress: 1 });
  await yieldToUI();

  await deleteOldDb();
  localStorage.setItem('stuf-needs-migration-push', 'true');

  onProgress?.({ step: 'done', message: 'Migration complete!', progress: 1 });
  await yieldToUI();

  return newDoc;
}
