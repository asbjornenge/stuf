import React, { useState, useEffect, useRef } from 'react';
import styled from 'styled-components';
import QRCode from 'react-qr-code';
import { Html5Qrcode } from 'html5-qrcode';
import { X, LoaderCircle } from 'lucide-react';
import {
  getSyncConfig, isSyncing,
  pairWithServer, pairWithInvite, pushAllLocalChanges,
  createInvite, initSync, clearSyncConfig, teardownSync, pullSnapshot, recoverSync, getSpaceInfo, updateDeviceName, deleteDevice,
  createCheckout, createSelfHostedSpace, renewSubscription, cancelSubscription,
} from '../utils/sync';
import { getEncryptionKey, exportEncryptionKey, importEncryptionKey } from '../utils/crypto';
import { resetCRDT } from '../utils/crdt';
import { subscribeToPush } from '../utils/push';

function generateDeviceToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function QRScanner({ onScan, onError }) {
  const scannerRef = useRef(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    const id = 'qr-reader';
    const scanner = new Html5Qrcode(id);
    scannerRef.current = scanner;

    scanner.start(
      { facingMode: 'environment' },
      { fps: 5, qrbox: { width: 250, height: 250 }, aspectRatio: 1 },
      (text) => {
        if (stoppedRef.current) return;
        stoppedRef.current = true;
        try { scanner.stop().catch(() => {}); } catch (e) {}
        onScan(text);
      },
      () => {},
    ).catch((err) => {
      onError(err.message || 'Camera access denied');
    });

    return () => {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      try { scanner.stop().catch(() => {}); } catch (e) {}
    };
  }, []);

  return <ScannerContainer id="qr-reader" />;
}

