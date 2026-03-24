import { Router } from 'express';
import { getMode, getDefaultSpaceId, getDeviceCount, createSpace, getSpace, initPairing, setSpaceSubscription } from '../db.js';
import { createCheckoutSession, verifyCheckoutSession } from '../payments.js';

import { PAYMENTS_ENABLED } from '../config.js';

const router = Router();

// Create a Stripe checkout session
router.post('/checkout', async (req, res) => {
  if (!PAYMENTS_ENABLED) {
    return res.status(403).json({ error: 'Payments not enabled' });
  }
  try {
    const { successUrl, cancelUrl } = req.body;
    if (!successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'Missing successUrl or cancelUrl' });
    }
    const session = await createCheckoutSession(successUrl, cancelUrl);
    res.json({ sessionUrl: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create space after successful payment
router.post('/', async (req, res) => {
  // Standalone: use default space, but only if no devices yet
  if (getMode() === 'standalone') {
    const spaceId = getDefaultSpaceId();
    const count = await getDeviceCount(spaceId);
    if (count > 0) {
      return res.status(409).json({ error: 'standalone_space_exists' });
    }
    const pairingToken = await initPairing(spaceId);
    return res.json({ spaceId, pairingToken });
  }

  let stripeInfo = null;
  if (PAYMENTS_ENABLED) {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(402).json({ error: 'Payment required' });
    }
    try {
      stripeInfo = await verifyCheckoutSession(sessionId);
      if (!stripeInfo) {
        return res.status(402).json({ error: 'Payment not completed' });
      }
    } catch (err) {
      return res.status(402).json({ error: 'Payment verification failed' });
    }
  }

  const { name } = req.body || {};
  const spaceId = await createSpace(name);

  if (stripeInfo) {
    await setSpaceSubscription(spaceId, stripeInfo.customerId, stripeInfo.subscriptionId);
  }

  const pairingToken = await initPairing(spaceId);
  res.json({ spaceId, pairingToken });
});

router.get('/:spaceId', async (req, res) => {
  const space = await getSpace(req.params.spaceId);
  if (!space) {
    return res.status(404).json({ error: 'Space not found' });
  }
  if (!space.active) {
    return res.status(403).json({ error: 'Space is inactive' });
  }
  res.json({ id: space.id, name: space.name, active: space.active });
});

export default router;
