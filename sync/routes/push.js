import { Router } from 'express';
import { findDevice, storePushSubscription, storeReminder, deleteReminder, getServerConfig } from '../db.js';

const router = Router();

async function requireDevice(req, res, next) {
  const tokenHash = req.deviceTokenHash;
  if (!tokenHash) return res.status(401).json({ error: 'Missing authorization' });
  const device = await findDevice(tokenHash);
  if (!device) return res.status(401).json({ error: 'Unknown device' });
  req.device = device;
  next();
}

router.use(requireDevice);

// Return VAPID public key (server-level)
router.get('/vapid-key', async (req, res) => {
  const publicKey = await getServerConfig('vapid_public_key');
  if (!publicKey) return res.status(500).json({ error: 'VAPID keys not configured' });
  res.json({ publicKey });
});

// Store push subscription
router.post('/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  await storePushSubscription(req.device.space_id, req.device.id, subscription);
  res.json({ ok: true });
});

// Register a reminder (notifies all devices in the space)
router.post('/reminder', async (req, res) => {
  const { taskId, title, notifyAt } = req.body;
  if (!taskId || !notifyAt) {
    return res.status(400).json({ error: 'Missing taskId or notifyAt' });
  }
  await storeReminder(req.device.space_id, taskId, title || null, notifyAt);
  res.json({ ok: true });
});

// Cancel a reminder
router.delete('/reminder', async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'Missing taskId' });
  await deleteReminder(req.device.space_id, taskId);
  res.json({ ok: true });
});

export default router;
