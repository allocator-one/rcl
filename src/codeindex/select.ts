/**
 * Which code index view describes the code under review, and whether it is
 * fresh enough to use. Every way the index can be unusable ends the same way:
 * `resolveCodeIndex` returns `{ used: false, reason }`, the review runs as it
 * does without the index, and the report header records that answer.
 *
 * The view comes from `--code-view <id>`, else from
 * `infraone harness code status --json` run in the review's working
 * directory. The CLI's state files are never read.
 */

import { execFile } from 'node:child_process';
import {
  CodeIndexClient, CodeIndexError, resolveClientCredential,
  type CodeIndexCredential, type ViewMeta,
} from './client.js';
import type { TargetKind } from '../report/run-header.js';

/** The `codeIndex` entry of the report header. */
export type CodeIndexRecord =
  | { used: false; reason: string }
  | { used: true; viewId: string; version: number; baseCommit: string; overlayDigest: string };

/** `infraone harness code status --json`, as far as the freshness check reads it. */
export interface CodeStatus {
  state: string;
  base_commit?: string;
  view_id?: string;
  local_overlay_digest?: string;
  active?: { version?: number; base_commit?: string; overlay_digest?: string } | null;
}

export type StatusRunner = (cwd: string) => Promise<CodeStatus>;
export type CleanTreeCheck = (cwd: string) => Promise<boolean>;

/** A usable index: the client and view later steps query, and the header record. */
export interface CodeIndexSession {
  client: CodeIndexClient;
  viewId: string;
  view: ViewMeta;
}

export interface ResolveCodeIndexInput {
  /** Config `codeIndex.enabled`; absent means on. */
  configEnabled?: boolean;
  /** `--no-code-index`. */
  flagDisabled?: boolean;
  /** `--code-view <id>`. */
  codeView?: string;
  target: { kind: TargetKind; headSha?: string };
  cwd: string;
  env: Record<string, string | undefined>;
  credential?: CodeIndexCredential;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  runStatus?: StatusRunner;
  isTreeClean?: CleanTreeCheck;
}

export interface ResolvedCodeIndex {
  record: CodeIndexRecord;
  session?: CodeIndexSession;
}

const STATUS_TIMEOUT_MS = 20_000;

class StatusFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Runs the Harness CLI's own status read; its stdout is the only thing used. */
export const runInfraoneStatus: StatusRunner = (cwd) =>
  new Promise((resolve, reject) => {
    execFile('infraone', ['harness', 'code', 'status', '--json', '--path', cwd],
      { cwd, timeout: STATUS_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reject(new StatusFailure(code === 'ENOENT' ? 'cli_unavailable' : 'status_unavailable'));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (typeof parsed !== 'object' || parsed === null || typeof (parsed as CodeStatus).state !== 'string') throw new Error();
          resolve(parsed as CodeStatus);
        } catch {
          reject(new StatusFailure('status_unavailable'));
        }
      });
  });

export const gitTreeIsClean: CleanTreeCheck = (cwd) =>
  new Promise(resolve => {
    execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, timeout: STATUS_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (error, stdout) => resolve(!error && stdout.trim() === ''));
  });

function unused(reason: string): ResolvedCodeIndex {
  return { record: { used: false, reason } };
}

/**
 * Decide whether the index may be used for this review. Never throws: a
 * failure of any kind is the `reason` the report header records.
 */
export async function resolveCodeIndex(input: ResolveCodeIndexInput): Promise<ResolvedCodeIndex> {
  if (input.flagDisabled === true) return unused('disabled_by_flag');
  if (input.configEnabled === false) return unused('disabled_by_config');
  const { kind, headSha } = input.target;
  // A staged diff and a patch without its commit are code no view describes.
  if (kind === 'staged' || kind === 'plan' || (kind === 'patch' && headSha === undefined)) return unused('target_not_indexed');
  if (headSha === undefined) return unused('target_not_indexed');
  try {
    const credential = await resolveClientCredential({
      cwd: input.cwd, env: input.env,
      ...(input.credential !== undefined ? { credential: input.credential } : {}),
      ...(input.credentialsPath !== undefined ? { credentialsPath: input.credentialsPath } : {}),
    });
    const local = kind === 'working_tree';
    const explicit = input.codeView?.trim() || undefined;

    // A pull request's code is a commit, so a view that holds exactly that
    // commit (and no uncommitted overlay) is the only fresh one.
    let status: CodeStatus | undefined;
    if (local || explicit === undefined) {
      if (!local && !(await (input.isTreeClean ?? gitTreeIsClean)(input.cwd))) return unused('worktree_dirty');
      status = await (input.runStatus ?? runInfraoneStatus)(input.cwd);
      if (explicit === undefined) {
        if (status.state === 'not_synced' || status.state === 'failed' || status.view_id === undefined) return unused('no_view');
        if (status.state !== 'current') return unused('stale_view');
      }
    }
    const viewId = explicit ?? status!.view_id!;

    const client = new CodeIndexClient({
      credential,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    });
    // An empty search returns no symbols, only the view's freshness.
    const { view } = await client.search(viewId, { limit: 1 });
    const active = view.active;
    if (active === null) return unused('no_view');

    const fresh = local
      ? status!.base_commit === headSha && active.base_commit === headSha
        && status!.local_overlay_digest !== undefined && active.overlay_digest === status!.local_overlay_digest
      : active.base_commit === headSha
        && (explicit !== undefined ? view.kind === 'default_branch' : status!.local_overlay_digest === active.overlay_digest);
    if (!fresh) return unused('stale_view');

    return {
      record: { used: true, viewId: view.view_id, version: active.version, baseCommit: active.base_commit, overlayDigest: active.overlay_digest },
      session: { client, viewId: view.view_id, view },
    };
  } catch (error) {
    if (error instanceof CodeIndexError) return unused(error.reason);
    if (error instanceof StatusFailure) return unused(error.reason);
    return unused('unexpected_error');
  }
}
