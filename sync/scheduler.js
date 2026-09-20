import * as Sentry from '@sentry/node';
import webpush from 'web-push';
import { VAPID_CONTACT, COMPACT_AFTER_DAYS } from './config.js';
import { getDueReminders, markReminderSent, getPushSubscriptionsForSpace, deletePushSubscription, getServerConfig, getSpacesWithSnapshot, compactChanges } from './db.js';

// Compaction: once a day, delete changes that are already contained in a
// space's snapshot and older than COMPACT_AFTER_DAYS. Off unless configured.
export async function runCompaction() {
  const grace = COMPACT_AFTER_DAYS * 24 * 60 * 60;
  const spaces = await getSpacesWithSnapshot();
  for (const spaceId of spaces) {
    try {
      const result = await compactChanges(spaceId, grace);
      if (result && result.deleted > 0) {
        console.log(`Compaction: space ${spaceId} deleted ${result.deleted} changes (<= seq ${result.compactedSeq})`);
      }
    } catch (err) {
      console.warn('Compaction failed for space', spaceId, err.message);
      Sentry.captureException(err, { tags: { context: 'compaction', spaceId } });
    }
  }
}

function startCompaction() {
  if (!COMPACT_AFTER_DAYS) {
    console.log('Compaction disabled (COMPACT_AFTER_DAYS=0)');
    return;
  }
  setInterval(() => runCompaction().catch(err => console.warn('Compaction run failed:', err.message)), 24 * 60 * 60 * 1000);
  setTimeout(() => runCompaction().catch(err => console.warn('Compaction run failed:', err.message)), 60 * 1000);
  console.log(`Compaction enabled (changes older than ${COMPACT_AFTER_DAYS} days already in snapshot)`);
}

export async function startScheduler() {
  startCompaction();
  const vapidPublic = await getServerConfig('vapid_public_key');
  const vapidPrivate = await getServerConfig('vapid_private_key');

  if (!vapidPublic || !vapidPrivate) {
    console.warn('Scheduler: VAPID keys not found, skipping');
    return;
  }

  const vapidContact = VAPID_CONTACT;
  webpush.setVapidDetails(vapidContact, vapidPublic, vapidPrivate);

  setInterval(async () => {
    const due = await getDueReminders();
    if (due.length === 0) return;

    for (const reminder of due) {
      const subscriptions = await getPushSubscriptionsForSpace(reminder.space_id);

      if (subscriptions.length === 0) {
        await markReminderSent(reminder.id);
        continue;
      }

      const payload = JSON.stringify({
        title: 'TIME SENSITIVE',
        body: reminder.title || 'stuf',
        taskId: reminder.task_id,
      });

      for (const sub of subscriptions) {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
          }, payload);
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await deletePushSubscription(sub.endpoint);
            console.log('Removed expired push subscription');
          } else {
            console.warn('Push send failed:', err.statusCode, err.body, err.message);
            Sentry.captureException(err, { tags: { context: 'push-send', spaceId: reminder.space_id } });
          }
        }
      }

      await markReminderSent(reminder.id);
    }
  }, 30000);

  console.log('Reminder scheduler started (30s interval)');
}
