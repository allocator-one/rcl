import { describe, it, expect } from 'vitest';
import {
  buildRunHeader,
  buildRoster,
  configDigest,
  detectRunner,
  diffDigest,
  parseSpecSource,
  resolveConvergeContext,
  validateSha,
} from '../../src/report/run-header.js';
import { uuidv7 } from '../../src/report/uuid.js';
import type { Diff, FileChange } from '../../src/resolver/types.js';
import type { Config } from '../../src/config/schema.js';
import type { Role } from '../../src/roles/types.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function file(over: Partial<FileChange> = {}): FileChange {
  return {
    filename: 'src/a.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: '@@ -1,2 +1,4 @@\n-old\n+new\n+more\n+lines',
    language: 'typescript',
    ...over,
  };
}

function prDiff(): Diff {
  return {
    source: 'github',
    files: [file(), file({ filename: 'lib/b.ex', additions: 10, deletions: 2, patch: '@@ -1 +1 @@\n-x\n+y' })],
    metadata: {
      owner: 'allocator-one',
      repo: 'rcl',
      number: 42,
      title: 't',
      body: '',
      author: 'mstroeck',
      base: 'main',
      head: 'feature',
      headSha: HEAD,
      baseSha: BASE,
      url: 'https://github.com/allocator-one/rcl/pull/42',
      labels: [],
      draft: false,
    },
  };
}

function role(name: string, isSpecialized = false): Role {
  return { name, systemPrompt: '', focus: [], description: '', isSpecialized };
}

const CONFIG: Config = {
  models: ['anthropic/claude-fable-5', 'openai/gpt-5.6-sol'],
  secondaryModels: ['openrouter/x/y'],
  githubToken: 'ghp_secret',
};

const THRESHOLDS = {
  minConsensusScore: 0.4,
  minConfidence: 0.2,
  dedupeLineWindow: 5,
  jaccardThreshold: 0.3,
};

const GATING = {
  mode: 'verified-consensus' as const,
  minModels: 2,
  verificationModel: 'google/gemini-3.8-flash',
  verificationTimeoutMs: 60_000,
};

function baseInput() {
  const diff = prDiff();
  return {
    rclVersion: '3.0.0',
    command: 'review' as const,
    target: {
      kind: 'pr' as const,
      repo: 'allocator-one/rcl',
      prNumber: 42,
      url: diff.metadata!.url,
      headSha: HEAD,
      baseSha: BASE,
      headRef: 'feature',
      baseRef: 'main',
    },
    diff,
    roster: [
      { model: 'anthropic/claude-fable-5', role: 'general', provider: 'anthropic', lane: 'blocking' as const },
    ],
    config: CONFIG,
    thresholds: THRESHOLDS,
    gating: GATING,
    runner: { kind: 'human' as const },
    startedAt: new Date('2026-09-07T10:00:00.000Z'),
    finishedAt: new Date('2026-09-07T10:02:30.500Z'),
    ciExitCode: 1,
  };
}

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 ids whose prefix encodes the timestamp', () => {
    const at = Date.UTC(2026, 8, 7, 10, 0, 0);
    const id = uuidv7(at);
    expect(id).toMatch(UUID_V7);
    const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(ms).toBe(at);
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uuidv7()));
    expect(ids.size).toBe(200);
  });
});