export default function Sync({ onConnect, onRemoteChanges }) {
  const [view, setView] = useState('main');
  const [pairInput, setPairInput] = useState('');
  const [inviteQR, setInviteQR] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [recoverState, setRecoverState] = useState('idle');
  const [recoverProgress, setRecoverProgress] = useState(null);
  const [copyState, setCopyState] = useState('idle');
  const [synced, setSynced] = useState(isSyncing());
  const [spaceInfo, setSpaceInfo] = useState(null);
  const [pushStatus, setPushStatus] = useState(() => {
    if (typeof Notification === 'undefined' || !('PushManager' in window)) return 'unsupported';
    return Notification.permission;
  });

  useEffect(() => {
    if (synced && view === 'main') {
      getSpaceInfo().then(setSpaceInfo).catch(e => console.warn('space-info:', e));
    }
  }, [synced, view]);

  // Handle checkout return
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'cancel') {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handlePurchase = async () => {
    try {
      setError('');
      const { sessionUrl } = await createCheckout();
      window.location.href = sessionUrl;
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRenew = async () => {
    try {
      setError('');
      const { sessionUrl } = await renewSubscription();
      window.location.href = sessionUrl;
    } catch (err) {
      setError(err.message);
    }
  };

  // Self-host: create space on custom server
  const handleSelfHost = async (url) => {
    try {
      setError('');
      setLoading(true);
      const { serverUrl, pairingToken } = await createSelfHostedSpace(url);
      const deviceToken = generateDeviceToken();
      await getEncryptionKey();
      await pairWithServer(serverUrl, pairingToken, deviceToken);
      await pushAllLocalChanges();
      await initSync(onRemoteChanges);
      setSynced(true);
      setView('paired');
    } catch (err) {
      if (err.message === 'standalone_space_exists') {
        setError('This server is in standalone mode and already has a space. Use "Join via Invite" from an existing device.');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePairWithInvite = async (input) => {
    try {
      setError('');
      const parsed = JSON.parse(input);
      const { url, encryptionKey, inviteToken } = parsed;
      if (!url || !encryptionKey || !inviteToken) throw new Error('Invalid invite data');

      const ok = window.confirm(
        'Joining via invite will replace all local data with data from the server. Continue?'
      );
      if (!ok) return;

      await importEncryptionKey(encryptionKey);
      const deviceToken = generateDeviceToken();
      await pairWithInvite(url, inviteToken, deviceToken);
      await resetCRDT();
      await pullSnapshot();
      await initSync(onRemoteChanges);
      setSynced(true);
      setView('paired');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCreateInvite = async () => {
    try {
      setError('');
      const inviteToken = await createInvite();
      const encryptionKey = await exportEncryptionKey();
      const config = getSyncConfig();
      const data = JSON.stringify({
        url: config.serverUrl,
        encryptionKey,
        inviteToken,
      });
      setInviteQR(data);
      setView('invite-show');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDisconnect = () => {
    const isPaid = spaceInfo?.subscription;
    const msg = isPaid
      ? 'You have an active subscription. Disconnecting will remove this device from the space but your subscription will continue. You can manage it from your Stripe receipt email.\n\nDisconnect?'
      : 'Disconnect from sync server?';
    if (!window.confirm(msg)) return;
    teardownSync();
    clearSyncConfig();
    setSynced(false);
    setSpaceInfo(null);
  };

  const handleEnableNotifications = async () => {
    try {
      await subscribeToPush();
      setPushStatus(Notification.permission);
    } catch (e) {
      console.warn('Push subscribe failed:', e);
      setPushStatus(Notification.permission);
    }
  };

  // --- Views ---

  if (view === 'paired') {
    return (
      <Container>
        <Status>Connected</Status>
        <Subtitle>Sync is set up and running</Subtitle>
        {pushStatus === 'default' && (
          <Actions>
            <ActionButton onClick={handleEnableNotifications}>Enable Notifications</ActionButton>
            <ActionButtonSecondary onClick={() => onConnect?.()}>Skip</ActionButtonSecondary>
          </Actions>
        )}
        {pushStatus === 'granted' && (
          <Actions>
            <NotificationStatus>Notifications enabled</NotificationStatus>
            <ActionButton onClick={() => onConnect?.()}>Done</ActionButton>
          </Actions>
        )}
        {(pushStatus === 'denied' || pushStatus === 'unsupported') && (
          <Actions>
            <ActionButton onClick={() => onConnect?.()}>Done</ActionButton>
          </Actions>
        )}
      </Container>
    );
  }

  if (synced && view === 'main') {
    const config = getSyncConfig();
    return (
      <Container>
        <Status>Syncing</Status>
        <ServerUrl>{config?.serverUrl}</ServerUrl>
        {spaceInfo && (
          <SpaceInfoSection>
            {spaceInfo.subscription && (
              <>
                <SpaceInfoLabel>Subscription</SpaceInfoLabel>
                <SubscriptionBadge status={spaceInfo.subscription.status}>
                  {spaceInfo.subscription.cancelAtPeriodEnd
                    ? `cancels ${new Date(spaceInfo.subscription.currentPeriodEnd).toLocaleDateString()}`
                    : `${spaceInfo.subscription.status} until ${new Date(spaceInfo.subscription.currentPeriodEnd).toLocaleDateString()}`
                  }
                </SubscriptionBadge>
              </>
            )}
            <SpaceInfoLabel>Space</SpaceInfoLabel>
            <SpaceInfoValue>{spaceInfo.spaceId}</SpaceInfoValue>
            <SpaceInfoLabel>Format</SpaceInfoLabel>
            <SpaceInfoValue>v{spaceInfo.formatVersion || '?'}</SpaceInfoValue>
            <SpaceInfoLabel>Devices</SpaceInfoLabel>
            {spaceInfo.devices.map((d, i) => (
              <DeviceRow key={d.id}>
                {d.id === spaceInfo.currentDeviceId ? (
                  <>
                    <DeviceNameInput
                      defaultValue={d.name || ''}
                      placeholder={`Device ${i + 1}`}
                      onBlur={async (e) => {
                        const val = e.target.value.trim();
                        if (val && val !== d.name) {
                          await updateDeviceName(val);
                          setSpaceInfo(prev => ({
                            ...prev,
                            devices: prev.devices.map(dd => dd.id === d.id ? { ...dd, name: val } : dd),
                          }));
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                    />
                    <DeviceBadge>this device</DeviceBadge>
                  </>
                ) : (
                  <>
                    <DeviceName>{d.name || `Device ${i + 1}`}</DeviceName>
                    <DeleteDeviceButton onClick={async () => {
                      if (!window.confirm(`Remove "${d.name || `Device ${i + 1}`}"?`)) return;
                      try {
                        await deleteDevice(d.id);
                        setSpaceInfo(prev => ({
                          ...prev,
                          devices: prev.devices.filter(dd => dd.id !== d.id),
                        }));
                      } catch (err) { setError(err.message); }
                    }}><X size="0.875rem" /></DeleteDeviceButton>
                  </>
                )}
              </DeviceRow>
            ))}
          </SpaceInfoSection>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        <Actions>
          {pushStatus === 'default' && (
            <ActionButton onClick={handleEnableNotifications}>Enable Notifications</ActionButton>
          )}
          {pushStatus === 'granted' && (
            <NotificationStatus>Notifications enabled</NotificationStatus>
          )}
          {pushStatus === 'denied' && (
            <NotificationStatus style={{ color: '#ff453a' }}>Notifications blocked (change in system settings)</NotificationStatus>
          )}
          <ActionButton onClick={handleCreateInvite}>Add Device</ActionButton>
          {spaceInfo?.subscription && (spaceInfo.subscription.status !== 'active' ||
            (spaceInfo.subscription.currentPeriodEnd && spaceInfo.subscription.currentPeriodEnd - Date.now() < 60 * 86400000)) && (
            <ActionButton onClick={handleRenew}>Renew Subscription</ActionButton>
          )}
          {spaceInfo?.subscription && spaceInfo.subscription.status === 'active' && !spaceInfo.subscription.cancelAtPeriodEnd && (
            <ActionButtonSecondary onClick={async () => {
              if (!window.confirm('Cancel subscription? Sync will remain active until the current period ends.')) return;
              try {
                await cancelSubscription();
                const info = await getSpaceInfo();
                setSpaceInfo(info);
              } catch (err) { setError(err.message); }
            }}>Cancel Subscription</ActionButtonSecondary>
          )}
          <ActionButtonSecondary disabled={recoverState === 'loading'} onClick={async () => {
            if (!window.confirm('Recover Sync re-uploads this device\'s entire local history and re-pulls everything from the server. Use if devices are out of sync. This may take up to a minute. Continue?')) return;
            setRecoverState('loading');
            setRecoverProgress(null);
            try {
              const total = await recoverSync((done, all) => {
                setRecoverProgress({ done, total: all });
              });
              onRemoteChanges?.();
              setRecoverState('done');
              setRecoverProgress({ done: total, total });
              setTimeout(() => { setRecoverState('idle'); setRecoverProgress(null); }, 3000);
            } catch (err) {
              setError(err.message);
              setRecoverState('idle');
              setRecoverProgress(null);
            }
          }}>
            {recoverState === 'loading' && <Spinner><LoaderCircle size="1rem" /></Spinner>}
            {recoverState === 'loading'
              ? (recoverProgress ? `Recovering ${recoverProgress.done}/${recoverProgress.total}...` : 'Recovering...')
              : recoverState === 'done' ? 'Done!' : 'Recover Sync'}
          </ActionButtonSecondary>
          <DisconnectButton onClick={handleDisconnect}>Disconnect</DisconnectButton>
        </Actions>
      </Container>
    );
  }

  if (view === 'invite-show') {
    return (
      <Container>
        <Subtitle>Scan this from the new device</Subtitle>
        {inviteQR && (
          <QRContainer>
            <QRCode value={inviteQR} size={280} bgColor="#ffffff" fgColor="#000000" />
          </QRContainer>
        )}
        <ManualCode>{inviteQR}</ManualCode>
        <Actions>
          <ActionButton disabled={copyState === 'loading'} onClick={async () => {
            setCopyState('loading');
            try {
              await navigator.clipboard.writeText(inviteQR);
              setCopyState('done');
              setTimeout(() => setCopyState('idle'), 2000);
            } catch (err) {
              setCopyState('error');
              setTimeout(() => setCopyState('idle'), 2000);
            }
          }}>
            {copyState === 'loading' && <Spinner><LoaderCircle size="1rem" /></Spinner>}
            {copyState === 'loading' ? 'Copying...' : copyState === 'done' ? 'Copied!' : copyState === 'error' ? 'Failed to copy' : 'Copy'}
          </ActionButton>
          <ActionButtonSecondary onClick={() => setView('main')}>Done</ActionButtonSecondary>
        </Actions>
      </Container>
    );
  }

  // QR scanner views (invite only)
  if (view === 'invite-scan') {
    return (
      <Container>
        <Subtitle>Scan invite QR code</Subtitle>
        <QRScanner
          onScan={(text) => handlePairWithInvite(text)}
          onError={(msg) => setError(msg)}
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Actions>
          <ActionButtonSecondary onClick={() => { setError(''); setView('invite-manual'); }}>
            Paste manually
          </ActionButtonSecondary>
          <ActionButtonSecondary onClick={() => { setView('main'); setError(''); }}>
            Cancel
          </ActionButtonSecondary>
        </Actions>
      </Container>
    );
  }

  // Manual paste views (invite only)
  if (view === 'invite-manual') {
    return (
      <Container>
        <Subtitle>Paste invite QR data</Subtitle>
        <Input
          value={pairInput}
          onChange={(e) => setPairInput(e.target.value)}
          placeholder='Paste invite data...'
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Actions>
          <ActionButton onClick={() => handlePairWithInvite(pairInput)}>
            Connect
          </ActionButton>
          <ActionButtonSecondary onClick={() => { setError(''); setView('invite-scan'); }}>
            Scan QR code
          </ActionButtonSecondary>
          <ActionButtonSecondary onClick={() => { setView('main'); setError(''); }}>
            Cancel
          </ActionButtonSecondary>
        </Actions>
      </Container>
    );
  }

  // Self-host: enter server URL
  if (view === 'self-host') {
    return (
      <Container>
        <Subtitle>Enter your sync server URL</Subtitle>
        <UrlInput
          value={pairInput}
          onChange={(e) => setPairInput(e.target.value)}
          placeholder='https://sync.example.com'
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Actions>
          <ActionButton disabled={loading} onClick={() => handleSelfHost(pairInput)}>
            {loading && <Spinner><LoaderCircle size="1rem" /></Spinner>}
            {loading ? 'Connecting...' : 'Connect'}
          </ActionButton>
          <ActionButtonSecondary onClick={() => { setView('main'); setError(''); setPairInput(''); }}>
            Back
          </ActionButtonSecondary>
        </Actions>
      </Container>
    );
  }

  // Main view (not synced) — the new choice screen
  return (
    <Container>
      <Subtitle>Sync your stꝋf across devices with end-to-end encryption</Subtitle>
      {error && <ErrorText>{error}</ErrorText>}
      <Actions>
        <ActionButton onClick={handlePurchase}>
          Purchase Sync & Backup
        </ActionButton>
        <Divider><DividerLine /><DividerText>or</DividerText><DividerLine /></Divider>
        <ActionButtonSecondary onClick={() => setView('self-host')}>
          Self-host Sync Server
        </ActionButtonSecondary>
        <ActionButtonSecondary onClick={() => setView('invite-scan')}>
          Join via Invite
        </ActionButtonSecondary>
      </Actions>
    </Container>
  );
}

const Container = styled.div`
  padding: 1rem 1.25rem;
`;

const Status = styled.div`
  color: #4cd964;
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
`;

const ServerUrl = styled.div`
  color: #666;
  font-size: 0.8125rem;
  margin-bottom: 0.75rem;
`;

const SpaceInfoSection = styled.div`
  margin-bottom: 1.25rem;
`;

const SpaceInfoLabel = styled.div`
  color: #666;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.03rem;
  margin-top: 0.75rem;
  margin-bottom: 0.25rem;
`;

const SpaceInfoValue = styled.div`
  color: #999;
  font-size: 0.75rem;
  font-family: monospace;
  word-break: break-all;
`;

const SubscriptionBadge = styled.div`
  display: inline-block;
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
  color: ${p => p.status === 'active' ? '#4cd964' : p.status === 'past_due' ? '#f0ad4e' : '#ff453a'};
  background: ${p => p.status === 'active' ? 'rgba(76,217,100,0.1)' : p.status === 'past_due' ? 'rgba(240,173,78,0.1)' : 'rgba(255,69,58,0.1)'};
`;

const SubscriptionDetail = styled.div`
  color: #666;
  font-size: 0.75rem;
  margin-top: 0.25rem;
`;

const DeviceRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
`;

const DeviceName = styled.div`
  color: #ccc;
  font-size: 0.8125rem;
`;

const DeviceNameInput = styled.input`
  background: transparent;
  border: none;
  border-bottom: 1px solid #444;
  color: #fff;
  font-size: 0.8125rem;
  padding: 0.125rem 0;
  outline: none;
  width: 8rem;

  &::placeholder {
    color: #666;
  }

  &:focus {
    border-bottom-color: #4cd964;
  }
`;

const DeviceBadge = styled.span`
  color: #4cd964;
  font-size: 0.6875rem;
  background: rgba(76, 217, 100, 0.1);
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
`;

const DeleteDeviceButton = styled.button`
  background: none;
  border: none;
  color: #666;
  font-size: 0.75rem;
  cursor: pointer;
  padding: 0.125rem 0.25rem;
  margin-left: auto;
  &:hover { color: #ff453a; }
`;

const NotificationStatus = styled.div`
  color: #4cd964;
  font-size: 0.875rem;
  text-align: center;
  padding: 0.5rem;
`;

const Subtitle = styled.div`
  color: #888;
  font-size: 0.875rem;
  margin-bottom: 1.25rem;
`;

const QRContainer = styled.div`
  margin: 0 auto 1rem;
  display: flex;
  justify-content: center;
  width: fit-content;
  margin-left: auto;
  margin-right: auto;
  background: #ffffff;
  padding: 1rem;
`;

const ManualCode = styled.div`
  color: #555;
  font-size: 0.625rem;
  word-break: break-all;
  margin-bottom: 1.25rem;
`;

const ScannerContainer = styled.div`
  width: 100%;
  margin-bottom: 1rem;
  border-radius: 0.5rem;
  overflow: hidden;

  & video {
    border-radius: 0.5rem;
  }
`;

const Input = styled.textarea`
  width: 100%;
  background: #2a2a2c;
  border: 1px solid #444;
  border-radius: 0.5rem;
  color: white;
  font-size: 0.8125rem;
  padding: 0.625rem;
  resize: vertical;
  min-height: 3.75rem;
  margin-bottom: 0.75rem;
  outline: none;
  font-family: monospace;

  &::placeholder {
    color: #666;
  }
`;

const UrlInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  background: #2a2a2c;
  border: 1px solid #444;
  border-radius: 0.5rem;
  color: white;
  font-size: 0.8125rem;
  padding: 0.625rem;
  margin-bottom: 0.75rem;
  outline: none;

  &::placeholder {
    color: #666;
  }
`;

const ErrorText = styled.div`
  color: #ff453a;
  font-size: 0.8125rem;
  margin-bottom: 0.75rem;
`;

const Actions = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const ActionButton = styled.button`
  background: linear-gradient(135deg, #E85D24, #F5C030);
  border: none;
  color: white;
  font-size: 0.9375rem;
  font-weight: 500;
  padding: 0.75rem;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  cursor: pointer;

  &:hover {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const ActionButtonSecondary = styled(ActionButton)`
  background: #3a3a3c;
`;

const DisconnectButton = styled.button`
  background: none;
  border: none;
  color: #ff453a;
  font-size: 0.8125rem;
  padding: 0.75rem;
  cursor: pointer;
  margin-top: 0.5rem;

  &:hover {
    opacity: 0.8;
  }
`;

const Divider = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.25rem 0;
`;

const DividerLine = styled.div`
  flex: 1;
  height: 1px;
  background: #3a3a3c;
`;

const DividerText = styled.span`
  color: #666;
  font-size: 0.75rem;
`;

const Spinner = styled.span`
  display: inline-flex;
  position: absolute;
  left: 0.75rem;
  @keyframes spin { to { transform: rotate(360deg); } }
  animation: spin 1s linear infinite;
`;
