import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as artifacts from '../../src/report/reviewer-artifact.js';
import { describeReviewerEvidence, inspectReviewerEvidenceReport, validateReviewerReportChain } from '../../src/report/reviewer-evidence.js';
import { stableStringify } from '../../src/report/run-header.js';
import { reviewerEvidenceDescriptorSchema } from '../../src/report/reviewer-evidence-schema.js';
import { buildRunEnvelope, declareReviewerRecovery } from '../../src/telemetry/envelope.js';
import { validateRunEnvelope } from '../../src/telemetry/envelope-validation.js';

const fixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../fixtures/reviewer-artifact-lineage.json', import.meta.url)), 'utf8'));
const separate = (): ReturnType<typeof artifacts.inspectReviewerArtifact>[] => fixture.rows.map((row: any) => artifacts.inspectReviewerArtifact(row.artifact_bytes, row.expectations));
const context = (entry: ReturnType<typeof artifacts.inspectReviewerArtifact>) => ({ assembly: entry.assembly, reportBytes: entry.reportBytes, representation: entry.representation });

describe('separate ordinary artifact lineage', () => {
  it('serializes and inspects complete genuine separate pairs including the exact current ordinary report', () => {
    const entries = separate();
    const completed: ReturnType<typeof artifacts.inspectReviewerArtifact>[] = [];
    for (const [index, entry] of entries.entries()) {
      const lineage = [...completed, entry];
      const artifact = artifacts.serializeReviewerArtifact({ ...context(entry), lineage });
      const wire = JSON.parse(artifact.bytes);
      expect(wire.lineage).toEqual(lineage.map(item => ({ runId: item.runId, reportSha256: item.reportSha256, checkpointSha256: item.proof.digest })));
      expect(wire.lineage.at(-1).reportSha256).toBe(wire.report.sha256);
      const inspected = artifacts.inspectReviewerArtifact(artifact.bytes, { ...fixture.rows[index].expectations, lineage });
      expect(inspected.reportBytes).toBe(entry.reportBytes);
      expect(inspected.proof.bytes).toBe(entry.proof.bytes);
      completed.push(inspected);
    }
  });

  it('refuses forged or cloned separate pairs while retaining the legacy inline brand boundary', () => {
    const [entry] = separate();
    expect(() => artifacts.serializeReviewerArtifact({ ...context(entry), lineage: [structuredClone(entry)] })).toThrow('reviewer_report_not_inspected');
    expect(() => validateReviewerReportChain([entry])).toThrow('reviewer_report_not_inspected');
    expect(artifacts.isInspectedReviewerArtifact(entry)).toBe(true);
    expect(artifacts.isInspectedReviewerArtifact(structuredClone(entry))).toBe(false);
  });

  it('refuses a genuine legacy inline report whose hash differs from the ordinary current report', () => {
    const [entry] = separate();
    const inline = JSON.parse(entry.reportBytes);
    inline.run.reviewer_evidence = describeReviewerEvidence(entry.proof, entry.supplementalAsync);
    inline.reviewerEvidence = { checkpoint: entry.proof.bytes, supplemental_async: entry.supplementalAsync.bytes };
    const branded = inspectReviewerEvidenceReport(JSON.stringify(inline), fixture.rows[0].expectations.expectedPlan, entry.prTarget);
    expect(validateReviewerReportChain([branded])).toHaveLength(1);
    expect(branded.reportSha256).not.toBe(entry.reportSha256);
    expect(() => artifacts.serializeReviewerArtifact({ ...context(entry), lineage: [branded] })).toThrow('reviewer_artifact_lineage_report_mismatch');
  });

  it('refuses omitted, reordered, forged and shortened uploaded lineage references', () => {
    const entries = separate(), last = entries.at(-1)!;
    const artifact = artifacts.serializeReviewerArtifact({ ...context(last), lineage: entries });
    const wire = JSON.parse(artifact.bytes);
    const expected = { ...fixture.rows.at(-1).expectations, lineage: entries };
    for (const lineage of [[], wire.lineage.slice(1), wire.lineage.slice(0, -1), [...wire.lineage].reverse(),
      wire.lineage.map((row: any, index: number) => index === 0 ? { ...row, reportSha256: '0'.repeat(64) } : row)]) {
      expect(() => artifacts.inspectReviewerArtifact(stableStringify({ ...wire, lineage }), expected)).toThrow();
    }
    expect(() => artifacts.serializeReviewerArtifact({ ...context(last), lineage: entries.slice(1) })).toThrow();
  });

  it('reopens from only persisted complete artifacts in a fresh process', () => {
    const originals = separate();
    const rows = originals.map((entry, index) => ({
      bytes: artifacts.serializeReviewerArtifact({ ...context(entry), lineage: originals.slice(0, index + 1) }).bytes,
      options: fixture.rows[index].expectations,
    }));
    const script = `import fs from 'node:fs';
      import { inspectReviewerArtifact, isInspectedReviewerArtifact } from './src/report/reviewer-artifact.ts';
      const rows = JSON.parse(fs.readFileSync(0, 'utf8')), ancestors = [], output = [];
      for (const row of rows) {
        const current = inspectReviewerArtifact(row.bytes, { ...row.options, ancestors });
        if (!isInspectedReviewerArtifact(current) || current.artifact.bytes !== row.bytes) throw new Error('unbound_current');
        output.push(current.reportSha256); ancestors.push(current);
      }
      console.log(JSON.stringify(output));`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify(rows), env: Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(originals.map(entry => entry.reportSha256));
  });

  it('refuses forged, reordered and self ancestors and contradictory lineage inputs', () => {
    const entries = separate(), last = entries.at(-1)!;
    const bytes = artifacts.serializeReviewerArtifact({ ...context(last), lineage: entries }).bytes;
    const options = fixture.rows.at(-1).expectations;
    for (const ancestors of [[structuredClone(entries[0])], entries, [...entries.slice(0, -1)].reverse(), []]) {
      expect(() => artifacts.inspectReviewerArtifact(bytes, { ...options, ancestors })).toThrow();
    }
    expect(() => artifacts.inspectReviewerArtifact(bytes, { ...options, ancestors: entries.slice(0, -1), lineage: entries })).toThrow();
  });

  it('preserves exact empty-lineage serialization bytes', () => {
    for (const [index, entry] of separate().entries()) {
      expect(artifacts.serializeReviewerArtifact(context(entry)).bytes).toBe(fixture.rows[index].artifact_bytes);
    }
  });
});


