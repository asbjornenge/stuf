import { webcrypto } from 'crypto';

const crypto = webcrypto;

let encryptionKey = null;

export async function setEncryptionKey(base64Key) {
  const raw = Buffer.from(base64Key, 'base64');
  encryptionKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(data) {
  if (!encryptionKey) throw new Error('Encryption key not set');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString('base64');
}

export async function decrypt(base64Data) {
  if (!encryptionKey) throw new Error('Encryption key not set');
  const combined = Buffer.from(base64Data, 'base64');
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encryptionKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}
