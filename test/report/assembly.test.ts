import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateCiGate } from '../../src/ci.js';
import type { ModelReview } from '../../src/consensus/types.js';
import type { AskFn, VerificationProgress } from '../../src/consensus/gating.js';
import type { Diff } from '../../src/resolver/types.js';
import type { Role } from '../../src/roles/types.js';
import { assembleCompletedReview } from '../../src/report/assembly.js';
import { renderReportArtifacts, writeReportArtifacts } from '../../src/output/artifacts.js';
import { parseSource } from '../../src/telemetry/recovery/source.js';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('completed council terminal artifacts', () => {
  it('retains a modern report after 153 completed calls, one reviewer error, and a non-cooperative verifier deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rcl-terminal-regression-'));
    directories.push(directory);
    await writeFile(join(directory, 'SYNTHETIC_TEST_ONLY'), 'RCL-85 deterministic regression');
    const runId = '019921a0-0000-7000-8000-000000000085';
    const role: Role = { name: 'general', systemPrompt: '', description: '', focus: [], isSpecialized: false };
    const diff: Diff = {
      source: 'local',
      files: Array.from({ length: 32 }, (_, i) => ({
        filename: `src/candidate-${i}.ts`, status: 'modified', language: 'typescript',
        additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-guard();\n+execute();',
      })),
    };
    const chunkReviews: ModelReview[] = Array.from({ length: 153 }, (_, i) => ({
      model: i === 152 ? 'openai/failed-reviewer' : `openai/reviewer-${i % 16}`,
      role: role.name, provider: 'openai', durationMs: 20,
      status: i === 152 ? 'error' : 'success',
      ...(i === 152 ? { error: 'Synthetic reviewer connection reset' } : {}),
      findings: i < 32 ? [{
        id: `raw-${i}`, file: diff.files[i]!.filename, startLine: 1, endLine: 1,
        title: `Missing guard in candidate ${i}`, description: 'Execution bypasses the required guard.',
        severity: 'important', category: 'correctness',
      }] : [],
    }));
    const retainedInputs = structuredClone(chunkReviews);
    const warnings: string[] = [];
    const stages: string[] = [];
    const progress: VerificationProgress[] = [];
    const ask = vi.fn<AskFn>(() => new Promise(() => {
      // Deliberately ignores abort: the production pass must stop waiting.
    }));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
    const startTime = Date.now();
    let completed = false;
    const assembly = assembleCompletedReview({
      chunkReviews, arrivedAsync: [], asyncLaunched: 0, startTime,
      roleMap: new Map([[role.name, role]]), diff,
      config: { thresholds: { minConfidence: 0, minConsensusScore: 0 } },
      gatingConfig: {
        mode: 'verified-consensus', minModels: 2, verificationModel: 'openai/synthetic-verifier',
        verificationTimeoutMs: 60_000, verificationPassTimeoutMs: 100,
      },
      run: {
        id: runId, rclVersion: '3.8.2', command: 'review',
        target: { kind: 'patch', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
        roster: [...new Set(chunkReviews.map((review) => review.model))].map((model) => ({
          model, role: role.name, provider: 'openai', lane: 'blocking',
        })),
        runner: { kind: 'agent', agent: 'synthetic-regression' }, startedAt: new Date(startTime),
        converge: { target: 'synthetic-rcl-85', round: 20, attempt: 20 },
      },
    }, {
      ask, monotonicNow: () => Date.now() - startTime,
      onVerificationProgress: (event) => progress.push(event),
      onStage: (stage) => stages.push(stage), onWarning: (warning) => warnings.push(warning),
    }).then((result) => { completed = true; return result; });

    await vi.advanceTimersByTimeAsync(99);
    expect(completed).toBe(false);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(progress[0]).toEqual({ completedBatches: 0, totalBatches: 4, completedCandidates: 0, totalCandidates: 32 });
    await vi.advanceTimersByTimeAsync(1);
    expect(completed, 'terminal assembly must finish at the whole-pass deadline').toBe(true);
    const result = await assembly;
    expect(ask).toHaveBeenCalledTimes(3); // The queued fourth batch never launches.
    expect(ask.mock.calls.every((call) => call[3].timeoutMs <= 100 && call[3].signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(chunkReviews).toEqual(retainedInputs);
    expect(result.run).toMatchObject({
      id: runId, ci_exit_code: 1, duration_ms: 100,
      gating: { verification_pass_timeout_ms: 100 },
      converge: { target: 'synthetic-rcl-85', round: 20, attempt: 20 },
    });
    expect(result.stats).toMatchObject({ totalReviews: 17, successfulReviews: 16, totalRawFindings: 32, totalDeduped: 32 });
    expect(result.findings).toHaveLength(32);
    expect(result.findings.every((finding) => finding.gating === undefined && finding.consensus.models.length === 1)).toBe(true);
    expect(evaluateCiGate(result).exitCode).toBe(1);
    expect(warnings).toEqual([expect.stringMatching(/Gating pass failed .*VerificationPassTimeoutError:.*100ms.*severity gating/)]);
    expect(stages).toEqual(['computing consensus', 'assembling the terminal report']);
    vi.useRealTimers();

    // Use exactly the renderer and two-file writer called by executeCouncil.
    const artifacts = renderReportArtifacts(result);
    const jsonFile = join(directory, 'report.json');
    const markdown = join(directory, 'report.md');
    const outputDiagnostics = await writeReportArtifacts(artifacts, { jsonFile, markdown });
    expect(outputDiagnostics).toEqual([]);
    const json = await readFile(jsonFile, 'utf8');
    const md = await readFile(markdown, 'utf8');
    expect(json).toBe(artifacts.report_json);
    expect(md).toBe(artifacts.report_md);
    const retained = parseSource(json);
    expect(retained.format).toBe('modern');
    if (retained.format !== 'modern') throw new Error('Expected a modern retained report');
    expect(retained.report.run.id).toBe(runId);
    expect(md).toContain(runId);
    expect(retained.report.findings).toHaveLength(32);
    expect(retained.report.reviews.filter((review) => review.status !== 'success')).toEqual([
      expect.objectContaining({ model: 'openai/failed-reviewer', status: 'error', error: 'Synthetic reviewer connection reset' }),
    ]);
    expect(retained.report.reviews.some((review) => review.status === 'parse_failed')).toBe(false);
    expect(retained.refutations).toEqual([]);

    // A later requested output failure is separately diagnosed and still
    // attempts the sibling; it cannot erase the already retained originals.
    const sibling = join(directory, 'sibling.md');
    const failedOutputs = await writeReportArtifacts(artifacts, {
      jsonFile: join(directory, 'missing', 'report.json'), markdown: sibling,
    });
    expect(failedOutputs).toEqual([
      { path: 'output.report_json', message: expect.stringMatching(/Could not write JSON:.*ENOENT/) },
    ]);
    expect(await readFile(sibling, 'utf8')).toBe(md);
    expect(await readFile(jsonFile, 'utf8')).toBe(json);
    expect(await readFile(markdown, 'utf8')).toBe(md);
  });
});