function supplementedDeclaration() {
  const [source, current] = separate();
  const report = JSON.parse(current.reportBytes);
  report.run.reviewer_evidence = current.descriptor;
  const reportBytes = JSON.stringify(report);
  const privateArtifact = artifacts.serializeReviewerArtifact({ ...context(current), reportBytes });
  const inspected = artifacts.inspectReviewerArtifact(privateArtifact.bytes, {
    ...fixture.rows[1].expectations, expectedReportBytes: reportBytes,
  });
  const input = { artifact: privateArtifact, descriptor: inspected.descriptor, source: {
    run_id: source.runId, report_sha256: source.reportSha256, reviewer_artifact_sha256: source.artifact.digest,
  } };
  const declaration = declareReviewerRecovery(input);
  const reportArtifacts = { report_json: reportBytes };
  const envelope = buildRunEnvelope(report, reportArtifacts, {
    level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration,
  });
  expect(validateRunEnvelope(envelope, reportArtifacts)).toEqual([]);
  return { input, envelope, reportArtifacts, originalDescriptor: source.descriptor };
}

describe('reviewer recovery declaration boundaries', () => {
  it.each([
    ['exact UUID', 'abcdefab-0000-4000-8000-000000000101', 'abcdefab-0000-4000-8000-000000000101'],
    ['UUID case alias', 'abcdefab-0000-4000-8000-000000000101', 'ABCDEFAB-0000-4000-8000-000000000101'],
  ])('refuses self-source with an %s even when both source copies match', (_label, currentId, sourceId) => {
    const { envelope, reportArtifacts } = supplementedDeclaration();
    const altered = structuredClone(envelope) as any;
    altered.run.id = currentId;
    altered.reviewer_recovery.source.run_id = sourceId;
    altered.reviewer_recovery.descriptor.source.run_id = sourceId;
    altered.run.reviewer_evidence = structuredClone(altered.reviewer_recovery.descriptor);
    expect(validateRunEnvelope(altered, reportArtifacts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'reviewer_recovery.source.run_id' }),
    ]));
  });

  it('rejects trailing line terminators in every descriptor hash and UUID field', () => {
    const { input, originalDescriptor } = supplementedDeclaration();
    const descriptors = [originalDescriptor, input.descriptor];
    for (const descriptor of descriptors) {
      expect(reviewerEvidenceDescriptorSchema.safeParse(descriptor).success).toBe(true);
      const fields = Object.keys(descriptor).filter(key => key.endsWith('_sha256') || key === 'operation_id')
        .map(key => [key]);
      if (descriptor.kind === 'supplemented') fields.push(...Object.keys(descriptor.source).map(key => ['source', key]));
      for (const path of fields) for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
        const altered = structuredClone(descriptor) as any;
        const parent = path.length === 1 ? altered : altered[path[0]!];
        const key = path.at(-1)!;
        parent[key] += suffix;
        expect(reviewerEvidenceDescriptorSchema.safeParse(altered).success, `${path.join('.')} ${JSON.stringify(suffix)}`).toBe(false);
      }
    }
  });

  it('rejects trailing line terminators in declaration-builder digest and source checks', () => {
    const { input } = supplementedDeclaration();
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      expect(() => declareReviewerRecovery({ ...input, artifact: { ...input.artifact, digest: input.artifact.digest + suffix } }))
        .toThrow('reviewer_recovery_invalid_artifact');
      for (const key of ['run_id', 'report_sha256', 'reviewer_artifact_sha256'] as const) {
        const altered = structuredClone(input);
        altered.source[key] += suffix;
        if (key !== 'reviewer_artifact_sha256' && altered.descriptor.kind === 'supplemented') {
          altered.descriptor.source[key] = altered.source[key];
        }
        expect(() => declareReviewerRecovery(altered)).toThrow('reviewer_recovery_source_mismatch');
      }
    }
  });
});
