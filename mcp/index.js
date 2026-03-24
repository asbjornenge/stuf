import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { configure, initialize, getDoc, applyAndPush, connectWebSocket } from './sync.js';
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

server.tool('pair', 'Pair with a stuf space by scanning QR code from the stuf app', {}, async () => {
  if (synced) {
    return { content: [{ type: 'text', text: 'Already paired and synced.' }] };
  }

  try {
    const config = await startPairingServer();
    await setEncryptionKey(config.encryptionKey);
    configure(config.serverUrl, config.deviceToken);
    await initialize();
    connectWebSocket(() => {});
    synced = true;
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
  status: z.enum(['all', 'active', 'done']).optional().default('all').describe('Filter by status'),
  tag: z.string().optional().describe('Filter by tag'),
  project: z.string().optional().describe('Filter by project name')
}, async ({ status, tag, project }) => {
  requireSync();
  const doc = getDoc();
  let tasks = doc.todos || [];

  if (status === 'active') tasks = tasks.filter(t => !t.done);
  if (status === 'done') tasks = tasks.filter(t => t.done);
  if (tag) tasks = tasks.filter(t => t.tags && t.tags.includes(tag));
  if (project) {
    const proj = (doc.projects || []).find(p => p.name === project);
    if (proj) tasks = tasks.filter(t => t.projectId === proj.id);
  }

  const formatted = tasks.map(t => {
    const tags = t.tags?.length ? ` [${t.tags.join(', ')}]` : '';
    const done = t.done ? '✓' : '○';
    const proj = t.projectId ? ` (${(doc.projects || []).find(p => p.id === t.projectId)?.name || ''})` : '';
    return `${done} ${t.text}${tags}${proj}`;
  }).join('\n');

  return { content: [{ type: 'text', text: formatted || 'No tasks found.' }] };
});

server.tool('add_task', 'Add a new task', {
  text: z.string().describe('Task text'),
  tags: z.array(z.string()).optional().describe('Tags for the task'),
  project: z.string().optional().describe('Project name')
}, async ({ text, tags, project }) => {
  requireSync();
  const doc = getDoc();
  let projectId = undefined;
  if (project) {
    const proj = (doc.projects || []).find(p => p.name === project);
    if (proj) projectId = proj.id;
  }

  const id = crypto.randomUUID();
  const maxOrder = (doc.todos || []).reduce((max, t) => Math.max(max, t.order || 0), 0);

  await applyAndPush(d => {
    if (!d.todos) d.todos = [];
    const task = { id, text, done: false, order: maxOrder + 1 };
    if (tags?.length) task.tags = tags;
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
  const task = (doc.todos || []).find(t => !t.done && t.text.toLowerCase().includes(text.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No active task matching "${text}" found.` }] };

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) t.done = true;
  });

  return { content: [{ type: 'text', text: `Completed: ${task.text}` }] };
});

server.tool('delete_task', 'Delete a task', {
  text: z.string().describe('Task text (partial match)')
}, async ({ text }) => {
  requireSync();
  const doc = getDoc();
  const idx = (doc.todos || []).findIndex(t => t.text.toLowerCase().includes(text.toLowerCase()));
  if (idx === -1) return { content: [{ type: 'text', text: `No task matching "${text}" found.` }] };

  const taskText = doc.todos[idx].text;
  await applyAndPush(d => {
    d.todos.deleteAt(idx);
  });

  return { content: [{ type: 'text', text: `Deleted: ${taskText}` }] };
});

server.tool('update_task', 'Update a task text', {
  search: z.string().describe('Task text to find (partial match)'),
  text: z.string().optional().describe('New task text'),
  tags: z.array(z.string()).optional().describe('New tags (replaces existing)')
}, async ({ search, text, tags }) => {
  requireSync();
  const doc = getDoc();
  const task = (doc.todos || []).find(t => t.text.toLowerCase().includes(search.toLowerCase()));
  if (!task) return { content: [{ type: 'text', text: `No task matching "${search}" found.` }] };

  await applyAndPush(d => {
    const t = d.todos.find(t => t.id === task.id);
    if (t) {
      if (text) t.text = text;
      if (tags) t.tags = tags;
    }
  });

  return { content: [{ type: 'text', text: `Updated: ${text || task.text}` }] };
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
