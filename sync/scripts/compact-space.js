#!/usr/bin/env node
/**
 * One-off, manual compaction of a single space's change log.
 *
 *   DATABASE_URL=postgresql://... node scripts/compact-space.js <spaceId> [--grace-days N] [--yes]
 *
 * Deletes changes with seq <= snapshot_seq that are older than the grace
 * period. Refuses unless the snapshot was stored by a client that reported
 * its exact cursor (snapshot_exact = 1), because only then is every change
 * <= snapshot_seq guaranteed to be inside the snapshot.
 *
 * Without --yes it only prints what it would delete. Take a pg_dump first.
 */
import { compactChanges, getConfig, getLastSeq } from '../db.js';
import pg from 'pg';
import { DATABASE_URL } from '../config.js';

const args = process.argv.slice(2);
const spaceId = args.find(a => !a.startsWith('--'));
const yes = args.includes('--yes');
const graceIdx = args.indexOf('--grace-days');
const graceDays = graceIdx >= 0 ? parseInt(args[graceIdx + 1]) || 0 : 0;

if (!spaceId) {
  console.error('usage: compact-space.js <spaceId> [--grace-days N] [--yes]');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const exact = await getConfig(spaceId, 'snapshot_exact');
const snapshotSeq = parseInt(await getConfig(spaceId, 'snapshot_seq')) || 0;
const lastSeq = await getLastSeq(spaceId);
const cutoff = Math.floor(Date.now() / 1000) - graceDays * 86400;
const { rows } = await pool.query(
  'SELECT count(*)::int AS n FROM changes WHERE space_id = $1 AND seq <= $2 AND created_at <= $3',
  [spaceId, snapshotSeq, cutoff]
);
const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM changes WHERE space_id = $1', [spaceId]);

console.log(`space          ${spaceId}`);
console.log(`changes total  ${total[0].n}`);
console.log(`last seq       ${lastSeq}`);
console.log(`snapshot seq   ${snapshotSeq}  exact=${exact === '1'}`);
console.log(`would delete   ${rows[0].n} (seq <= ${snapshotSeq}, older than ${graceDays} days)`);

if (exact !== '1') {
  console.error('\nRefusing: snapshot was not stored with an exact cursor. Let an updated client push a fresh snapshot first.');
  await pool.end();
  process.exit(2);
}
if (!yes) {
  console.log('\nDry run. Re-run with --yes to delete.');
  await pool.end();
  process.exit(0);
}

const result = await compactChanges(spaceId, graceDays * 86400);
console.log(`deleted        ${result?.deleted ?? 0}  compacted_seq=${result?.compactedSeq ?? 0}`);
await pool.end();
