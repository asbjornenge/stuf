#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { configure, initialize, getDoc, applyAndPush, connectWebSocket, getServerUrl, getDeviceToken } from './sync.js';
import { setEncryptionKey } from './crypto.js';
import { startPairingServer } from './pair.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '.stuf-mcp.json');

let synced = false;

const server = new McpServer({
  name: 'stuf',
  version: '1.0.0',
  description: 'MCP server for stuf task management'
});

// --- Pair tool ---

let pairingPromise = null;

server.tool('pair', 'Pair with a stuf space by scanning QR code from the stuf app', {}, async () => {
  if (synced) {
    return { content: [{ type: 'text', text: 'Already paired and synced.' }] };
  }

  try {
    const { url, paired } = await startPairingServer();
    pairingPromise = paired;
    return { content: [{ type: 'text', text: `QR scanner opened at ${url}\n\nOpen stuf on your phone → Settings → Add Device → scan the QR code in the browser.\n\nThen call the "pair_complete" tool to finish.` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Pairing failed: ${err.message}` }] };
  }
});

server.tool('pair_complete', 'Complete pairing after scanning QR code', {}, async () => {
  if (synced) {
    return { content: [{ type: 'text', text: 'Already paired and synced.' }] };
  }
  if (!pairingPromise) {
    return { content: [{ type: 'text', text: 'No pairing in progress. Call "pair" first.' }] };
  }

  try {
    const config = await pairingPromise;
    await setEncryptionKey(config.encryptionKey);
    configure(config.serverUrl, config.deviceToken);
    await initialize();
    connectWebSocket(() => {});
    synced = true;
    pairingPromise = null;
    return { content: [{ type: 'text', text: 'Paired successfully! You can now manage tasks.' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Pairing failed: ${err.message}` }] };
  }
});

// --- Task tools ---

function requireSync() {
  if (!synced) throw new Error('Not synced. Run the "pair" tool first.');
}

server.tool('list_tasks', 'List all tasks, optionally filtered by status or tag', {
  status: z.enum(['all', 'active', 'done']).optional().default('active').describe('Filter by status'),
  tag: z.string().optional().describe('Filter by tag'),
  project: z.string().optional().describe('Filter by project name')
}, async ({ status, tag, project }) => {
  requireSync();
  const doc = getDoc();
  let tasks = doc.todos || [];

  if (status === 'active') tasks = tasks.filter(t => !t.completed && !(t.snoozeUntil && t.snoozeUntil > Date.now()));
  if (status === 'done') tasks = tasks.filter(t => t.completed);
  if (tag) tasks = tasks.filter(t => t.tags && t.tags.includes(tag));
  if (project) {
    const proj = (doc.projects || []).find(p => p.name === project);
    if (proj) tasks = tasks.filter(t => t.projectId === proj.id);
  }

  const formatted = tasks.map(t => {
    const tags = t.tags?.length ? ` [${t.tags.join(', ')}]` : '';
    const done = t.completed ? '✓' : '○';
    const proj = t.projectId ? ` (${(doc.projects || []).find(p => p.id === t.projectId)?.name || ''})` : '';
    let line = `${done} ${t.name}${tags}${proj}`;
    if (t.notes) line += `\n  📝 ${t.notes.split('\n')[0]}${t.notes.includes('\n') ? '...' : ''}`;
    if (t.checklist?.length) {
      const items = t.checklist.map(c => `  ${c.completed ? '☑' : '☐'} ${c.text}`).join('\n');
      line += '\n' + items;
    }
    return line;
  }).join('\n');

  return { content: [{ type: 'text', text: formatted || 'No tasks found.' }] };
});

