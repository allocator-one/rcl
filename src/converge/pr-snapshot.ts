import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';
import { readStable, sha256 } from '../telemetry/recovery/files.js';

/**
 * A pull request's live state, read once by a parent process that holds
 * GitHub credentials and handed to a review process that holds none (RCL-216).
 *
 * Grid hosts strip GitHub credentials from every reviewer process on purpose,
 * yet a review cycle must confirm that the pull request is still open at the
 * head under review. The parent captures that state with `rcl pr-snapshot`
 * shortly before launching, and the review reads it with `--pr-snapshot`
 * instead of calling GitHub. Harness still verifies the reviewed head against
 * the pull request when the evidence arrives; this snapshot only replaces the
 * reviewer's own pre-launch read.
 */
export const PR_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const MAX_SNAPSHOT_BYTES = 16 * 1024;

export const prSnapshotSchema = z.object({
  kind: z.literal('rcl-pr-snapshot'),
  version: z.literal(1),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prNumber: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  baseRef: z.string().min(1).max(255),
  merged: z.boolean(),
  state: z.string().min(1).max(32),
  fetchedAt: z.string().datetime({ offset: true }),
}).strict();
export type PrSnapshot = z.infer<typeof prSnapshotSchema>;

export interface LivePullRequestState { headSha: string; merged: boolean; state: string }

/** The fields a snapshot keeps from GitHub's pull request object. */
export function prSnapshotFrom(repo: string, prNumber: number, pr: {
  head: { sha: string }; base: { sha: string; ref: string }; merged: boolean | null; state: string;
}, now = new Date()): PrSnapshot {
  return prSnapshotSchema.parse({ kind: 'rcl-pr-snapshot', version: 1, repo: repo.toLowerCase(), prNumber,
    headSha: pr.head.sha, baseSha: pr.base.sha, baseRef: pr.base.ref, merged: pr.merged === true, state: pr.state,
    fetchedAt: now.toISOString() });
}

/** Write a new snapshot exclusively, readable by its owner only; answer its SHA-256. */
export async function writePrSnapshot(path: string, snapshot: PrSnapshot): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(prSnapshotSchema.parse(snapshot), null, 2)}\n`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return sha256(bytes);
}

/**
 * Read a snapshot for `repo#prNumber` and answer the live state it records.
 * Refuses a file another user could have written, one for another pull
 * request, and one older than {@link PR_SNAPSHOT_MAX_AGE_MS}: an old reading
 * cannot stand in for the live check.
 */
export async function readPrSnapshot(path: string, repo: string, prNumber: number,
  now = Date.now()): Promise<LivePullRequestState> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
    (stat.uid !== process.geteuid?.() || (stat.mode & 0o022) !== 0))) throw new Error('pr_snapshot_unsafe_file');
  let snapshot: PrSnapshot;
  try { snapshot = prSnapshotSchema.parse(JSON.parse((await readStable(path, MAX_SNAPSHOT_BYTES)).text)); }
  catch { throw new Error('pr_snapshot_invalid'); }
  if (snapshot.repo.toLowerCase() !== repo.toLowerCase() || snapshot.prNumber !== prNumber) throw new Error('pr_snapshot_pull_request_mismatch');
  const age = now - Date.parse(snapshot.fetchedAt);
  if (age > PR_SNAPSHOT_MAX_AGE_MS || age < -MAX_FUTURE_SKEW_MS) throw new Error('pr_snapshot_stale');
  return { headSha: snapshot.headSha, merged: snapshot.merged, state: snapshot.state };
}
