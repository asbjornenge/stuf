import { Router } from 'express';
import {
  findSpaceByPairingToken, completePairing, hashToken,
  findDevice, createInvite, verifyAndConsumeInvite, addDevice,
} from '../db.js';

const router = Router();

// First device pairing (using server's pairing token)
router.post('/pair', async (req, res) => {
  const { pairingToken, deviceToken } = req.body;

  if (!pairingToken || !deviceToken) {
    return res.status(400).json({ error: 'Missing pairingToken or deviceToken' });
  }

  const spaceId = await findSpaceByPairingToken(pairingToken);
  if (!spaceId) {
    return res.status(403).json({ error: 'Invalid or expired pairing token' });
  }

  const tokenHash = hashToken(deviceToken);
  await completePairing(spaceId, tokenHash);

  res.json({ status: 'paired' });
});

// Create invite for additional device (requires authenticated device)
router.post('/invite', async (req, res) => {
  const tokenHash = req.deviceTokenHash;
  if (!tokenHash) return res.status(401).json({ error: 'Unauthorized' });

  const device = await findDevice(tokenHash);
  if (!device) return res.status(401).json({ error: 'Unauthorized' });

  const inviteToken = await createInvite(device.space_id);
  res.json({ inviteToken });
});

// Additional device pairing (using invite token)
router.post('/pair/invite', async (req, res) => {
  const { inviteToken, deviceToken } = req.body;

  if (!inviteToken || !deviceToken) {
    return res.status(400).json({ error: 'Missing inviteToken or deviceToken' });
  }

  const spaceId = await verifyAndConsumeInvite(inviteToken);
  if (!spaceId) {
    return res.status(403).json({ error: 'Invalid or expired invite token' });
  }

  const tokenHash = hashToken(deviceToken);
  await addDevice(spaceId, tokenHash);

  res.json({ status: 'paired' });
});

export default router;