server.tool('add_task', 'Add a new task', {
  text: z.string().describe('Task name/title'),
  notes: z.string().optional().describe('Notes/description (supports markdown)'),
  checklist: z.array(z.string()).optional().describe('Checklist items'),
  tags: z.array(z.string()).optional().describe('Tags for the task'),
  project: z.string().optional().describe('Project name')
}, async ({ text, notes, checklist, tags, project }) => {
  requireSync();
  const doc = getDoc();
  let projectId = undefined;
  if (project) {
    const proj = (doc.projects || []).find(p => p.name === project);
    if (proj) projectId = proj.id;
  }

  const now = Date.now();
  const maxOrder = (doc.todos || []).reduce((max, t) => Math.max(max, t.order || 0), 0);

  await applyAndPush(d => {
    // Auto-create missing tags
    if (tags?.length) {
      if (!d.tags) d.tags = [];
      for (const tag of tags) {
        if (!d.tags.find(t => t === tag)) d.tags.push(tag);
      }
    }
    if (!d.todos) d.todos = [];
    const task = { id: now, name: text, completed: false, created: now, updated: now, order: maxOrder + 1 };
    if (notes) task.notes = notes;
    if (tags?.length) task.tags = tags;
    if (checklist?.length) {
      task.checklist = checklist.map((item, i) => ({ id: now + i + 1, text: item, completed: false }));
    }
    if (projectId) task.projectId = projectId;
    d.todos.push(task);
  });

  return { content: [{ type: 'text', text: `Added task: ${text}` }] };
});

server.tool('complete_task', 'Mark a task as done', {
  text: z.string().describe('Task text (partial match)')
}, async ({ text }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => !t.completed && t.name.toLowerCase().includes(text.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No active task matching "${text}" found.` }] };

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) t.completed = true;
  });

  return { content: [{ type: 'text', text: `Completed: ${task.name}` }] };
});

server.tool('delete_task', 'Delete a task', {
  text: z.string().describe('Task text (partial match)')
}, async ({ text }) => {
  requireSync();
  const doc = getDoc();
  const idx = (doc.todos || []).findIndex(t => t.name.toLowerCase().includes(text.toLowerCase()));
  if (idx === -1) return { content: [{ type: 'text', text: `No task matching "${text}" found.` }] };

  const taskName = doc.todos[idx].name;
  await applyAndPush(d => {
    d.todos.deleteAt(idx);
  });

  return { content: [{ type: 'text', text: `Deleted: ${taskName}` }] };
});

server.tool('update_task', 'Update a task', {
  search: z.string().describe('Task text to find (partial match)'),
  text: z.string().optional().describe('New task name/title'),
  notes: z.string().optional().describe('New notes/description (supports markdown)'),
  checklist: z.array(z.string()).optional().describe('New checklist items (replaces existing)'),
  tags: z.array(z.string()).optional().describe('New tags (replaces existing)')
}, async ({ search, text, notes, checklist, tags }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => t.name.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No task matching "${search}" found.` }] };

  const now = Date.now();
  await applyAndPush(d => {
    // Auto-create missing tags
    if (tags?.length) {
      if (!d.tags) d.tags = [];
      for (const tag of tags) {
        if (!d.tags.find(t => t === tag)) d.tags.push(tag);
      }
    }
    const t = d.todos.find(t => t.id === task.id);
    if (t) {
      if (text) t.name = text;
      if (notes !== undefined) t.notes = notes || null;
      if (tags) t.tags = tags;
      if (checklist) {
        t.checklist = checklist.map((item, i) => ({ id: now + i, text: item, completed: false }));
      }
      t.updated = now;
    }
  });

  return { content: [{ type: 'text', text: `Updated: ${text || task.name}` }] };
});

server.tool('check_item', 'Toggle a checklist item as completed/uncompleted', {
  task: z.string().describe('Task text (partial match)'),
  item: z.string().describe('Checklist item text (partial match)')
}, async ({ task: taskSearch, item: itemSearch }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => t.name.toLowerCase().includes(taskSearch.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No task matching "${taskSearch}" found.` }] };
  if (!task.checklist?.length) return { content: [{ type: 'text', text: `Task "${task.name}" has no checklist.` }] };

  const checkItem = task.checklist.find(c => c.text.toLowerCase().includes(itemSearch.toLowerCase()));
  if (!checkItem) return { content: [{ type: 'text', text: `No checklist item matching "${itemSearch}" found.` }] };

  const newState = !checkItem.completed;
  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t?.checklist) {
      const c = t.checklist.find(c => c.id === checkItem.id);
      if (c) c.completed = newState;
      t.updated = Date.now();
    }
  });

  return { content: [{ type: 'text', text: `${newState ? '☑' : '☐'} ${checkItem.text}` }] };
});

server.tool('reorder_tasks', 'Move a task to a new position in the list', {
  search: z.string().describe('Task text to find (partial match)'),
  position: z.number().describe('New position (1-based, 1 = top)')
}, async ({ search, position }) => {
  requireSync();
  const doc = getDoc();
  const tasks = (doc.todos || []).filter(t => !t.completed);
  const sorted = [...tasks].sort((a, b) => (a.order || 0) - (b.order || 0));
  const task = sorted.find(t => t.name.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No active task matching "${search}" found.` }] };

  const targetIdx = Math.max(0, Math.min(position - 1, sorted.length - 1));

  // Recompute order for all active tasks with the moved task in its new position
  const filtered = sorted.filter(t => t.id !== task.id);
  filtered.splice(targetIdx, 0, task);
  const updates = filtered.map((t, i) => ({ id: t.id, order: i + 1 }));

  await applyAndPush(d => {
    for (const { id, order } of updates) {
      const t = d.todos.find(t => t.id === id);
      if (t) t.order = order;
    }
  });

  return { content: [{ type: 'text', text: `Moved "${task.name}" to position ${position}` }] };
});

