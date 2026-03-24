import React from 'react';
import styled from 'styled-components';
import { ChevronLeft, Settings as SettingsIcon, Mail } from 'lucide-react';
import { updateSettings, saveDocumentSnapshot, loadDocumentSnapshot, resetCRDT } from '../utils/crdt';
import { isSyncing, clearSyncConfig, teardownSync } from '../utils/sync';

export default function Settings({
  settings,
  setSettings,
  refreshFromDoc,
  showToast,
  onBack,
  onOpenSync,
  onOpenBackup,
  onOpenSupport,
  view,  // 'settings' | 'sync-back' | 'backup' | 'support'
}) {
  if (view === 'support') {
    return (
      <Container>
        <TopRow>
          <BackButton onClick={onBack}><ChevronLeft size="2rem" /></BackButton>
          <div style={{ width: '3.25rem' }} />
        </TopRow>
        <Title>Support</Title>
        <SupportDescription>Having trouble with sync, payments, or anything else? Send us an email and we'll get back to you as soon as possible.</SupportDescription>
        <SupportButton href="mailto:support@surflabs.net?subject=stꝋf%20Support">
          <Mail size="1rem" /> Email Support
        </SupportButton>
        <SupportInfo>
          <SupportText>support@surflabs.net</SupportText>
          <SupportCopyright>© Surf Labs AS 2026</SupportCopyright>
        </SupportInfo>
      </Container>
    );
  }

  if (view === 'backup') {
    const syncing = isSyncing();
    return (
      <Container>
        <TopRow>
          <BackButton onClick={onBack}><ChevronLeft size="2rem" /></BackButton>
          <div style={{ width: '3.25rem' }} />
        </TopRow>
        <Title>Data</Title>
        <Menu>
          <Item onClick={() => {
            const data = saveDocumentSnapshot();
            const blob = new Blob([new Uint8Array(data)], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `stuf-backup-${new Date().toISOString().slice(0, 10)}.stuf`;
            a.click();
            URL.revokeObjectURL(url);
          }}>
            <ItemLabel>Export Backup</ItemLabel>
            <ItemArrow>↓</ItemArrow>
          </Item>
          <Divider />
          <Item
            style={{ opacity: syncing ? 0.4 : 1, pointerEvents: syncing ? 'none' : 'auto' }}
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.stuf';
              input.onchange = async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!window.confirm('This will replace all local data. Continue?')) return;
                const buffer = await file.arrayBuffer();
                await loadDocumentSnapshot(Array.from(new Uint8Array(buffer)));
                refreshFromDoc();
                showToast?.('Import complete!', 'success');
              };
              input.click();
            }}
          >
            <ItemLabel>Import Backup</ItemLabel>
            <ItemArrow>↑</ItemArrow>
          </Item>
          {syncing && (
            <Hint>Disconnect from sync to import a backup</Hint>
          )}
        </Menu>
        <div style={{ flex: 1 }} />
        <DangerZone>
          <DangerLabel>Danger Zone</DangerLabel>
          <DangerHint>This will permanently delete all tasks, projects, tags, settings, and sync configuration from this device.</DangerHint>
          <DangerButton onClick={async () => {
            if (!window.confirm('Are you sure? All local data will be permanently deleted.')) return;
            if (!window.confirm('This cannot be undone. Continue?')) return;
            teardownSync();
            clearSyncConfig();
            await resetCRDT();
            window.location.reload();
          }}>Reset App</DangerButton>
        </DangerZone>
      </Container>
    );
  }

  // Main settings view
  return (
    <Container>
      <TopRow>
        <BackButton onClick={onBack}><ChevronLeft size="2rem" /></BackButton>
        <div style={{ width: '3.25rem' }} />
      </TopRow>
      <Title><SettingsIcon size="0.8em" style={{ marginRight: '0.25em', verticalAlign: 'middle' }} /> Settings</Title>
      <Menu>
        <Item onClick={onOpenSync}>
          <ItemLabel>Sync</ItemLabel>
          <ItemArrow>›</ItemArrow>
        </Item>
        <Divider />
        <Item onClick={onOpenBackup}>
          <ItemLabel>Data</ItemLabel>
          <ItemArrow>›</ItemArrow>
        </Item>
        <Divider />
        <Item onClick={onOpenSupport}>
          <ItemLabel>Support</ItemLabel>
          <ItemArrow>›</ItemArrow>
        </Item>
        <Divider />
        <Item>
          <ItemLabel>Morning starts at</ItemLabel>
          <Select
            value={settings.morningHour ?? 9}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              updateSettings({ morningHour: val });
              setSettings(prev => ({ ...prev, morningHour: val }));
            }}
          >
            {[6, 7, 8, 9, 10, 11].map(h => (
              <option key={h} value={h}>{h}:00</option>
            ))}
          </Select>
        </Item>
        <Item>
          <ItemLabel>Evening starts at</ItemLabel>
          <Select
            value={settings.eveningHour}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              updateSettings({ eveningHour: val });
              setSettings(prev => ({ ...prev, eveningHour: val }));
            }}
          >
            {[15, 16, 17, 18, 19, 20, 21].map(h => (
              <option key={h} value={h}>{h}:00</option>
            ))}
          </Select>
        </Item>
        <Item>
          <ItemLabel>Someday min days</ItemLabel>
          <Select
            value={settings.somedayMinDays}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              updateSettings({ somedayMinDays: val });
              setSettings(prev => ({ ...prev, somedayMinDays: val }));
            }}
          >
            {[5, 7, 10, 14, 21, 30].map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
        </Item>
        <Item>
          <ItemLabel>Someday max days</ItemLabel>
          <Select
            value={settings.somedayMaxDays}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              updateSettings({ somedayMaxDays: val });
              setSettings(prev => ({ ...prev, somedayMaxDays: val }));
            }}
          >
            {[30, 45, 60, 90, 120, 180].map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
        </Item>
      </Menu>
      <div style={{ flex: 1 }} />
      <VersionDivider />
      <VersionLabel>{__APP_VERSION__}</VersionLabel>
    </Container>
  );
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`;

const TopRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.5rem 0;
`;

