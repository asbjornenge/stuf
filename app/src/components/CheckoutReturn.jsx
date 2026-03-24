import { useEffect } from 'react';
import { isSyncing, purchaseSpace, pairWithServer, pushAllLocalChanges, initSync, completeRenewal } from '../utils/sync';
import { getEncryptionKey } from '../utils/crypto';

function generateDeviceToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function CheckoutReturn({ onComplete }) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState({}, '', window.location.pathname);

    const checkout = params.get('checkout');
    const renew = params.get('renew');
    const sessionId = params.get('session_id');

    if (checkout === 'success' && sessionId && !isSyncing()) {
      (async () => {
        try {
          const { serverUrl, pairingToken } = await purchaseSpace(sessionId);
          const deviceToken = generateDeviceToken();
          await getEncryptionKey();
          await pairWithServer(serverUrl, pairingToken, deviceToken);
          await pushAllLocalChanges();
          await initSync();
          onComplete?.({ type: 'purchase' });
        } catch (err) {
          console.error('Checkout completion failed:', err);
          onComplete?.({ type: 'purchase', error: err });
        }
      })();
    } else if (renew === 'success' && sessionId) {
      (async () => {
        try {
          await completeRenewal(sessionId);
          onComplete?.({ type: 'renew' });
        } catch (err) {
          console.error('Renewal completion failed:', err);
          onComplete?.({ type: 'renew', error: err });
        }
      })();
    }
  }, []);

  return null;
}