server.tool('snooze_task', 'Snooze a task until a specific date/time', {
  search: z.string().describe('Task text (partial match)'),
  until: z.string().describe('ISO date/time string (e.g. "2026-03-26", "2026-03-26T09:00")')
}, async ({ search, until }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => !t.completed && t.name.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No active task matching "${search}" found.` }] };

  const snoozeUntil = new Date(until).getTime();
  if (isNaN(snoozeUntil)) return { content: [{ type: 'text', text: `Invalid date: ${until}` }] };

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) {
      t.snoozeUntil = snoozeUntil;
      t.updated = Date.now();
    }
  });

  return { content: [{ type: 'text', text: `Snoozed "${task.name}" until ${new Date(snoozeUntil).toLocaleString()}` }] };
});

server.tool('set_reminder', 'Set a reminder for a task at a specific date/time', {
  search: z.string().describe('Task text (partial match)'),
  at: z.string().describe('ISO date/time string for reminder (e.g. "2026-03-26T09:00")')
}, async ({ search, at }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => !t.completed && t.name.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No active task matching "${search}" found.` }] };

  const reminder = new Date(at).getTime();
  if (isNaN(reminder)) return { content: [{ type: 'text', text: `Invalid date: ${at}` }] };

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) {
      t.reminder = reminder;
      t.updated = Date.now();
    }
  });

  // Register with server for push notification
  try {
    await fetch(`${getServerUrl()}/api/push/reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getDeviceToken()}` },
      body: JSON.stringify({ taskId: String(task.id), title: task.name, notifyAt: reminder })
    });
  } catch (err) {
    // Push registration failed, but CRDT reminder is set
  }

  return { content: [{ type: 'text', text: `Reminder set for "${task.name}" at ${new Date(reminder).toLocaleString()}` }] };
});

server.tool('add_tag', 'Create a new global tag', {
  name: z.string().describe('Tag name')
}, async ({ name }) => {
  requireSync();
  const doc = getDoc();
  const exists = (doc.tags || []).find(t => t === name);
  if (exists) return { content: [{ type: 'text', text: `Tag "${name}" already exists.` }] };

  await applyAndPush(d => {
    if (!d.tags) d.tags = [];
    d.tags.push(name);
  });

  return { content: [{ type: 'text', text: `Created tag: ${name}` }] };
});

server.tool('delete_tag', 'Delete a global tag', {
  name: z.string().describe('Tag name')
}, async ({ name }) => {
  requireSync();
  const doc = getDoc();
  const idx = (doc.tags || []).findIndex(t => t === name);
  if (idx === -1) return { content: [{ type: 'text', text: `Tag "${name}" not found.` }] };

  await applyAndPush(d => {
    if (d.tags) d.tags.splice(idx, 1);
  });

  return { content: [{ type: 'text', text: `Deleted tag: ${name}` }] };
});

