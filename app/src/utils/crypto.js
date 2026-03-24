/**
 * E2E encryption using Web Crypto API (AES-256-GCM).
 * The encryption key is generated on the client and never sent to the server.
 */

const DB_NAME = 'stuf-crypto';
const STORE_NAME = 'keys';
const KEY_ID = 'encryption-key';

// --- IndexedDB helpers for key storage ---

function openKeyDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeRawKey(rawKey) {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(rawKey, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRawKey() {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(KEY_ID);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// --- Key management ---

let _cachedKey = null;

/**
 * Get or generate the AES-256-GCM encryption key.
 * Generated once on first use, stored in IndexedDB.
 */
export async function getEncryptionKey() {
  if (_cachedKey) return _cachedKey;

  const stored = await loadRawKey();
  if (stored) {
    _cachedKey = await crypto.subtle.importKey(
      'raw', stored, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
    );
    return _cachedKey;
  }

  // Generate new key
  _cachedKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const rawKey = await crypto.subtle.exportKey('raw', _cachedKey);
  await storeRawKey(rawKey);
  return _cachedKey;
}

/**
 * Import an encryption key from a base64-encoded raw key (for device pairing).
 */
export async function importEncryptionKey(base64Key) {
  const raw = base64ToUint8(base64Key);
  _cachedKey = await crypto.subtle.importKey(
    'raw', raw.buffer, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
  );
  await storeRawKey(raw.buffer);
  return _cachedKey;
}

/**
 * Export the current encryption key as base64 (for sharing with other devices).
 */
export async function exportEncryptionKey() {
  const key = await getEncryptionKey();
  const raw = await crypto.subtle.exportKey('raw', key);
  return uint8ToBase64(new Uint8Array(raw));
}

/**
 * Check if an encryption key exists.
 */
export async function hasEncryptionKey() {
  const stored = await loadRawKey();
  return stored !== null;
}

// --- Base64 helpers (safe for large arrays) ---

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --- Encrypt / Decrypt ---

/**
 * Encrypt an Automerge change (Uint8Array or Array) → base64 string.
 * Format: base64(IV[12] + ciphertext)
 */
export async function encryptChange(change) {
  const key = await getEncryptionKey();
  const data = change instanceof Uint8Array ? change : new Uint8Array(change);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return uint8ToBase64(combined);
}

/**
 * Decrypt a base64 string → Array (for Automerge consumption).
 */
export async function decryptChange(base64) {
  const key = await getEncryptionKey();
  const combined = base64ToUint8(base64);

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return Array.from(new Uint8Array(decrypted));
}
