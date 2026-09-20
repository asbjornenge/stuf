import { Router } from 'express';
import { storeChanges, getChangesSince, getLastSeq, findDevice, getSpace, storeSnapshot, getSnapshot, getConfig, setConfig, getCompactedSeq, getEpoch, rotateEpoch } from '../db.js';
import { notifyClients } from '../ws.js';
import { PULL_PAGE_MAX } from '../config.js';

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

// Pushes must belong to the space's current epoch (see rotateEpoch in db.js).
// Clients that predate epochs send none, which only matches epoch 0.
async function requireEpoch(req, res, next) {
  const epoch = await getEpoch(req.device.space_id);
  const sent = Number.isInteger(req.body?.epoch) ? req.body.epoch : 0;
  if (sent !== epoch) {
    return res.status(409).json({ error: 'epoch_mismatch', epoch });
  }
  req.epoch = epoch;
  next();
}

// Push encrypted changes.
// Body: { changes: [ { data, hash } | string ], formatVersion }
// Changes carrying a hash are de-duplicated; re-pushing is safe and cheap.
router.post('/', requireEpoch, async (req, res) => {
  const { changes, formatVersion } = req.body;
  const spaceId = req.device.space_id;

  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: 'Missing or empty changes array' });
  }
  for (const c of changes) {
    const ok = typeof c === 'string' || (c && typeof c.data === 'string');
    if (!ok) return res.status(400).json({ error: 'Invalid change entry' });
  }

  // Check format version compatibility
  const spaceFormat = await getConfig(spaceId, 'format_version');
  if (spaceFormat && formatVersion !== parseInt(spaceFormat)) {
    return res.status(409).json({ error: 'format_version_mismatch', expected: parseInt(spaceFormat), got: formatVersion || null });
  }

  const { stored, duplicates } = await storeChanges(spaceId, changes, req.device.id);
  const lastSeq = await getLastSeq(spaceId);

  if (stored > 0) notifyClients(req.device.id, spaceId, lastSeq, stored);

  res.json({ stored, duplicates, lastSeq, epoch: req.epoch });
});

// Pull changes since a sequence number.
// Without `limit`: legacy behaviour, everything after `since`, lastSeq = global max.
// With `limit`: one page; `lastSeq` is the cursor to continue from, `hasMore`
// says whether to keep paging, `latestSeq` is the global max (informational).
// 410 history_compacted: `since` predates deleted history — bootstrap from
// the snapshot instead.
router.get('/', async (req, res) => {
  const spaceId = req.device.space_id;
  const since = parseInt(req.query.since) || 0;

  const epoch = await getEpoch(spaceId);
  const compactedSeq = await getCompactedSeq(spaceId);
  if (since < compactedSeq) {
    return res.status(410).json({ error: 'history_compacted', compactedSeq, epoch });
  }

  const rawLimit = parseInt(req.query.limit);
  if (!rawLimit || rawLimit < 1) {
    const changes = await getChangesSince(spaceId, since);
    const lastSeq = await getLastSeq(spaceId);
    return res.json({ changes, lastSeq, epoch });
  }

  const limit = Math.min(rawLimit, PULL_PAGE_MAX);
  const rows = await getChangesSince(spaceId, since, limit + 1);
  const hasMore = rows.length > limit;
  const changes = hasMore ? rows.slice(0, limit) : rows;
  const cursor = changes.length > 0 ? changes[changes.length - 1].seq : since;
  const latestSeq = await getLastSeq(spaceId);
  res.json({ changes, lastSeq: cursor, hasMore, latestSeq, epoch });
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

// Store a document snapshot (encrypted).
// Body: { snapshot, seq } where `seq` is the cursor the device had fully
// applied when the snapshot was taken (omitted by legacy clients).
router.post('/snapshot', requireEpoch, async (req, res) => {
  const spaceId = req.device.space_id;
  const { snapshot, seq } = req.body;
  if (!snapshot) {
    return res.status(400).json({ error: 'Missing snapshot' });
  }
  await storeSnapshot(spaceId, snapshot, req.device.id, Number.isInteger(seq) ? seq : undefined);
  const lastSeq = await getLastSeq(spaceId);
  res.json({ ok: true, seq: lastSeq, epoch: req.epoch });
});

// Get the latest snapshot: { data, seq, epoch }. Changes with seq > `seq`
// must be pulled on top of it.
router.get('/snapshot', async (req, res) => {
  const spaceId = req.device.space_id;
  const result = await getSnapshot(spaceId);
  const epoch = await getEpoch(spaceId);
  if (!result) {
    return res.status(404).json({ error: 'No snapshot available', epoch });
  }
  res.json({ ...result, epoch });
});

// Start a new epoch: replace the document with a fresh, history-free one.
// Body: { snapshot, epoch } where epoch must be the current epoch + 1.
// Drops the change log (it belongs to the old document) and keeps the old
// snapshot as snapshot_prev. Every device adopts the new snapshot on its
// next sync; pushes with the old epoch are rejected with 409.
router.post('/epoch', async (req, res) => {
  const spaceId = req.device.space_id;
  const { snapshot, epoch } = req.body;
  if (!snapshot || !Number.isInteger(epoch)) {
    return res.status(400).json({ error: 'Missing snapshot or epoch' });
  }
  const result = await rotateEpoch(spaceId, snapshot, req.device.id, epoch);
  if (!result.ok) {
    return res.status(409).json({ error: 'epoch_mismatch', epoch: result.epoch });
  }
  console.log(`Epoch ${result.epoch} for space ${spaceId}: dropped ${result.deleted} changes`);
  res.json({ ok: true, epoch: result.epoch, seq: result.seq, deleted: result.deleted });
});

export default router;
