import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  initCRDT, resetCRDT, _resetMemory, getDocument,
  addTask, updateTask, deleteTask,
  addGlobalTag, deleteGlobalTag, getGlobalTags,
  addProject, deleteProject, getProjects,
  updateTaskOrder, getSettings, updateSettings,
  saveSnapshot, getUnpushedChanges, clearUnpushedChanges,
  saveDocumentSnapshot, loadDocumentSnapshot,
  applyRemoteChanges,
} from '../crdt.js';
import * as Automerge from '@automerge/automerge';

beforeEach(async () => {
  // Clear all IndexedDB databases
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    indexedDB.deleteDatabase(db.name);
  }
  await resetCRDT();
});

describe('initCRDT', () => {
  it('initializes with empty document', async () => {
    await initCRDT();
    const doc = getDocument();
    expect(doc).toBeDefined();
    expect(doc.todos).toBeUndefined();
  });

  it('loads from saved snapshot', async () => {
    await initCRDT();
    await addTask({ id: 1, name: 'Test', completed: false, created: Date.now(), updated: Date.now() });
    await saveSnapshot();

    // Reset in-memory only, keep DB intact
    _resetMemory();
    await initCRDT();
    const doc = getDocument();
    expect(doc.todos).toHaveLength(1);
    expect(doc.todos[0].name).toBe('Test');
  });

  it('replays unpushed changes on top of snapshot', async () => {
    await initCRDT();
    await addTask({ id: 1, name: 'First', completed: false, created: Date.now(), updated: Date.now() });
    await saveSnapshot();
    await clearUnpushedChanges();

    // Add another task (will be in unpushed)
    await addTask({ id: 2, name: 'Second', completed: false, created: Date.now(), updated: Date.now() });

    // Reset in-memory and reload — should have both tasks
    _resetMemory();
    await initCRDT();
    const doc = getDocument();
    expect(doc.todos).toHaveLength(2);
    expect(doc.todos[0].name).toBe('First');
    expect(doc.todos[1].name).toBe('Second');
  });
});

describe('Task operations', () => {
  beforeEach(async () => {
    await initCRDT();
  });

  it('adds a task', async () => {
    const change = await addTask({ id: 1, name: 'Buy milk', completed: false });
    expect(change).toBeDefined();
    const doc = getDocument();
    expect(doc.todos).toHaveLength(1);
    expect(doc.todos[0].name).toBe('Buy milk');
    expect(doc.todos[0].completed).toBe(false);
  });

  it('updates a task', async () => {
    await addTask({ id: 1, name: 'Buy milk', completed: false });
    await updateTask(1, { name: 'Buy oat milk', completed: true });
    const doc = getDocument();
    expect(doc.todos[0].name).toBe('Buy oat milk');
    expect(doc.todos[0].completed).toBe(true);
  });

  it('deletes a task', async () => {
    await addTask({ id: 1, name: 'Buy milk', completed: false });
    await addTask({ id: 2, name: 'Walk dog', completed: false });
    await deleteTask(1);
    const doc = getDocument();
    expect(doc.todos).toHaveLength(1);
    expect(doc.todos[0].name).toBe('Walk dog');
  });

  it('updates task with array fields (tags, checklist)', async () => {
    await addTask({ id: 1, name: 'Shopping', completed: false });
    await updateTask(1, {
      tags: ['food', 'urgent'],
      checklist: [{ id: 10, text: 'Milk', completed: false }]
    });
    const doc = getDocument();
    expect(doc.todos[0].tags).toEqual(['food', 'urgent']);
    expect(doc.todos[0].checklist).toHaveLength(1);
    expect(doc.todos[0].checklist[0].text).toBe('Milk');
  });

  it('deletes a field by setting null', async () => {
    await addTask({ id: 1, name: 'Task', completed: false, notes: 'Some notes' });
    await updateTask(1, { notes: null });
    const doc = getDocument();
    expect(doc.todos[0].notes).toBeUndefined();
  });
});