server.tool('unsnooze_task', 'Remove snooze from a task', {
  search: z.string().describe('Task text (partial match)')
}, async ({ search }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => t.name.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No task matching "${search}" found.` }] };

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) {
      delete t.snoozeUntil;
      t.updated = Date.now();
    }
  });

  return { content: [{ type: 'text', text: `Unsnooze: ${task.name}` }] };
});

server.tool('clear_reminder', 'Remove reminder from a task', {
  search: z.string().describe('Task text (partial match)')
}, async ({ search }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => t.name.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No task matching "${search}" found.` }] };

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) {
      delete t.reminder;
      t.updated = Date.now();
    }
  });

  // Cancel on server
  try {
    await fetch(`${getServerUrl()}/api/push/reminder`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getDeviceToken()}` },
      body: JSON.stringify({ taskId: String(task.id) })
    });
  } catch (err) {
    // Cancel failed, but CRDT reminder is cleared
  }

  return { content: [{ type: 'text', text: `Reminder cleared: ${task.name}` }] };
});

server.tool('add_project', 'Create a new project', {
  name: z.string().describe('Project name')
}, async ({ name }) => {
  requireSync();
  const doc = getDoc();
  const exists = (doc.projects || []).find(p => p.name === name);
  if (exists) return { content: [{ type: 'text', text: `Project "${name}" already exists.` }] };

  await applyAndPush(d => {
    if (!d.projects) d.projects = [];
    d.projects.push({ id: Date.now(), name });
  });

  return { content: [{ type: 'text', text: `Created project: ${name}` }] };
});

server.tool('delete_project', 'Delete a project', {
  name: z.string().describe('Project name')
}, async ({ name }) => {
  requireSync();
  const doc = getDoc();
  const idx = (doc.projects || []).findIndex(p => p.name === name);
  if (idx === -1) return { content: [{ type: 'text', text: `Project "${name}" not found.` }] };

  await applyAndPush(d => {
    if (d.projects) d.projects.splice(idx, 1);
  });

  return { content: [{ type: 'text', text: `Deleted project: ${name}` }] };
});

server.tool('move_to_project', 'Move a task to a project (or out of a project)', {
  search: z.string().describe('Task text (partial match)'),
  project: z.string().optional().describe('Project name (omit to remove from project)')
}, async ({ search, project }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => t.name.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No task matching "${search}" found.` }] };

  let projectId = null;
  if (project) {
    const proj = (doc.projects || []).find(p => p.name === project);
    if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found. Create it first with add_project.` }] };
    projectId = proj.id;
  }

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) {
      if (projectId) {
        t.projectId = projectId;
      } else {
        delete t.projectId;
      }
      t.updated = Date.now();
    }
  });

  return { content: [{ type: 'text', text: project ? `Moved "${task.name}" to project "${project}"` : `Removed "${task.name}" from project` }] };
});

server.tool('upcoming', 'Show upcoming tasks (snoozed tasks with future dates)', {}, async () => {
  requireSync();
  const doc = getDoc();
  const now = Date.now();
  const tasks = (doc.todos || [])
    .filter(t => !t.completed && t.snoozeUntil && t.snoozeUntil > now)
    .sort((a, b) => a.snoozeUntil - b.snoozeUntil);

  if (tasks.length === 0) return { content: [{ type: 'text', text: 'No upcoming snoozed tasks.' }] };

  const formatted = tasks.map(t => {
    const date = new Date(t.snoozeUntil).toLocaleDateString();
    const reminder = t.reminder ? ` 🔔 ${new Date(t.reminder).toLocaleString()}` : '';
    return `○ ${t.name} — snoozed until ${date}${reminder}`;
  }).join('\n');

  return { content: [{ type: 'text', text: formatted }] };
});

server.tool('list_projects', 'List all projects', {}, async () => {
  requireSync();
  const doc = getDoc();
  const projects = (doc.projects || []).map(p => p.name).join('\n');
  return { content: [{ type: 'text', text: projects || 'No projects.' }] };
});

server.tool('list_tags', 'List all tags', {}, async () => {
  requireSync();
  const doc = getDoc();
  const tags = (doc.tags || []).join(', ');
  return { content: [{ type: 'text', text: tags || 'No tags.' }] };
});

// --- Start ---

async function main() {
  // Env vars override config file
  const envUrl = process.env.STUF_SERVER_URL;
  const envToken = process.env.STUF_DEVICE_TOKEN;
  const envKey = process.env.STUF_ENCRYPTION_KEY;

  if (envUrl && envToken && envKey) {
    await setEncryptionKey(envKey);
    configure(envUrl, envToken);
    await initialize();
    connectWebSocket(() => {});
    synced = true;
  } else if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    await setEncryptionKey(config.encryptionKey);
    configure(config.serverUrl, config.deviceToken);
    await initialize();
    connectWebSocket(() => {});
    synced = true;
  }
  // Otherwise: not synced, user must call "pair" tool

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