describe('buildRunHeader', () => {
  it('identifies the run: client id, rcl version, command', () => {
    const run = buildRunHeader(baseInput());
    expect(run.id).toMatch(UUID_V7);
    expect(run.rcl_version).toBe('3.0.0');
    expect(run.command).toBe('review');
  });

  it('keeps a caller-supplied id (idempotency key for retries)', () => {
    const run = buildRunHeader({ ...baseInput(), id: '01924f6e-6a2b-7c4d-8e9f-0123456789ab' });
    expect(run.id).toBe('01924f6e-6a2b-7c4d-8e9f-0123456789ab');
  });

  it('binds the target to the exact PR head and base', () => {
    const run = buildRunHeader(baseInput());
    expect(run.target).toMatchObject({
      kind: 'pr',
      repo: 'allocator-one/rcl',
      pr_number: 42,
      url: 'https://github.com/allocator-one/rcl/pull/42',
      head_sha: HEAD,
      base_sha: BASE,
      head_ref: 'feature',
      base_ref: 'main',
      files: 2,
      additions: 13,
      deletions: 3,
    });
    expect(run.target.diff_sha256).toMatch(SHA256);
  });

  it('omits head/base fields a patch file cannot provide', () => {
    const input = baseInput();
    const run = buildRunHeader({
      ...input,
      target: { kind: 'patch' },
      diff: { ...input.diff, metadata: undefined, source: 'local' },
    });
    expect(run.target.kind).toBe('patch');
    expect(run.target).not.toHaveProperty('head_sha');
    expect(run.target).not.toHaveProperty('repo');
    expect(run.target.diff_sha256).toMatch(SHA256);
  });

  it('records the roster, digests, inline thresholds and gating', () => {
    const run = buildRunHeader(baseInput());
    expect(run.roster).toEqual([
      { model: 'anthropic/claude-fable-5', role: 'general', provider: 'anthropic', lane: 'blocking' },
    ]);
    expect(run.config_sha256).toMatch(SHA256);
    expect(run.thresholds).toEqual({
      min_consensus_score: 0.4,
      min_confidence: 0.2,
      dedupe_line_window: 5,
      jaccard_threshold: 0.3,
    });
    expect(run.gating).toEqual({
      mode: 'verified-consensus',
      min_models: 2,
      verification_model: 'google/gemini-3.8-flash',
      verification_timeout_ms: 60_000,
    });
  });

  it('carries spec and context digests, defaulting context to an empty list', () => {
    const without = buildRunHeader(baseInput());
    expect(without.spec).toBeUndefined();
    expect(without.context_files).toEqual([]);

    const with_ = buildRunHeader({
      ...baseInput(),
      spec: { source: 'harness_issue:IO-12475', sha256: 'c'.repeat(64) },
      contextFiles: [{ path: 'docs/rules/x.md', sha256: 'd'.repeat(64) }],
    });
    expect(with_.spec).toEqual({ source: 'harness_issue:IO-12475', sha256: 'c'.repeat(64) });
    expect(with_.context_files).toEqual([{ path: 'docs/rules/x.md', sha256: 'd'.repeat(64) }]);
  });

  it('records timing, the runner claim, the CI verdict and the converge context', () => {
    const run = buildRunHeader({
      ...baseInput(),
      runner: { kind: 'agent', agent: 'claude-code', host: 'mbp' },
      converge: { target: 'allocator-one/rcl#42', round: 2, attempt: 3 },
    });
    expect(run.started_at).toBe('2026-09-07T10:00:00.000Z');
    expect(run.finished_at).toBe('2026-09-07T10:02:30.500Z');
    expect(run.duration_ms).toBe(150_500);
    expect(run.runner).toEqual({ kind: 'agent', agent: 'claude-code', host: 'mbp' });
    expect(run.ci_exit_code).toBe(1);
    expect(run.converge).toEqual({ target: 'allocator-one/rcl#42', round: 2, attempt: 3 });
  });

  it('leaves converge out when the run is not part of a converge loop', () => {
    expect(buildRunHeader(baseInput())).not.toHaveProperty('converge');
  });

  it('never carries the GitHub token or any config value verbatim', () => {
    const json = JSON.stringify(buildRunHeader(baseInput()));
    expect(json).not.toContain('ghp_secret');
  });
});

describe('diffDigest', () => {
  it('is stable across file order and sensitive to patch content', () => {
    const a = file({ filename: 'a.ts' });
    const b = file({ filename: 'b.ts', patch: '@@ -1 +1 @@\n-1\n+2' });
    expect(diffDigest([a, b])).toBe(diffDigest([b, a]));
    expect(diffDigest([a, b])).toMatch(SHA256);
    expect(diffDigest([a, { ...b, patch: b.patch + '\n+3' }])).not.toBe(diffDigest([a, b]));
  });
});

describe('configDigest', () => {
  it('ignores the GitHub token and key order but not the roster', () => {
    const base: Config = { models: ['m1'], thresholds: { minConfidence: 0.1 } };
    expect(configDigest(base)).toBe(configDigest({ ...base, githubToken: 'ghp_x' }));
    expect(configDigest(base)).toBe(
      configDigest({ thresholds: { minConfidence: 0.1 }, models: ['m1'] })
    );
    expect(configDigest(base)).not.toBe(configDigest({ ...base, models: ['m2'] }));
  });
});