describe('Unpushed changes tracking', () => {
  beforeEach(async () => {
    await initCRDT();
  });

  it('tracks unpushed changes', async () => {
    await addTask({ id: 1, name: 'Task 1', completed: false });
    await addTask({ id: 2, name: 'Task 2', completed: false });
    const unpushed = await getUnpushedChanges();
    expect(unpushed).toHaveLength(2);
    expect(unpushed[0]).toBeInstanceOf(Uint8Array);
  });

  it('clears unpushed changes', async () => {
    await addTask({ id: 1, name: 'Task', completed: false });
    await clearUnpushedChanges();
    const unpushed = await getUnpushedChanges();
    expect(unpushed).toHaveLength(0);
  });
});

describe('Snapshot for sync', () => {
  beforeEach(async () => {
    await initCRDT();
  });

  it('exports and imports snapshot', async () => {
    await addTask({ id: 1, name: 'Test', completed: false });
    const snapshot = saveDocumentSnapshot();
    expect(snapshot).toBeInstanceOf(Array);
    expect(snapshot.length).toBeGreaterThan(0);

    // Load on a "different device"
    await resetCRDT();
    await initCRDT();
    await loadDocumentSnapshot(snapshot);
    const doc = getDocument();
    expect(doc.todos).toHaveLength(1);
    expect(doc.todos[0].name).toBe('Test');
  });
});

describe('Remote changes', () => {
  it('applies remote changes from another document', async () => {
    await initCRDT();

    // Simulate a remote document making changes
    let remoteDoc = Automerge.init();
    remoteDoc = Automerge.change(remoteDoc, (d) => {
      d.todos = [];
      d.todos.push({ id: 99, name: 'Remote task', completed: false });
    });
    const changes = Automerge.getChanges(Automerge.init(), remoteDoc);

    await applyRemoteChanges(changes);
    const doc = getDocument();
    expect(doc.todos).toHaveLength(1);
    expect(doc.todos[0].name).toBe('Remote task');
  });
});

describe('Tags', () => {
  beforeEach(async () => {
    await initCRDT();
  });

  it('adds and lists tags', async () => {
    await addGlobalTag('work');
    await addGlobalTag('personal');
    const tags = getGlobalTags();
    expect(tags).toEqual(['work', 'personal']);
  });

  it('does not duplicate tags', async () => {
    await addGlobalTag('work');
    await addGlobalTag('work');
    const tags = getGlobalTags();
    expect(tags).toEqual(['work']);
  });

  it('deletes a tag', async () => {
    await addGlobalTag('work');
    await addGlobalTag('personal');
    await deleteGlobalTag('work');
    const tags = getGlobalTags();
    expect(tags).toEqual(['personal']);
  });
});

describe('Projects', () => {
  beforeEach(async () => {
    await initCRDT();
  });

  it('adds and lists projects', async () => {
    await addProject('Stuf');
    const projects = getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('Stuf');
  });

  it('deletes a project', async () => {
    await addProject('Stuf');
    const projects = getProjects();
    await deleteProject(projects[0].id);
    expect(getProjects()).toHaveLength(0);
  });
});

describe('Task ordering', () => {
  beforeEach(async () => {
    await initCRDT();
  });

  it('updates task order', async () => {
    await addTask({ id: 1, name: 'First', completed: false, order: 1 });
    await addTask({ id: 2, name: 'Second', completed: false, order: 2 });
    await updateTaskOrder([{ id: 1, order: 2 }, { id: 2, order: 1 }]);
    const doc = getDocument();
    expect(doc.todos[0].order).toBe(2);
    expect(doc.todos[1].order).toBe(1);
  });
});

describe('Settings', () => {
  it('returns defaults when no settings', async () => {
    await initCRDT();
    const settings = getSettings();
    expect(settings.morningHour).toBe(9);
    expect(settings.eveningHour).toBe(17);
  });

  it('updates settings', async () => {
    await initCRDT();
    await updateSettings({ morningHour: 8, eveningHour: 18 });
    const settings = getSettings();
    expect(settings.morningHour).toBe(8);
    expect(settings.eveningHour).toBe(18);
  });
});
