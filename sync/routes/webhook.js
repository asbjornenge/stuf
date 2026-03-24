import { Router } from 'express';
import { getSpaceBySubscription, setSubscriptionStatus } from '../db.js';
import { constructWebhookEvent } from '../payments.js';

const router = Router();

router.post('/', async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.warn('Webhook signature verification failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  const subscription = event.data.object;
  const subscriptionId = subscription.id || subscription.subscription;

  if (!subscriptionId) return res.json({ received: true });

  const space = await getSpaceBySubscription(subscriptionId);
  if (!space) return res.json({ received: true });

  switch (event.type) {
    case 'invoice.paid':
      await setSubscriptionStatus(space.id, 'active');
      break;
    case 'invoice.payment_failed':
      await setSubscriptionStatus(space.id, 'past_due');
      break;
    case 'customer.subscription.deleted':
      await setSubscriptionStatus(space.id, 'canceled');
      break;
  }

  res.json({ received: true });
});

export default router;
