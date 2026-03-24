import { getSyncConfig } from './sync.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function apiFetch(path, options = {}) {
  const config = getSyncConfig();
  if (!config) return null;

  const res = await fetch(`${config.serverUrl}/api/push${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.deviceToken}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
}

export async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push not supported');
    return null;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.warn('Notification permission denied');
    return null;
  }

  const registration = await navigator.serviceWorker.ready;

  // Get VAPID public key from server
  const { publicKey } = await apiFetch('/vapid-key');

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  // Send subscription to server
  await apiFetch('/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });

  return subscription;
}

export async function registerReminder(taskId, taskName, notifyAt) {
  return apiFetch('/reminder', {
    method: 'POST',
    body: JSON.stringify({ taskId: String(taskId), title: taskName, notifyAt }),
  });
}

export async function cancelReminder(taskId) {
  return apiFetch('/reminder', {
    method: 'DELETE',
    body: JSON.stringify({ taskId: String(taskId) }),
  });
}
