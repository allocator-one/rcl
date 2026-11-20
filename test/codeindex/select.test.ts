import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodeIndex, type CodeStatus, type ResolveCodeIndexInput } from '../../src/codeindex/select.js';
import { buildRunHeader } from '../../src/report/run-header.js';

const HEAD = '4e558ebb37b720601c253509c18bc698a08a9251';
const OVERLAY = 'a'.repeat(64);
const VIEW = '7d3f0c1e-2b44-4f6a-9a51-0c2d8e5b7a10';
const credential = { url: 'https://harness.example.test', token: 'aone_secret' };

const meta = (over: Record<string, unknown> = {}, active: Record<string, unknown> | null = {}) => ({
  data: [],
  meta: {
    contract: '1.3', truncation: { truncated: false },
    view: { view_id: VIEW, kind: 'worktree', active: active === null ? null : { version: 7, base_commit: HEAD, overlay_digest: OVERLAY, ...active }, pending: null, ...over },
  },
});
const serve = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const current: CodeStatus = { state: 'current', base_commit: HEAD, view_id: VIEW, local_overlay_digest: OVERLAY };

const base = (over: Partial<ResolveCodeIndexInput> = {}): ResolveCodeIndexInput => ({
  cwd: '/repo', env: {}, credential,
  target: { kind: 'working_tree', headSha: HEAD },
  runStatus: async () => current,
  isTreeClean: async () => true,
  fetchImpl: serve(meta()),
  sleep: async () => {},
  ...over,
});

describe('resolveCodeIndex: used', () => {
  it('uses an in-sync worktree view and records its version, commit and digest', async () => {
    const { record, session } = await resolveCodeIndex(base());
    expect(record).toEqual({ used: true, viewId: VIEW, version: 7, baseCommit: HEAD, overlayDigest: OVERLAY });
    expect(session?.viewId).toBe(VIEW);
  });

  it('lets --code-view win over the status view when it describes the same tree', async () => {
    const other = 'c0ffee00-0000-4000-8000-000000000000';
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { seen.push(String(url)); return new Response(JSON.stringify(meta({ view_id: other })), { status: 200 }); }) as typeof fetch;
    const { record } = await resolveCodeIndex(base({ codeView: other, fetchImpl }));
    expect(seen[0]).toContain(`/views/${other}/`);
    expect(record).toMatchObject({ used: true, viewId: other });
  });

  it('uses a default-branch view that holds exactly the pull request head', async () => {
    const result = await resolveCodeIndex(base({
      target: { kind: 'pr', headSha: HEAD }, codeView: VIEW, runStatus: async () => { throw new Error('not called'); },
      fetchImpl: serve(meta({ kind: 'default_branch' })),
    }));
    expect(result.record.used).toBe(true);
  });

  it('uses the cwd view for a pull request when the clean checkout is at its head', async () => {
    expect((await resolveCodeIndex(base({ target: { kind: 'pr', headSha: HEAD } }))).record.used).toBe(true);
  });
});

