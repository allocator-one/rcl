import { readTextFixture } from '../support/text-fixture.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectReviewerArtifact, serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { buildRunEnvelope, declareReviewerRecovery } from '../../src/telemetry/envelope.js';
import { validateRunEnvelope } from '../../src/telemetry/envelope-validation.js';

let entries: ReturnType<typeof inspectReviewerArtifact>[];
beforeAll(() => {
  const fixture = JSON.parse(readTextFixture(new URL('../fixtures/reviewer-artifact-lineage.json', import.meta.url)));
  entries = fixture.rows.map((row: { artifact_bytes: string; expectations: Parameters<typeof inspectReviewerArtifact>[1] }) =>
    inspectReviewerArtifact(row.artifact_bytes, row.expectations));
});

function delivery(index: number) {
  const entry = entries[index]!;
  const report = JSON.parse(entry.reportBytes);
  report.run.reviewer_evidence = entry.descriptor;
  const reportBytes = JSON.stringify(report);
  const artifact = serializeReviewerArtifact({ assembly: entry.assembly, reportBytes, representation: entry.representation });
  const parent = entries[index - 1];
  const declaration = declareReviewerRecovery({ artifact, descriptor: entry.descriptor,
    ...(parent === undefined ? {} : { source: {
      run_id: parent.runId, report_sha256: parent.reportSha256, reviewer_artifact_sha256: parent.artifact.digest,
    } }),
  });
  const artifacts = { report_json: reportBytes, report_md: '# Exact synthetic report\n' };
  const options = { level: 'full', delivery: { mode: 'direct' } } as const;
  const ordinary = buildRunEnvelope(report, artifacts, options);
  const marked = buildRunEnvelope(report, artifacts, { ...options, reviewerRecovery: declaration });
  return { entry, report, reportBytes, artifacts, declaration, ordinary, marked };
}

describe('private reviewer call accounting boundary', () => {
  it.each([
    ['original with an unstarted seat', 0, 2],
    ['successor retaining original successes', 1, 1],
    ['later successor retaining both predecessors', 2, 2],
  ] as const)('stages no call rows for an %s without rewriting its report', (_name, index, currentIntents) => {
    const { entry, report, reportBytes, artifacts, declaration, ordinary, marked } = delivery(index);
    // These are real inspected checkpoint artifacts: merged report reviews are
    // not the current run's physical calls, even in the original run.
    expect(report.reviews).toHaveLength(3);
    expect(entry.assembly.projection.newPhysicalAttempts).toHaveLength(currentIntents);
    expect(ordinary.calls).toHaveLength(3);
    expect(marked.calls).toEqual([]);
    expect(marked).toEqual({ ...ordinary, calls: [], reviewer_recovery: declaration });
    expect(marked.stats).toEqual(report.stats);
    expect(marked.artifacts_declared).toEqual(ordinary.artifacts_declared);
    expect(artifacts.report_json).toBe(reportBytes);
    expect(JSON.stringify(report)).toBe(reportBytes);
    expect(validateRunEnvelope(marked, artifacts)).toEqual([]);
  });

  it('refuses merged or physical-looking call rows in marked envelopes before delivery', () => {
    for (const index of [0, 1]) {
      const { marked, ordinary, artifacts } = delivery(index);
      const staged = { ...marked, calls: [] };
      expect(validateRunEnvelope(staged, artifacts)).toEqual([]);
      // Even a plausible single call cannot be accepted from this untrusted
      // envelope. The server derives physical rows from the private proof.
      for (const calls of [ordinary.calls, ordinary.calls.slice(0, 1)]) {
        const supplied = { ...staged, calls };
        expect(validateRunEnvelope(supplied, artifacts)).toContainEqual({
          path: 'calls', message: 'Reviewer recovery calls are derived from the private artifact',
        });
        expect(supplied.calls).toEqual(calls);
      }
    }
  });
});
