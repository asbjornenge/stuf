import { WebSocketServer } from 'ws';
import { hashToken, findDevice } from './db.js';

const clients = new Map(); // deviceId -> { spaceId, sockets: Set<ws> }

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/api/ws' });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    const tokenHash = hashToken(token);
    const device = await findDevice(tokenHash);
    if (!device) {
      console.warn('WS auth failed: unknown device token');
      ws.close(4003, 'Unauthorized');
      return;
    }
    // Close any existing connections from this device (stale from reload)
    const existing = clients.get(device.id);
    if (existing && existing.sockets.size > 0) {
      console.log(`WS closing ${existing.sockets.size} stale connection(s) for device ${device.id}`);
      for (const old of existing.sockets) {
        old.close(4000, 'Replaced by new connection');
      }
      existing.sockets.clear();
    }

    console.log(`WS connected: device ${device.id} space ${device.space_id}`);

    // Track this connection
    if (!clients.has(device.id)) {
      clients.set(device.id, { spaceId: device.space_id, sockets: new Set() });
    }
    clients.get(device.id).sockets.add(ws);

    ws.on('close', () => {
      console.log(`WS disconnected: device ${device.id}`);
      const entry = clients.get(device.id);
      if (entry) {
        entry.sockets.delete(ws);
        if (entry.sockets.size === 0) {
          clients.delete(device.id);
        }
      }
    });

    // Keep alive
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  // Ping interval to detect dead connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 15000);

  wss.on('close', () => clearInterval(interval));
}

export function getConnectedCount() {
  let total = 0;
  for (const { sockets } of clients.values()) {
    total += sockets.size;
  }
  return { devices: clients.size, connections: total };
}

// Notify devices in the same space EXCEPT the sender
export function notifyClients(senderDeviceId, spaceId, lastSeq, count) {
  const message = JSON.stringify({ type: 'new_changes', lastSeq, count });

  for (const [deviceId, entry] of clients) {
    if (deviceId === senderDeviceId) continue;
    if (entry.spaceId !== spaceId) continue;
    for (const ws of entry.sockets) {
      if (ws.readyState === 1) { // OPEN
        ws.send(message);
      }
    }
  }
}
