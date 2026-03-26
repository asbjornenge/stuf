import * as Sentry from '@sentry/node';
import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import webpush from 'web-push';
import {
  initDB, getMode, getDefaultSpaceId,
  getServerConfig, setServerConfig,
  initPairing, getConfig, getDeviceCount, getDevicesForSpace, getSpace, hashToken, findDevice, updateDeviceName, deleteDevice,
  setSpaceSubscription, setSubscriptionStatus,
  upsertSharedNote, getSharedNote,
} from './db.js';
import { BODY_LIMIT } from './config.js';
import { setupWebSocket } from './ws.js';
import pairRoutes from './routes/pair.js';
import changesRoutes from './routes/changes.js';
import pushRoutes from './routes/push.js';
import spacesRoutes from './routes/spaces.js';
import webhookRoutes from './routes/webhook.js';
import { createCheckoutSession, verifyCheckoutSession, getSubscriptionDetails, cancelSubscription } from './payments.js';
import { PAYMENTS_ENABLED } from './config.js';
import { startScheduler } from './scheduler.js';
import { marked } from 'marked';

import { PORT, BASE_PATH, SENTRY_DSN } from './config.js';

if (SENTRY_DSN) {
  Sentry.init({ dsn: SENTRY_DSN });
  console.log('Sentry initialized');
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  await initDB();

  const app = express();
  const server = createServer(app);

  app.set('trust proxy', true);
  // Stripe webhook needs raw body — must be before express.json()
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), webhookRoutes);

  app.use(express.json({ limit: BODY_LIMIT }));

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Extract device token hash for all /api routes
  app.use('/api', (req, res, next) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      req.deviceTokenHash = hashToken(auth.slice(7));
    }
    next();
  });

  // Initialize VAPID keys (server-level, not space-scoped)
  let vapidPublicKey = await getServerConfig('vapid_public_key');
  let vapidPrivateKey = await getServerConfig('vapid_private_key');

  if (!vapidPublicKey || !vapidPrivateKey) {
    const keys = webpush.generateVAPIDKeys();
    vapidPublicKey = keys.publicKey;
    vapidPrivateKey = keys.privateKey;
    await setServerConfig('vapid_public_key', vapidPublicKey);
    await setServerConfig('vapid_private_key', vapidPrivateKey);
    console.log('Generated new VAPID keys');
  }

  // Space info (authenticated)
  app.get('/api/space-info', async (req, res) => {
    const tokenHash = req.deviceTokenHash;
    if (!tokenHash) return res.status(401).json({ error: 'Missing authorization' });
    const device = await findDevice(tokenHash);
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    const devices = await getDevicesForSpace(device.space_id);
    const space = await getSpace(device.space_id);
    let subscription = null;
    if (space?.stripe_subscription_id) {
      subscription = await getSubscriptionDetails(space.stripe_subscription_id);
      if (subscription) subscription.status = space.subscription_status;
    }
    res.json({
      spaceId: device.space_id,
      currentDeviceId: device.id,
      devices: devices.map(d => ({ id: d.id, name: d.name, createdAt: d.created_at })),
      subscription,
    });
  });

  // Update device name
  app.put('/api/device/name', async (req, res) => {
    const tokenHash = req.deviceTokenHash;
    if (!tokenHash) return res.status(401).json({ error: 'Missing authorization' });
    const device = await findDevice(tokenHash);
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing name' });
    await updateDeviceName(device.id, name.trim().slice(0, 50));
    res.json({ ok: true });
  });

  // Delete a device (cannot delete yourself)
  app.delete('/api/device/:deviceId', async (req, res) => {
    const tokenHash = req.deviceTokenHash;
    if (!tokenHash) return res.status(401).json({ error: 'Missing authorization' });
    const device = await findDevice(tokenHash);
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    const targetId = parseInt(req.params.deviceId);
    if (targetId === device.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    const devices = await getDevicesForSpace(device.space_id);
    if (!devices.some(d => d.id === targetId)) return res.status(404).json({ error: 'Device not found' });
    await deleteDevice(targetId);
    res.json({ ok: true });
  });

  // Renew subscription — create checkout for existing space
  app.post('/api/renew', async (req, res) => {
    if (!PAYMENTS_ENABLED) return res.status(403).json({ error: 'Payments not enabled' });
    const tokenHash = req.deviceTokenHash;
    if (!tokenHash) return res.status(401).json({ error: 'Missing authorization' });
    const device = await findDevice(tokenHash);
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    try {
      const { successUrl, cancelUrl } = req.body;
      const session = await createCheckoutSession(successUrl, cancelUrl);
      res.json({ sessionUrl: session.url, sessionId: session.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Complete renewal — attach new subscription to existing space
  app.post('/api/renew/complete', async (req, res) => {
    if (!PAYMENTS_ENABLED) return res.status(403).json({ error: 'Payments not enabled' });
    const tokenHash = req.deviceTokenHash;
    if (!tokenHash) return res.status(401).json({ error: 'Missing authorization' });
    const device = await findDevice(tokenHash);
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    try {
      const { sessionId } = req.body;
      const stripeInfo = await verifyCheckoutSession(sessionId);
      if (!stripeInfo) return res.status(402).json({ error: 'Payment not completed' });
      await setSpaceSubscription(device.space_id, stripeInfo.customerId, stripeInfo.subscriptionId);
      await setSubscriptionStatus(device.space_id, 'active');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cancel subscription (at period end)
  app.post('/api/subscription/cancel', async (req, res) => {
    if (!PAYMENTS_ENABLED) return res.status(403).json({ error: 'Payments not enabled' });
    const tokenHash = req.deviceTokenHash;
    if (!tokenHash) return res.status(401).json({ error: 'Missing authorization' });
    const device = await findDevice(tokenHash);
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    const space = await getSpace(device.space_id);
    if (!space?.stripe_subscription_id) return res.status(400).json({ error: 'No subscription' });
    try {
      await cancelSubscription(space.stripe_subscription_id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Routes
  app.use('/api/spaces', spacesRoutes);
  app.use('/api', pairRoutes);
  app.use('/api/changes', changesRoutes);
  app.use('/api/push', pushRoutes);

  // Share notes
  const markdownCSS = `
.markdown-body {
  max-width: 48rem; margin: 0 auto; padding: 0 1.5rem 2rem;
  color: #ccc; font-size: 0.875rem; line-height: 1.6; font-family: 'Noto Sans', Inter, system-ui, sans-serif;
}
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 { color: white; margin-top: 1em; margin-bottom: 0.5em; }
.markdown-body h1 { font-size: 1.6em; }
.markdown-body h2 { font-size: 1.4em; }
.markdown-body h3 { font-size: 1.2em; }
.markdown-body p { margin-bottom: 0.8em; }
.markdown-body ul, .markdown-body ol { margin-bottom: 0.8em; padding-left: 1.5em; }
.markdown-body li { margin-bottom: 0.3em; }
.markdown-body code { background: #333; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-family: monospace; }
.markdown-body pre { background: #333; padding: 0.75rem; border-radius: 0.5rem; overflow-x: auto; margin-bottom: 0.8em; }
.markdown-body pre code { background: none; padding: 0; }
.markdown-body blockquote { border-left: 3px solid #555; padding-left: 0.75rem; color: #999; margin-bottom: 0.8em; }
.markdown-body a { color: #00D8FF; }
.markdown-body hr { border: none; border-top: 1px solid #444; margin: 1em 0; }
`;

  app.post('/api/share', async (req, res) => {
    if (!req.deviceTokenHash) return res.status(401).json({ error: 'unauthorized' });
    const device = await findDevice(req.deviceTokenHash);
    if (!device) return res.status(401).json({ error: 'unauthorized' });
    const { content, shareId } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const id = await upsertSharedNote(shareId || null, content);
    res.json({ id, url: `${req.protocol}://${req.get('host')}/shared/${id}` });
  });

  app.get('/shared/:id', async (req, res) => {
    const note = await getSharedNote(req.params.id);
    if (!note) return res.status(404).send('Not found');
    const html = marked(note.content);
    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared Note — stꝋf</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>${markdownCSS}
body { background: #1c1c1e; margin: 0; font-family: 'Noto Sans', Inter, system-ui, sans-serif; }
.header { display: flex; align-items: center; justify-content: space-between; padding: 0.875rem 1.5rem; }
.logo { display: flex; align-items: center; gap: 0.5rem; color: #fff; font-size: 1.25rem; font-weight: 700; text-decoration: none; }
.logo svg { height: 1.75rem; width: auto; }
.open-app { background: linear-gradient(135deg, #E85D24, #F5C030); color: white; padding: 0.5rem 1.25rem; border-radius: 2rem; font-size: 0.875rem; font-weight: 600; text-decoration: none; }
.open-app:hover { opacity: 0.9; }
</style>
</head><body>
<div class="header">
  <a href="https://stufapp.net" class="logo">
    <svg width="120" height="200" viewBox="0 0 120 200" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gC" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E85D24"/><stop offset="70%" stop-color="#EF7A30"/><stop offset="100%" stop-color="#F5C030"/></linearGradient><mask id="rune"><line x1="60" y1="10" x2="60" y2="190" stroke="white" stroke-width="20" stroke-linecap="round"/><line x1="22" y1="100" x2="60" y2="124" stroke="white" stroke-width="17" stroke-linecap="round"/><line x1="60" y1="124" x2="100" y2="76" stroke="white" stroke-width="17" stroke-linecap="round"/></mask></defs><rect x="0" y="0" width="120" height="200" fill="url(#gC)" mask="url(#rune)"/></svg>
    stꝋf
  </a>
  <a href="https://app.stufapp.net" class="open-app">Open App</a>
</div>
<div class="markdown-body">${html}</div>
</body></html>`);
  });

  // Pairing page for a specific space (multi mode)
  app.get('/s/:spaceId', async (req, res) => {
    const space = await getSpace(req.params.spaceId);
    if (!space) return res.status(404).send('Space not found');
    if (!space.active) return res.status(403).send('Space is inactive');
    const deviceCount = await getDeviceCount(space.id);
    res.send(infoPage(`Space active — ${deviceCount} device${deviceCount !== 1 ? 's' : ''} connected`));
  });

  // Landing page
  app.get('/', async (req, res) => {
    if (getMode() === 'standalone') {
      const deviceCount = await getDeviceCount(getDefaultSpaceId());
      res.send(infoPage(`Standalone mode — ${deviceCount} device${deviceCount !== 1 ? 's' : ''} connected`));
    } else {
      res.send(infoPage('Multi-tenant sync server'));
    }
  });

  // Sentry error handler (must be after routes, before other error handlers)
  if (SENTRY_DSN) {
    app.use(Sentry.Handlers.errorHandler());
  }

  // WebSocket
  setupWebSocket(server);

  server.listen(PORT, () => {
    console.log(`stꝋf-server running on port ${PORT} (${getMode()} mode)`);
    startScheduler();
  });
}

function infoPage(subtitle) {
  return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>stꝋf sync</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, sans-serif; background: #1c1c1e; color: #f5f5f7;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { text-align: center; padding: 3rem 2rem; }
    .logo { width: 3rem; height: 5rem; margin-bottom: 1.5rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; }
    .subtitle { color: #98989d; font-size: 0.875rem; margin-bottom: 2rem; }
    .links { display: flex; gap: 1.5rem; justify-content: center; }
    .links a { color: #98989d; font-size: 0.8125rem; text-decoration: none; transition: color 0.2s; }
    .links a:hover { color: #f5f5f7; }
  </style>
</head><body>
  <div class="card">
    <img src="data:image/svg+xml,%3Csvg width='120' height='200' viewBox='0 0 120 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23E85D24'/%3E%3Cstop offset='70%25' stop-color='%23EF7A30'/%3E%3Cstop offset='100%25' stop-color='%23F5C030'/%3E%3C/linearGradient%3E%3Cmask id='r'%3E%3Cline x1='60' y1='10' x2='60' y2='190' stroke='white' stroke-width='20' stroke-linecap='round'/%3E%3Cline x1='22' y1='100' x2='60' y2='124' stroke='white' stroke-width='17' stroke-linecap='round'/%3E%3Cline x1='60' y1='124' x2='100' y2='76' stroke='white' stroke-width='17' stroke-linecap='round'/%3E%3C/mask%3E%3C/defs%3E%3Crect x='0' y='0' width='120' height='200' fill='url(%23g)' mask='url(%23r)'/%3E%3C/svg%3E" class="logo" alt="stꝋf" />
    <h1>stꝋf sync</h1>
    <div class="subtitle">${subtitle}</div>
    <div class="links">
      <a href="https://stufapp.net">stufapp.net</a>
      <a href="https://github.com/asbjornenge/stuf">GitHub</a>
    </div>
  </div>
</body></html>`;
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