describe('buildRoster', () => {
  const general = role('general');
  const security = role('security-auditor', true);

  it('labels core, secondary, async and verification lanes', () => {
    const roster = buildRoster({
      assignments: [
        { model: 'anthropic/claude-fable-5', role: general, provider: 'anthropic' },
        { model: 'openrouter/x/y', role: security, provider: 'openrouter' },
      ],
      asyncAssignments: [{ model: 'openrouter/moonshotai/kimi-k3', role: general, provider: 'openrouter' }],
      coreModels: ['anthropic/claude-fable-5'],
      gating: GATING,
    });
    expect(roster).toEqual([
      { model: 'anthropic/claude-fable-5', role: 'general', provider: 'anthropic', lane: 'blocking' },
      { model: 'openrouter/x/y', role: 'security-auditor', provider: 'openrouter', lane: 'secondary' },
      { model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter', lane: 'async' },
      { model: 'google/gemini-3.8-flash', role: 'verification', provider: 'google', lane: 'verification' },
    ]);
  });

  it('treats every explicit --reviewer pair as blocking and skips the verifier when gating is off', () => {
    const roster = buildRoster({
      assignments: [{ model: 'openrouter/x/y', role: general, provider: 'openrouter' }],
      asyncAssignments: [],
      coreModels: ['anthropic/claude-fable-5'],
      explicit: true,
      gating: { ...GATING, mode: 'all-findings' },
    });
    expect(roster).toEqual([
      { model: 'openrouter/x/y', role: 'general', provider: 'openrouter', lane: 'blocking' },
    ]);
  });
});

describe('detectRunner', () => {
  it('recognizes GitHub Actions as CI with its run id', () => {
    expect(detectRunner({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123' }, 'runner-1')).toEqual({
      kind: 'ci',
      ci_run_id: '123',
      host: 'runner-1',
    });
  });

  it('recognizes an agent session and names the agent', () => {
    expect(detectRunner({ CLAUDECODE: '1' }, 'mbp')).toEqual({ kind: 'agent', agent: 'claude-code', host: 'mbp' });
    expect(detectRunner({ CODEX_SANDBOX: 'seatbelt' }, 'mbp')).toMatchObject({ kind: 'agent', agent: 'codex' });
  });

  it('defaults to a human, truncates the host, and reads nothing else from the environment', () => {
    const runner = detectRunner({ ANTHROPIC_API_KEY: 'sk-secret', HOME: '/x' }, 'h'.repeat(100));
    expect(runner.kind).toBe('human');
    expect(runner.host).toHaveLength(64);
    expect(JSON.stringify(runner)).not.toContain('sk-secret');
  });
});

describe('parseSpecSource', () => {
  it('accepts the three documented forms', () => {
    expect(parseSpecSource('flag')).toBe('flag');
    expect(parseSpecSource('repo_file')).toBe('repo_file');
    expect(parseSpecSource('harness_issue:IO-12475')).toBe('harness_issue:IO-12475');
  });

  it('rejects anything else', () => {
    expect(() => parseSpecSource('harness_issue:')).toThrow(/--spec-source/);
    expect(() => parseSpecSource('linear:ABC-1')).toThrow(/--spec-source/);
  });
});

describe('validateSha', () => {
  it('normalizes a full 40-hex SHA and rejects anything shorter', () => {
    expect(validateSha('A'.repeat(40), '--head-sha')).toBe('a'.repeat(40));
    expect(() => validateSha('abc1234', '--head-sha')).toThrow(/--head-sha.*40/);
    expect(() => validateSha('g'.repeat(40), '--head-sha')).toThrow(/--head-sha/);
  });
});

describe('resolveConvergeContext', () => {
  it('prefers flags over the RCL_CONVERGE_* environment', () => {
    expect(
      resolveConvergeContext(
        { convergeTarget: 'o/r#1', round: '3', attempt: '4' },
        { RCL_CONVERGE_TARGET: 'env', RCL_CONVERGE_ROUND: '9', RCL_CONVERGE_ATTEMPT: '9' }
      )
    ).toEqual({ target: 'o/r#1', round: 3, attempt: 4 });
  });

  it('falls back to the environment and is absent without any converge input', () => {
    expect(
      resolveConvergeContext({}, { RCL_CONVERGE_TARGET: 'o/r#2', RCL_CONVERGE_ROUND: '1' })
    ).toEqual({ target: 'o/r#2', round: 1 });
    expect(resolveConvergeContext({}, {})).toBeUndefined();
  });

  it('rejects a non-positive or non-integer round or attempt', () => {
    expect(() => resolveConvergeContext({ convergeTarget: 't', round: '0' }, {})).toThrow(/--round/);
    expect(() => resolveConvergeContext({ convergeTarget: 't', attempt: 'x' }, {})).toThrow(/--attempt/);
  });
});

describe('round-1 hardening', () => {
  it('diffDigest is injective across separator-shaped filenames and patches', () => {
    // Under naive space/newline joining these two serialize identically.
    const a = [file({ filename: 'x', status: 'renamed', previousFilename: 'b c', patch: 'd' })];
    const b = [file({ filename: 'x', status: 'renamed', previousFilename: 'b', patch: 'c d' })];
    expect(diffDigest(a)).not.toBe(diffDigest(b));
    const c = [file({ filename: 'a b', patch: 'p' }), file({ filename: 'c', patch: 'q' })];
    const d = [file({ filename: 'a', patch: 'b p' }), file({ filename: 'c', patch: 'q' })];
    expect(diffDigest(c)).not.toBe(diffDigest(d));
  });

  it('a round or attempt without a converge target is an error, not a silent drop', () => {
    expect(() => resolveConvergeContext({ round: '2' }, {})).toThrow(/converge target/);
    expect(() => resolveConvergeContext({}, { RCL_CONVERGE_ATTEMPT: '1' })).toThrow(/converge target/);
    expect(() => resolveConvergeContext({ round: 'abc' }, {})).toThrow(/--round/);
  });

  it('uuidv7 clamps a pre-epoch or fractional clock into the unsigned timestamp field', () => {
    expect(uuidv7(-5)).toMatch(UUID_V7);
    expect(uuidv7(-5).slice(0, 13)).toBe('00000000-0000');
    const at = Date.UTC(2026, 8, 7, 10, 0, 0);
    expect(parseInt(uuidv7(at + 0.75).slice(0, 8) + uuidv7(at + 0.75).slice(9, 13), 16)).toBe(at);
  });
});

describe('round-2 hardening', () => {
  it('stableStringify is key-order independent at every level and always returns a string', async () => {
    const { stableStringify } = await import('../../src/report/run-header.js');
    expect(stableStringify({ a: { y: 1, x: [3, { q: 1, p: 2 }] }, b: 2 })).toBe(
      stableStringify({ b: 2, a: { x: [3, { p: 2, q: 1 }], y: 1 } })
    );
    // undefined object values are dropped; undefined array elements become null, like JSON.stringify
    expect(stableStringify({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(() => 1)).toBe('null');
    expect(stableStringify('quote " backslash \\ ünï  ')).toBe(JSON.stringify('quote " backslash \\ ünï  '));
    expect(stableStringify(null)).toBe('null');
  });

  it('diffDigest normalizes a missing previousFilename to null and tracks patch-only changes', () => {
    const a = file({ filename: 'a.ts', previousFilename: undefined });
    const b = { ...file({ filename: 'a.ts' }) };
    delete (b as { previousFilename?: string }).previousFilename;
    expect(diffDigest([a])).toBe(diffDigest([b]));
    expect(diffDigest([file({ filename: 'a","b' })])).not.toBe(diffDigest([file({ filename: 'a' }), file({ filename: 'b' })]));
  });

  it('configDigest covers only allow-listed fields', () => {
    const base: Config = { models: ['m1'] };
    const withUnknown = { ...base, futureSecret: 'sk-live' } as unknown as Config;
    expect(configDigest(withUnknown)).toBe(configDigest(base));
    expect(JSON.stringify(configDigest(withUnknown))).not.toContain('sk-live');
    expect(configDigest({ ...base, gating: { minModels: 3 } })).not.toBe(configDigest(base));
  });

  it('detectRunner: CI wins over agent markers, blank values are unset, run id is optional', () => {
    expect(detectRunner({ GITHUB_ACTIONS: 'true', CLAUDECODE: '1' }, 'h')).toMatchObject({ kind: 'ci' });
    expect(detectRunner({ GITHUB_ACTIONS: 'true' }, 'h')).toEqual({ kind: 'ci', host: 'h' });
    expect(detectRunner({ GITHUB_ACTIONS: '   ', CLAUDECODE: ' ' }, 'h')).toEqual({ kind: 'human', host: 'h' });
    expect(detectRunner({ CURSOR_AGENT: '1', CLAUDECODE: '1' }, 'h').agent).toBe('claude-code');
  });

  it('validateSha accepts SHA-256 repository object ids (64 hex) and rejects 41–63', () => {
    expect(validateSha('F'.repeat(64), '--head-sha')).toBe('f'.repeat(64));
    expect(() => validateSha('f'.repeat(50), '--head-sha')).toThrow(/--head-sha/);
  });

  it('resolveConvergeContext rejects every non-positive-integer round shape with the flag name', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '1e400', '9007199254740993']) {
      expect(() => resolveConvergeContext({ convergeTarget: 't', round: bad }, {})).toThrow(/--round/);
    }
    // A blank flag is unset, so the environment still applies.
    expect(resolveConvergeContext({ convergeTarget: 't', round: '' }, { RCL_CONVERGE_ROUND: '4' })).toEqual({
      target: 't',
      round: 4,
    });
  });
});

describe('round-3 hardening', () => {
  it('records the effective plan focus for plan reviews and nothing for code reviews', () => {
    expect(buildRunHeader(baseInput())).not.toHaveProperty('plan');
    const run = buildRunHeader({ ...baseInput(), command: 'review-plan', plan: { focus: 'risks' } });
    expect(run.plan).toEqual({ focus: 'risks' });
  });

  it('diffDigest: stable for an empty list and sensitive to every recorded field', () => {
    expect(diffDigest([])).toBe(diffDigest([]));
    const base = file({ filename: 'a.ts', status: 'modified' });
    expect(diffDigest([{ ...base, status: 'added' }])).not.toBe(diffDigest([base]));
    expect(diffDigest([{ ...base, previousFilename: 'old.ts' }])).not.toBe(diffDigest([base]));
    expect(diffDigest([{ ...base, filename: 'b.ts' }])).not.toBe(diffDigest([base]));
  });
});

describe('round-4 hardening', () => {
  it('clamps duration_ms at zero when the clock runs backwards between start and finish', () => {
    const run = buildRunHeader({
      ...baseInput(),
      startedAt: new Date('2026-09-07T10:02:30.500Z'),
      finishedAt: new Date('2026-09-07T10:00:00.000Z'),
    });
    expect(run.duration_ms).toBe(0);
  });

  it('diffDigest equals the digest of the whole canonical array (streaming changes nothing)', async () => {
    const { stableStringify, sha256Hex } = await import('../../src/report/run-header.js');
    const files = [file({ filename: 'b.ts', patch: 'q' }), file({ filename: 'a.ts', status: 'renamed', previousFilename: 'z.ts' })];
    const canonical = [...files]
      .sort((x, y) => (x.filename < y.filename ? -1 : 1))
      .map((f) => ({
        filename: f.filename,
        status: f.status,
        previousFilename: f.previousFilename ?? null,
        patch: f.patch,
        additions: f.additions,
        deletions: f.deletions,
      }));
    expect(diffDigest(files)).toBe(sha256Hex(stableStringify(canonical)));
  });
});

describe('round-5 hardening', () => {
  function keysDeep(value: unknown, acc: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((v) => keysDeep(v, acc));
    else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        acc.push(k);
        keysDeep(v, acc);
      }
    }
    return acc;
  }

  it('wire contract: every key is snake_case, no undefined survives serialization, optional blocks are absent not null', () => {
    const full = buildRunHeader({
      ...baseInput(),
      spec: { source: 'flag', sha256: 'c'.repeat(64) },
      contextFiles: [{ path: 'x.md', sha256: 'd'.repeat(64) }],
      plan: { focus: 'risks' },
      converge: { target: 't', round: 1, attempt: 2 },
      runner: { kind: 'ci', ci_run_id: '9', host: 'h' },
    });
    const minimal = buildRunHeader({ ...baseInput(), target: { kind: 'patch' } });
    for (const header of [full, minimal]) {
      const json = JSON.stringify(header);
      expect(json).not.toContain('undefined');
      expect(json).not.toContain(':null');
      for (const key of keysDeep(JSON.parse(json))) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(minimal).not.toHaveProperty('spec');
    expect(minimal).not.toHaveProperty('plan');
    expect(minimal).not.toHaveProperty('converge');
    expect(Object.keys(minimal.target)).toEqual(['kind', 'diff_sha256', 'files', 'additions', 'deletions']);
  });

  it('copies roster, runner and converge so later mutation of the input cannot alter the header', () => {
    const input = { ...baseInput(), converge: { target: 't', round: 1 } };
    const run = buildRunHeader(input);
    input.roster[0]!.model = 'changed';
    Object.assign(input.runner, { kind: 'ci' });
    input.converge.round = 99;
    expect(run.roster[0]!.model).toBe('anthropic/claude-fable-5');
    expect(run.runner.kind).toBe('human');
    expect(run.converge!.round).toBe(1);
  });

  it('configDigest is independent of the GitHub token value', () => {
    const base: Config = { models: ['m1'], githubToken: 'ghp_A' };
    expect(configDigest(base)).toBe(configDigest({ ...base, githubToken: 'ghp_B' }));
    expect(configDigest(base)).toBe(configDigest({ models: ['m1'] }));
  });

  it('diffDigest distinguishes two patchless (binary) changes by their counts', () => {
    const a = file({ filename: 'app.bin', patch: '', additions: 0, deletions: 0 });
    const b = file({ filename: 'app.bin', patch: '', additions: 12, deletions: 3 });
    expect(diffDigest([a])).not.toBe(diffDigest([b]));
  });
});

