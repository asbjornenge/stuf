import SimplePeer from 'simple-peer/simplepeer.min.js'
import { encryptData, decryptData } from './encryption';
import { getLocalChanges, applyRemoteChanges } from './crdt';

let peer;

export const initWebRTC = (isInitiator, onChangesCallback, onSignalCallback) => {
  peer = new SimplePeer({ initiator: isInitiator, trickle: false });

  peer.on('signal', (data) => {
    console.log('Signal Data:', JSON.stringify(data));
    onSignalCallback(data);
    // Exchange this signal data manually or through a signaling server.
  });

  peer.on('connect', () => console.log('Connected to peer'));

  peer.on('data', async (data) => {
    const decrypted = decryptData(data.toString());
    const changes = JSON.parse(decrypted);
    await applyRemoteChanges(changes);
    onChangesCallback(changes);
  });
};

export const sendChanges = (changes) => {
  if (peer && peer.connected) {
    const encrypted = encryptData(JSON.stringify(changes));
    peer.send(encrypted);
  }
};

export const receiveSignal = (data) => {
  if (peer) {
    peer.signal(data);
  }
};
