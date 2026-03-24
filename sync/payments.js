import Stripe from 'stripe';
import { STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET } from './config.js';

let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = new Stripe(STRIPE_SECRET_KEY);
}

export async function createCheckoutSession(successUrl, cancelUrl) {
  if (!stripe) throw new Error('Payments not configured');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session;
}

export async function verifyCheckoutSession(sessionId) {
  if (!stripe) throw new Error('Payments not configured');
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') return null;
  return { customerId: session.customer, subscriptionId: session.subscription };
}

export function constructWebhookEvent(body, signature) {
  if (!stripe) throw new Error('Payments not configured');
  return stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET);
}

export async function getSubscriptionDetails(subscriptionId) {
  if (!stripe || !subscriptionId) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
    return {
      currentPeriodEnd: periodEnd ? periodEnd * 1000 : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  } catch { return null; }
}

export async function cancelSubscription(subscriptionId) {
  if (!stripe) throw new Error('Payments not configured');
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}
