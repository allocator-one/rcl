import type { ConsensusFinding, ModelReview, ReviewResult } from '../../src/consensus/types.js';
import type { RunHeader } from '../../src/report/run-header.js';

/** A finished review with a self-describing header, small enough to assert field by field. */
export function sampleRunHeader(overrides: Partial<RunHeader> = {}): RunHeader {
  return {
    id: '019921a0-0000-7000-8000-000000000001',
    rcl_version: '3.0.0',
    command: 'review',
    target: {
      kind: 'pr',
      repo: 'allocator-one/rcl',
      pr_number: 42,
      url: 'https://github.com/allocator-one/rcl/pull/42',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      head_ref: 'feature',
      base_ref: 'main',
      diff_sha256: 'd'.repeat(64),
      files: 3,
      additions: 40,
      deletions: 5,
    },
    roster: [
      { model: 'anthropic/claude', role: 'bug-hunter', provider: 'anthropic', lane: 'blocking' },
      { model: 'openai/gpt', role: 'security-auditor', provider: 'openai', lane: 'secondary' },
    ],
    config_sha256: 'c'.repeat(64),
    thresholds: { min_consensus_score: 0.5, min_confidence: 0.4, dedupe_line_window: 10, jaccard_threshold: 0.3 },
    gating: { mode: 'verified-consensus', min_models: 2, verification_timeout_ms: 60_000 },
    context_files: [],
    runner: { kind: 'agent', agent: 'claude-code', host: 'mbp' },
    started_at: '2026-09-07T08:44:38.000Z',
    finished_at: '2026-09-07T08:55:51.000Z',
    duration_ms: 673_000,
    ci_exit_code: 1,
    ...overrides,
  };
}

export function sampleFinding(overrides: Partial<ConsensusFinding> = {}): ConsensusFinding {
  return {
    id: 'F1',
    file: 'lib/foo.ex',
    startLine: 10,
    endLine: 12,
    severity: 'important',
    category: 'correctness',
    title: 'Pagination misses tiebreak',
    description: 'Ordering by inserted_at alone is unstable.',
    suggestedFix: 'Add id as a tiebreak.',
    identity: 'abc123def4567890',
    consensus: {
      score: 0.66,
      total: 3,
      models: ['anthropic/claude', 'openai/gpt'],
      roles: ['bug-hunter'],
      crossRole: false,
      crossModel: true,
      elevated: false,
      elevation: 'none',
      confidence: 0.8,
      confidenceLabel: 'High',
      tier: 'majority',
    },
    gating: { reason: 'consensus' },
    ...overrides,
  };
}

export function sampleReview(overrides: Partial<ModelReview> = {}): ModelReview {
  return {
    model: 'anthropic/claude',
    role: 'bug-hunter',
    provider: 'anthropic',
    findings: [],
    durationMs: 12_345.6,
    usage: { inputTokens: 27_514, outputTokens: 900, reasoningTokens: 300 },
    status: 'success',
    ...overrides,
  };
}

export function sampleResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    run: sampleRunHeader(),
    reviews: [
      sampleReview(),
      sampleReview({
        model: 'openai/gpt',
        role: 'security-auditor',
        provider: 'openai',
        status: 'parse_failed',
        error: 'JSON parse error at position 12\n```json\n{"leaked": "sk-ant-abcdefghijklmnopqrstu"}\n```',
        droppedFindings: 1,
        warnings: ['schema salvaged 3 findings'],
      }),
    ],
    findings: [sampleFinding()],
    belowThresholdFindings: [
      sampleFinding({ id: 'F2', identity: 'fedcba9876543210', severity: 'minor', title: 'Naming', gating: { reason: 'none' } }),
    ],
    stats: {
      totalReviews: 2,
      successfulReviews: 1,
      totalRawFindings: 3,
      totalDeduped: 2,
      belowThreshold: 1,
      durationMs: 673_000,
    },
    ...overrides,
  };
}

/** A fetch double: the handler decides status and body per request. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export function fakeFetch(
  handler: (request: RecordedRequest) => { status: number; body?: unknown } | Error
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    requests.push(request);
    const outcome = handler(request);
    if (outcome instanceof Error) throw outcome;
    return new Response(outcome.body === undefined ? '' : JSON.stringify(outcome.body), { status: outcome.status });
  }) as typeof fetch;
  return { fetch: impl, requests };
}