describe('resolveCodeIndex: every unusable case degrades with a reason', () => {
  const unusable = async (over: Partial<ResolveCodeIndexInput>, reason: string) =>
    expect((await resolveCodeIndex(base(over))).record).toEqual({ used: false, reason });

  it('--no-code-index', () => unusable({ flagDisabled: true }, 'disabled_by_flag'));
  it('config codeIndex.enabled: false', () => unusable({ configEnabled: false }, 'disabled_by_config'));
  it('staged changes', () => unusable({ target: { kind: 'staged', headSha: HEAD } }, 'target_not_indexed'));
  it('a patch without its commit', () => unusable({ target: { kind: 'patch' } }, 'target_not_indexed'));

  it('no login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-codeindex-'));
    try {
      const { credential: _omit, ...rest } = base({ credentialsPath: join(dir, 'missing.json') });
      expect((await resolveCodeIndex(rest)).record).toEqual({ used: false, reason: 'no_login' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('a stored login is used when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-codeindex-'));
    try {
      const path = join(dir, 'credentials.json');
      await writeFile(path, JSON.stringify(credential));
      const { credential: _omit, ...rest } = base({ credentialsPath: path });
      expect((await resolveCodeIndex(rest)).record.used).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('403 code_index_disabled', () =>
    unusable({ fetchImpl: serve({ error: { code: 'code_index_disabled' } }, 403) }, 'code_index_disabled'));
  it('403 without that code', () => unusable({ fetchImpl: serve({}, 403) }, 'forbidden'));
  it('no view synced', () => unusable({ runStatus: async () => ({ state: 'not_synced', base_commit: HEAD }) }, 'no_view'));
  it('a view whose sync failed', () => unusable({ runStatus: async () => ({ state: 'failed', base_commit: HEAD }) }, 'no_view'));
  it('a view with no active version', () => unusable({ fetchImpl: serve(meta({}, null)) }, 'no_view'));
  it('the view is gone (404)', () => unusable({ fetchImpl: serve({}, 404) }, 'view_not_found'));
  it('a stale view per status', () => unusable({ runStatus: async () => ({ ...current, state: 'stale' }) }, 'stale_view'));
  it('a pending sync per status', () => unusable({ runStatus: async () => ({ ...current, state: 'pending' }) }, 'stale_view'));
  it('the server view moved to another overlay', () => unusable({ fetchImpl: serve(meta({}, { overlay_digest: 'b'.repeat(64) })) }, 'stale_view'));
  it('the server view is at another commit', () => unusable({ fetchImpl: serve(meta({}, { base_commit: 'f'.repeat(40) })) }, 'stale_view'));
  it('--code-view that does not describe the working tree', () =>
    unusable({ codeView: VIEW, fetchImpl: serve(meta({}, { overlay_digest: 'b'.repeat(64) })) }, 'stale_view'));
  it('a pull request on a dirty checkout', () =>
    unusable({ target: { kind: 'pr', headSha: HEAD }, isTreeClean: async () => false }, 'worktree_dirty'));
  it('a pull request against a worktree --code-view', () =>
    unusable({ target: { kind: 'pr', headSha: HEAD }, codeView: VIEW }, 'stale_view'));
  it('a pull request whose head the view lacks', () =>
    unusable({ target: { kind: 'pr', headSha: 'e'.repeat(40) }, codeView: VIEW, fetchImpl: serve(meta({ kind: 'default_branch' })) }, 'stale_view'));
  it('a timeout', () => unusable({ fetchImpl: (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as typeof fetch }, 'timeout'));
  it('a network error', () => unusable({ fetchImpl: (async () => { throw new TypeError('x'); }) as typeof fetch }, 'network_error'));
  it('the CLI is missing', () => unusable({ runStatus: async () => { throw Object.assign(new Error('x'), { reason: 'cli_unavailable' }); } }, 'unexpected_error'));
  it('a response that is not the contract', () => unusable({ fetchImpl: serve({ data: 1 }) }, 'unrecognized_response'));
});

describe('the report header', () => {
  const header = (codeIndex?: Parameters<typeof buildRunHeader>[0]['codeIndex']) => buildRunHeader({
    rclVersion: '0.0.0', command: 'review', target: { kind: 'working_tree' }, diff: { files: [] } as never,
    roster: [], config: {}, thresholds: { minConsensusScore: 0.5, minConfidence: 0.5, dedupeLineWindow: 3, jaccardThreshold: 0.5 },
    gating: { mode: 'all-findings', minModels: 2, verificationTimeoutMs: 1 } as never,
    runner: { kind: 'human' }, startedAt: new Date(0), finishedAt: new Date(0), ciExitCode: 0,
    ...(codeIndex ? { codeIndex } : {}),
  });

  it('records why the index was not used', () => {
    expect(header({ used: false, reason: 'stale_view' }).codeIndex).toEqual({ used: false, reason: 'stale_view' });
  });

  it('records the view, version, commit and digest when used', () => {
    const record = { used: true as const, viewId: VIEW, version: 7, baseCommit: HEAD, overlayDigest: OVERLAY };
    expect(header(record).codeIndex).toEqual(record);
  });

  it('leaves the header as it was when nothing is recorded', () => {
    expect('codeIndex' in header()).toBe(false);
  });
});