const BackButton = styled.button`
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 0.5rem 0;
  display: flex;
  align-items: center;
`;

const Title = styled.h1`
  font-size: 2em;
  margin: 0.5rem 0 0;
  padding: 0 1.25rem;
`;

const Menu = styled.div`
  margin-top: 0.5rem;
`;

const Item = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1.75rem;
  color: white;
  font-size: 1rem;
  cursor: pointer;
  &:hover {
    opacity: 0.8;
  }
`;

const ItemLabel = styled.span``;

const ItemArrow = styled.span`
  color: #666;
  font-size: 1.25rem;
`;

const Divider = styled.div`
  height: 1px;
  background: #2a2a2c;
  margin: 0.5rem 1rem;
`;

const Hint = styled.div`
  color: #666;
  font-size: 0.75rem;
  padding: 0.25rem 1rem 0.5rem;
`;

const Select = styled.select`
  background: #2a2a2c;
  border: 1px solid #555;
  border-radius: 0.375rem;
  color: white;
  font-size: 0.875rem;
  padding: 0.375rem 0.625rem;
  outline: none;
`;

const VersionDivider = styled.div`
  height: 1px;
  background: #2a2a2c;
  margin: 0 1rem;
`;

const VersionLabel = styled.div`
  padding: 0.75rem 1rem;
  color: #888;
  font-size: 0.9375rem;
  text-align: center;
`;

const DangerZone = styled.div`
  margin: 2rem 1.25rem 1rem;
  padding: 1rem;
  border: 1px solid rgba(255, 69, 58, 0.25);
  border-radius: 0.75rem;
`;

const DangerLabel = styled.div`
  color: #ff453a;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03rem;
  margin-bottom: 0.375rem;
`;

const DangerHint = styled.div`
  color: #666;
  font-size: 0.75rem;
  line-height: 1.5;
  margin-bottom: 0.75rem;
`;

const DangerButton = styled.button`
  background: none;
  border: 1px solid #ff453a;
  color: #ff453a;
  font-size: 0.875rem;
  font-weight: 500;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  cursor: pointer;
  width: 100%;
  &:hover {
    background: rgba(255, 69, 58, 0.1);
  }
`;

const SupportDescription = styled.p`
  color: #888;
  font-size: 0.8125rem;
  line-height: 1.5;
  padding: 0.5rem 1.25rem 0;
  margin: 0;
`;

const SupportButton = styled.a`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: linear-gradient(135deg, #E85D24, #F5C030);
  color: white;
  font-size: 0.9375rem;
  font-weight: 500;
  padding: 0.75rem;
  border-radius: 0.5rem;
  margin: 1rem 1.25rem;
  text-decoration: none;
  cursor: pointer;
  &:hover { opacity: 0.9; color: white; }
  &:visited, &:active { color: white; }
`;

const SupportInfo = styled.div`
  padding: 0.5rem 1.75rem;
  text-align: center;
`;

const SupportText = styled.div`
  color: #666;
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
`;

const SupportCopyright = styled.div`
  color: #444;
  font-size: 0.75rem;
`;
