import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import OldAutomerge from 'automerge-legacy';
import * as Automerge from '@automerge/automerge';
import { migrateFromV1 } from '../migration.js';

// Helper: seed old crdtDB with Automerge 0.14 changes
async function seedOldDb(changes) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('crdtDB', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('crdt', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('crdt', 'readwrite');
      const store = tx.objectStore('crdt');
      for (const change of changes) {
        store.add({ change });
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function createOldChanges() {
  let doc = OldAutomerge.init();
  const doc1 = OldAutomerge.change(doc, 'Init', (d) => {
    d.todos = [];
    d.tags = [];
    d.projects = [];
  });
  const doc2 = OldAutomerge.change(doc1, 'Add task', (d) => {
    d.todos.push({ id: 1, name: 'Buy milk', completed: false, created: 1000, updated: 1000 });
  });
  const doc3 = OldAutomerge.change(doc2, 'Add tag', (d) => {
    d.tags.push('groceries');
  });
  const doc4 = OldAutomerge.change(doc3, 'Add project', (d) => {
    d.projects.push({ id: 100, name: 'Shopping' });
  });
  const doc5 = OldAutomerge.change(doc4, 'Add another task', (d) => {
    d.todos.push({ id: 2, name: 'Walk the dog', completed: true, created: 2000, updated: 2000 });
  });
  return OldAutomerge.getAllChanges(doc5);
}

beforeEach(async () => {
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    indexedDB.deleteDatabase(db.name);
  }
});

describe('migrateFromV1', () => {
  it('returns null when no old DB exists', async () => {
    const result = await migrateFromV1();
    expect(result).toBeNull();
  });

  it('returns null when old DB is empty', async () => {
    await seedOldDb([]);
    const result = await migrateFromV1();
    expect(result).toBeNull();
  });

  it('migrates tasks from 0.14 to 3.x', async () => {
    const changes = createOldChanges();
    await seedOldDb(changes);

    const newDoc = await migrateFromV1();
    expect(newDoc).toBeDefined();
    expect(newDoc.todos).toHaveLength(2);
    expect(newDoc.todos[0].name).toBe('Buy milk');
    expect(newDoc.todos[0].completed).toBe(false);
    expect(newDoc.todos[1].name).toBe('Walk the dog');
    expect(newDoc.todos[1].completed).toBe(true);
  });

  it('migrates tags', async () => {
    const changes = createOldChanges();
    await seedOldDb(changes);

    const newDoc = await migrateFromV1();
    expect(newDoc.tags).toHaveLength(1);
    expect(newDoc.tags[0]).toBe('groceries');
  });

  it('migrates projects', async () => {
    const changes = createOldChanges();
    await seedOldDb(changes);

    const newDoc = await migrateFromV1();
    expect(newDoc.projects).toHaveLength(1);
    expect(newDoc.projects[0].name).toBe('Shopping');
    expect(newDoc.projects[0].id).toBe(100);
  });

  it('produces a valid Automerge 3.x document', async () => {
    const changes = createOldChanges();
    await seedOldDb(changes);

    const newDoc = await migrateFromV1();
    // Should be saveable with Automerge 3.x
    const binary = Automerge.save(newDoc);
    expect(binary).toBeInstanceOf(Uint8Array);

    // Should be loadable
    const loaded = Automerge.load(binary);
    expect(loaded.todos).toHaveLength(2);
  });

  it('deletes old crdtDB after migration', async () => {
    const changes = createOldChanges();
    await seedOldDb(changes);

    await migrateFromV1();

    // Old DB should be gone
    const exists = await new Promise((resolve) => {
      const req = indexedDB.open('crdtDB');
      req.onsuccess = () => {
        const db = req.result;
        const hasStore = db.objectStoreNames.contains('crdt');
        db.close();
        resolve(hasStore);
      };
      req.onerror = () => resolve(false);
    });
    expect(exists).toBe(false);
  });

  it('sets migration push flag', async () => {
    const changes = createOldChanges();
    await seedOldDb(changes);

    await migrateFromV1();
    expect(localStorage.getItem('stuf-needs-migration-push')).toBe('true');
  });
});
