import Automerge from 'automerge';
import WebSocket from 'ws';
import { encrypt, decrypt } from './crypto.js';

let doc = Automerge.init();
let lastSeq = 0;
let serverUrl = null;
let deviceToken = null;
let ws = null;
let onChangeCallback = null;

export function configure(url, token) {
  serverUrl = url.replace(/\/$/, '');
  deviceToken = token;
}

export function getDoc() {
  return doc;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${deviceToken}`
  };
}

export async function pullChanges() {
  const res = await fetch(`${serverUrl}/api/changes?since=${lastSeq}`, { headers: headers() });
  if (!res.ok) throw new Error(`Pull failed: ${res.status} ${await res.text()}`);
  const { changes, lastSeq: newSeq } = await res.json();
  for (const { data } of changes) {
    try {
      const change = await decrypt(data);
      doc = Automerge.applyChanges(doc, [change]);
    } catch (err) {
      console.warn(`Failed to apply change: ${err.message}`);
    }
  }
  if (newSeq !== undefined) lastSeq = newSeq;
  return doc;
}

export async function pullSnapshot() {
  const res = await fetch(`${serverUrl}/api/changes/snapshot`, { headers: headers() });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Snapshot pull failed: ${res.status}`);
  }
  const { data, seq } = await res.json();
  if (data) {
    const decrypted = await decrypt(data);
    const bytes = new Uint8Array(decrypted);
    doc = Automerge.load(bytes);
    lastSeq = seq || 0;
  }
  return doc;
}

export async function pushChanges(oldDoc, newDoc) {
  const changes = Automerge.getChanges(oldDoc, newDoc);
  if (changes.length === 0) return;
  const encrypted = await Promise.all(changes.map(c => encrypt(c)));
  const res = await fetch(`${serverUrl}/api/changes`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ changes: encrypted })
  });
  if (!res.ok) throw new Error(`Push failed: ${res.status} ${await res.text()}`);
  const { lastSeq: newSeq } = await res.json();
  if (newSeq !== undefined) lastSeq = newSeq;
}

export function applyChange(changeFn) {
  const oldDoc = doc;
  doc = Automerge.change(doc, changeFn);
  return { oldDoc, newDoc: doc };
}

export async function applyAndPush(changeFn) {
  const { oldDoc, newDoc } = applyChange(changeFn);
  await pushChanges(oldDoc, newDoc);
  return newDoc;
}

export function connectWebSocket(onChange) {
  onChangeCallback = onChange;
  const wsUrl = serverUrl.replace(/^http/, 'ws') + `/api/ws?token=${deviceToken}`;
  ws = new WebSocket(wsUrl);
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'new_changes') {
        await pullChanges();
        if (onChangeCallback) onChangeCallback(doc);
      }
    } catch (err) {
      console.warn('WS message error:', err.message);
    }
  });
  ws.on('close', () => {
    setTimeout(() => connectWebSocket(onChange), 5000);
  });
  ws.on('error', (err) => {
    console.warn('WS error:', err.message);
  });
}

export async function initialize() {
  try {
    await pullSnapshot();
  } catch (e) {
    // No snapshot available
  }
  await pullChanges();
  return doc;
}
