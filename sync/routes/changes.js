import { Router } from 'express';
import { storeChanges, getChangesSince, getLastSeq, findDevice, getSpace, storeSnapshot, getSnapshot, getConfig, setConfig } from '../db.js';
import { notifyClients } from '../ws.js';

const router = Router();

async function requireDevice(req, res, next) {
  const tokenHash = req.deviceTokenHash;
  if (!tokenHash) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  const device = await findDevice(tokenHash);
  if (!device) {
    return res.status(401).json({ error: 'Unknown device' });
  }
  const space = await getSpace(device.space_id);
  if (!space || !space.active) {
    return res.status(403).json({ error: 'space_inactive' });
  }
  req.device = device;
  next();
}

router.use(requireDevice);

// Push encrypted changes
router.post('/', async (req, res) => {
  const { changes, formatVersion } = req.body;
  const spaceId = req.device.space_id;

  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: 'Missing or empty changes array' });
  }

  // Check format version compatibility
  const spaceFormat = await getConfig(spaceId, 'format_version');
  if (spaceFormat && formatVersion !== parseInt(spaceFormat)) {
    return res.status(409).json({ error: 'format_version_mismatch', expected: parseInt(spaceFormat), got: formatVersion || null });
  }

  const seqs = await storeChanges(spaceId, changes, req.device.id);
  const lastSeq = await getLastSeq(spaceId);

  notifyClients(req.device.id, spaceId, lastSeq, changes.length);

  res.json({ stored: changes.length, lastSeq });
});

// Pull changes since a sequence number
router.get('/', async (req, res) => {
  const spaceId = req.device.space_id;
  const since = parseInt(req.query.since) || 0;
  const changes = await getChangesSince(spaceId, since);
  const lastSeq = await getLastSeq(spaceId);

  res.json({ changes, lastSeq });
});

// Set format version for the space (idempotent, never downgrades)
router.post('/format-version', async (req, res) => {
  const spaceId = req.device.space_id;
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid version' });
  }
  const current = await getConfig(spaceId, 'format_version');
  if (current && parseInt(current) >= version) {
    return res.json({ ok: true, formatVersion: parseInt(current) });
  }
  await setConfig(spaceId, 'format_version', String(version));
  res.json({ ok: true, formatVersion: version });
});

// Store a document snapshot (encrypted)
router.post('/snapshot', async (req, res) => {
  const spaceId = req.device.space_id;
  const { snapshot } = req.body;
  if (!snapshot) {
    return res.status(400).json({ error: 'Missing snapshot' });
  }
  await storeSnapshot(spaceId, snapshot, req.device.id);
  const lastSeq = await getLastSeq(spaceId);
  res.json({ ok: true, seq: lastSeq });
});

// Get the latest snapshot
router.get('/snapshot', async (req, res) => {
  const result = await getSnapshot(req.device.space_id);
  if (!result) {
    return res.status(404).json({ error: 'No snapshot available' });
  }
  res.json(result);
});

export default router;
