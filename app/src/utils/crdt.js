import Automerge from 'automerge';
import { openDB } from 'idb';

let doc = Automerge.init()

// Hook for sync — called with each new local change (object)
let _onLocalChange = null;
export function setOnLocalChange(fn) { _onLocalChange = fn; }

function emitChange(change) {
  if (_onLocalChange) _onLocalChange(change);
}

const dbPromise = openDB('crdtDB', 1, {
  upgrade(db) {
    db.createObjectStore('crdt', { keyPath: 'id', autoIncrement: true });
  },
});

export const resetCRDT = async () => {
  const db = await dbPromise;
  await db.clear('crdt');
  doc = Automerge.init();
};

export const saveDocumentSnapshot = () => {
  const saved = Automerge.save(doc);
  // Automerge 0.14 save() returns a string (JSON), encode to bytes for encryption
  const bytes = new TextEncoder().encode(saved);
  return Array.from(bytes);
};

export const loadDocumentSnapshot = async (data) => {
  const db = await dbPromise;
  await db.clear('crdt');
  // Automerge 0.14 load() expects a string
  const str = new TextDecoder().decode(new Uint8Array(data));
  doc = Automerge.load(str);
  // Save all changes from loaded doc to IndexedDB for persistence
  const changes = Automerge.getAllChanges(doc);
  for (const change of changes) {
    await db.add('crdt', { change });
  }
};

export const initCRDT = async () => {
  const db = await dbPromise;
  const allRecords = await db.getAll('crdt')
  const changes = allRecords
    .map(record => record.change)
    .filter(change => change !== undefined);
  if (changes.length > 0) {
    doc = Automerge.applyChanges(doc, changes);
  }
};

const saveChange = async (change) => {
  const db = await dbPromise;
  await db.add('crdt', { change });
};

export const applyRemoteChanges = async (changes) => {
  for (let i = 0; i < changes.length; i++) {
    try {
      const newDoc = Automerge.applyChanges(doc, [changes[i]]);
      doc = newDoc;
      await saveChange(changes[i]);
    } catch (err) {
      console.warn(`Failed to apply remote change ${i + 1}/${changes.length}:`, err.message);
    }
  }
};

export const getDocument = () => doc;

export const getLocalChanges = () => {
  return Automerge.getAllChanges(doc);
};

export const addTask = async (task) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Add Task', (doc) => {
    if (!doc.todos) doc.todos = []
    doc.todos.push(task);
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const updateTask = async (id, fields) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Update Task', (doc) => {
    if (!doc.todos) return;
    const task = doc.todos.find(t => t.id === id);
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
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const deleteTask = async (id) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Delete Task', (doc) => {
    if (!doc.todos) return;
    const index = doc.todos.findIndex((task) => task.id === id);
    if (index !== -1) {
      doc.todos.splice(index, 1);
    }
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const getGlobalTags = () => {
  return doc.tags ? Array.from(doc.tags).map(t => String(t)) : [];
};

export const addGlobalTag = async (name) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Add Tag', (doc) => {
    if (!doc.tags) doc.tags = [];
    if (!doc.tags.find(t => t === name)) {
      doc.tags.push(name);
    }
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const deleteGlobalTag = async (name) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Delete Tag', (doc) => {
    if (!doc.tags) return;
    const index = doc.tags.findIndex(t => t === name);
    if (index !== -1) {
      doc.tags.splice(index, 1);
    }
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const getRecentTags = () => {
  return doc.recentTags ? Array.from(doc.recentTags).map(t => String(t)) : [];
};

export const updateRecentTags = async (tags) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Update Recent Tags', (doc) => {
    doc.recentTags = tags.slice(0, 3);
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const getProjects = () => {
  return doc.projects ? Array.from(doc.projects).map(p => ({ id: p.id, name: String(p.name) })) : [];
};

export const addProject = async (name) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Add Project', (doc) => {
    if (!doc.projects) doc.projects = [];
    doc.projects.push({ id: Date.now(), name });
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const deleteProject = async (id) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Delete Project', (doc) => {
    if (!doc.projects) return;
    const index = doc.projects.findIndex(p => p.id === id);
    if (index !== -1) {
      doc.projects.splice(index, 1);
    }
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

export const updateTaskOrder = async (taskUpdates) => {
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Update Order', (doc) => {
    if (!doc.todos) return;
    taskUpdates.forEach(({ id, order }) => {
      const task = doc.todos.find(t => t.id === id);
      if (task) task.order = order;
    });
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};

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
  const oldDoc = doc;
  doc = Automerge.change(doc, 'Update Settings', (doc) => {
    if (!doc.settings) doc.settings = {};
    for (const [key, value] of Object.entries(newSettings)) {
      doc.settings[key] = value;
    }
  });
  const changes = Automerge.getChanges(oldDoc, doc);
  if (changes.length === 0) return null;
  const lastChange = changes[changes.length - 1];
  await saveChange(lastChange);
  emitChange(lastChange);
  return lastChange;
};


//(async () => {
//
//  // MachineA
//  let adoc = Automerge.init()
//  let aadoc = Automerge.change(adoc, 'Add todo', (doc) => {
//    doc.todos = []
//  })
//  let bdoc = Automerge.change(aadoc, 'Add todo', (doc) => {
//    doc.todos.push({ id: 1, text: 'eplekake' })
//  })
//
//  let changes = Automerge.getChanges(adoc, bdoc)
//  console.log(changes)
//
//  // MachineB
//  let cdoc = Automerge.init()
//  let ddoc = Automerge.applyChanges(cdoc, changes)
//
//  console.log(adoc.todos, bdoc.todos, cdoc.todos, ddoc.todos)
//
//})()
