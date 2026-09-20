/**
 * Storage robustness: the browser can close our IndexedDB connection at any
 * time (Sentry STUFAPP-M, "The database connection is closing"). The CRDT
 * layer must recover by reopening, and a local change must never be dropped
 * because storage misbehaved.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  initCRDT, resetCRDT, _resetMemory, _getDB, getDocument,
  addTask, getUnpushedChanges, setOnLocalChange, setOnPersistError,
  applyRemoteChanges, needsReconcile,
} from '../crdt.js';
import * as Automerge from '@automerge/automerge';

beforeEach(async () => {
  // Close the connection left open by the previous test first; otherwise the
  // deleteDatabase below is blocked and fires later, when a test closes it.
  try { (await _getDB()).close(); } catch { /* not open yet */ }
  const dbs = await indexedDB.databases();
  await Promise.all(dbs.map(db => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(db.name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  })));
  setOnLocalChange(null);
  setOnPersistError(null);
  await resetCRDT();
  await initCRDT();
});

describe('closed IndexedDB connection', () => {
  it('a closed connection really does throw InvalidStateError (sanity)', async () => {
    const db = await _getDB();
    db.close();
    let err;
    try { await db.getAll('unpushed'); } catch (e) { err = e; }
    expect(err?.name).toBe('InvalidStateError');
  });

  it('reopens the connection and keeps persisting local changes', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    (await _getDB()).close();

    await addTask({ id: 2, name: 'B', completed: false });

    expect(await getUnpushedChanges()).toHaveLength(2);

    // Simulate reload: both changes must come back from disk.
    _resetMemory();
    await initCRDT();
    expect(getDocument().todos.map(t => t.name)).toEqual(['A', 'B']);
  });

  it('reopens the connection when it is closed during initCRDT', async () => {
    await addTask({ id: 1, name: 'A', completed: false });
    (await _getDB()).close();

    _resetMemory();
    await initCRDT();
    expect(getDocument().todos).toHaveLength(1);
  });

  it('reopens the connection for applyRemoteChanges', async () => {
    (await _getDB()).close();
    let other = Automerge.init();
    other = Automerge.change(other, d => { d.todos = [{ id: 9, name: 'remote', completed: false }]; });
    await applyRemoteChanges(Automerge.getAllChanges(other));

    _resetMemory();
    await initCRDT();
    expect(getDocument().todos[0].name).toBe('remote');
  });
});

describe('local change when storage is broken', () => {
  it('still hands the change to sync and reports the persist error', async () => {
    const pushed = [];
    const errors = [];
    setOnLocalChange(c => pushed.push(c));
    setOnPersistError(e => errors.push(e));

    // Break storage for good: delete the object stores out from under us by
    // deleting the database. Reopening then yields fresh stores, so the
    // change is still persisted; to model a truly broken store we make the
    // reopened DB fail by closing it again from inside the hook.
    const db = await _getDB();
    db.close();
    // Make every reopen fail: replace indexedDB.open temporarily.
    const realOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => { throw Object.assign(new Error('closing'), { name: 'InvalidStateError' }); };
    try {
      const change = await addTask({ id: 1, name: 'A', completed: false });
      expect(change).toBeInstanceOf(Uint8Array);
      expect(pushed).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(getDocument().todos).toHaveLength(1);
    } finally {
      indexedDB.open = realOpen;
    }
  });
});

describe('upgrade from storage format v1', () => {
  it('folds old unpushed changes into the document and requires a reconcile', async () => {
    // Build v1 content: a snapshot with task A, and an unpushed change adding B.
    let d = Automerge.change(Automerge.init(), x => { x.todos = [{ id: 1, name: 'A', completed: false }]; });
    const snapshot = Automerge.save(d);
    const before = d;
    d = Automerge.change(d, x => { x.todos.push({ id: 2, name: 'B', completed: false }); });
    const [unpushedChange] = Automerge.getChanges(before, d);

    // Start from no database at all, then create a v1 database by hand.
    try { (await _getDB()).close(); } catch { /* not open */ }
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('stufDB');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('stufDB', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'key' });
        req.result.createObjectStore('unpushed', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta', 'unpushed'], 'readwrite');
        tx.objectStore('meta').put({ key: 'snapshot', value: snapshot });
        tx.objectStore('unpushed').add({ change: unpushedChange });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    _resetMemory();
    await initCRDT();
    expect(getDocument().todos.map(t => t.name)).toEqual(['A', 'B']);
    expect(needsReconcile()).toBe(true);
    // Everything is "unpushed" until a reconcile tells us what the server has.
    expect(await getUnpushedChanges()).toHaveLength(2);

    // Survives a reload in the new format.
    _resetMemory();
    await initCRDT();
    expect(getDocument().todos).toHaveLength(2);
    expect(needsReconcile()).toBe(true);
  });
});