describe('round-6 hardening', () => {
  it('validateSha trims whitespace, rejects off-by-one lengths and the null object id', () => {
    expect(validateSha(`  ${'a'.repeat(40)}\n`, '--head-sha')).toBe('a'.repeat(40));
    for (const len of [39, 41, 63, 65]) {
      expect(() => validateSha('a'.repeat(len), '--head-sha')).toThrow(/--head-sha/);
    }
    expect(() => validateSha('0'.repeat(40), '--head-sha')).toThrow(/null object id/);
    expect(() => validateSha('0'.repeat(64), '--expect-head-sha')).toThrow(/null object id/);
  });
});

describe('round-7 hardening', () => {
  it('detectRunner recognizes the common CI providers and the generic CI flag', () => {
    expect(detectRunner({ GITLAB_CI: 'true', CI_PIPELINE_ID: '77' }, 'h')).toEqual({ kind: 'ci', ci_run_id: '77', host: 'h' });
    expect(detectRunner({ CIRCLECI: 'true', CIRCLE_WORKFLOW_ID: 'w1' }, 'h')).toEqual({ kind: 'ci', ci_run_id: 'w1', host: 'h' });
    expect(detectRunner({ BUILDKITE: 'true', BUILDKITE_BUILD_ID: 'b1' }, 'h')).toEqual({ kind: 'ci', ci_run_id: 'b1', host: 'h' });
    expect(detectRunner({ JENKINS_URL: 'https://ci', BUILD_ID: '5' }, 'h')).toEqual({ kind: 'ci', ci_run_id: '5', host: 'h' });
    expect(detectRunner({ CI: 'true', CLAUDECODE: '1' }, 'h')).toEqual({ kind: 'ci', host: 'h' });
  });

  it('every ConfigSchema key is either digested or explicitly excluded', async () => {
    const { ConfigSchema } = await import('../../src/config/schema.js');
    const { DIGESTED_CONFIG_FIELDS, EXCLUDED_CONFIG_FIELDS } = await import('../../src/report/run-header.js');
    const decided = new Set<string>([...DIGESTED_CONFIG_FIELDS, ...EXCLUDED_CONFIG_FIELDS]);
    expect(Object.keys(ConfigSchema.shape).sort()).toEqual([...decided].sort());
    expect(EXCLUDED_CONFIG_FIELDS).toEqual(['githubToken']);
  });
});
