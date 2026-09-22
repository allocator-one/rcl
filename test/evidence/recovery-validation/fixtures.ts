import { createHash } from 'node:crypto';
import { semanticFindingKey, type ClaimDescriptor } from '../../../src/evidence/claim-recovery/validation/claims.js';
import { correctionAnchor } from '../../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimSplit, type ClaimSplitInput } from '../../../src/evidence/claim-recovery/validation/claim-split.js';

export const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
export const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const target = 'synthetic-retained-target';
export const descriptor: ClaimDescriptor = {
  version: 1, operation: 'cache.ts :: cache.read',
  invariant: 'The cache returns expired entries without checking their expiry timestamp.',
  evidence: ['Check the expiry timestamp before returning a cached result.'],
};
export function semanticFixture() {
  const runId = uuid(1); const key = semanticFindingKey('cache.ts', 'correctness', descriptor);
  const finding = { id: 'reviewer-original', identity: `report:${runId}:original`, file: 'cache.ts', category: 'correctness',
    startLine: 10, endLine: 12, title: 'Expired cache entries', description: descriptor.invariant,
    severity: 'important', claimDescriptor: structuredClone(descriptor), gating: { reason: 'consensus' },
    consensus: { models: ['synthetic-a', 'synthetic-b'] } };
  const report = { run: { id: runId, converge: { target, round: 1 },
    target: { kind: 'pr', repo: 'synthetic/recovery', pr_number: 7, head_sha: 'a'.repeat(40) } },
    findings: [finding], belowThresholdFindings: [] };
  const reportJson = JSON.stringify(report); const digest = sha(reportJson);
  const binding = { runId, target, round: 1, reportSha256: digest, sourcePath: `/synthetic/native.evidence/${digest}.json` };
  const state = { version: 2, target, roundCap: 15, updatedAt: '2026-09-22T00:00:00.000Z',
    rounds: [{ round: 1, runId, reportBinding: binding, counts: { new: 1, repeat: 0, suppressed: 0, regating: 0 }, severities: { [key]: 'important' } }],
    findings: { [key]: { key, file: finding.file, category: finding.category, startLine: 10, endLine: 12,
      title: finding.title, severity: finding.severity, models: finding.consensus.models,
      firstRound: 1, lastRound: 1, claimDescriptor: structuredClone(descriptor), pendingRound: 1 } },
    sightings: [{ ...binding, findingRef: 'f001', reportKey: finding.identity, canonicalIdentity: key,
      claimDescriptor: structuredClone(descriptor), matchRationale: 'new_claim', status: 'new', pendingRound: 1,
      severity: finding.severity, gating: 'consensus', belowThreshold: false,
      file: finding.file, category: finding.category, startLine: 10, endLine: 12 }],
    lastAnnotations: { round: 1, identities: [{ identity: key, status: 'new', gating: 'consensus' }] } };
  // sourcePath is a report binding, not a producer sighting field.
  delete (state.sightings[0] as Partial<typeof binding>).sourcePath;
  return { state, report, reportJson, key, input: () => ({ sourceJson: JSON.stringify(state), target, reports: [reportJson] }) };
}
export function legacyFixture() {
  const f = semanticFixture();
  const state = { ...f.state, version: 1, findings: { [f.key]: { ...f.state.findings[f.key]! } } } as Record<string, any>;
  delete state.sightings; delete state.findings[f.key].claimDescriptor; delete state.findings[f.key].pendingRound;
  delete state.rounds[0].reportBinding;
  return { state, key: f.key, report: f.report, reportJson: f.reportJson,
    input: () => ({ sourceJson: JSON.stringify(state), target, reports: [] as string[] }) };
}

export function recoveredFixture(version: 1 | 2 = 1) {
  const f = version === 1 ? legacyFixture() : semanticFixture();
  const sourceJson = JSON.stringify(f.state);
  const selection: ClaimSplitInput = {
    scope: { base_url: 'https://synthetic.example.test', org_id: uuid(2), run_id: uuid(1), repo: 'synthetic/recovery', pr_number: 7 },
    target, eventId: uuid(3), occurredAt: '2026-09-22T12:00:00.123456Z', nativeJson: sourceJson,
    reportJson: f.reportJson, findingRef: 'f001', previousIdentity: f.key, identity: '2222222222222222',
    descriptor: structuredClone(descriptor), reason: 'Independent retained claim.', expectedEventSequence: 7,
    classificationId: uuid(4), sourceReceipts: [{ id: uuid(4), org_id: uuid(2), run_id: uuid(1),
      repo: 'synthetic/recovery', pr_number: 7, actor_user_id: uuid(5), kind: 'round_processed',
      converge_target: target, round: 1, attempt: 1, occurred_at: '2026-09-22T11:00:00.123456Z',
      payload: { identities: [{ identity_key: f.report.findings[0]!.identity, matched_identity: f.key, status: 'new' }] } }],
  };
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), converge_target: target, round: 1, attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
  const state = { ...f.state, version: 3, sightings: 'sightings' in f.state ? f.state.sightings : [],
    recovery: { version: 1, operations: [{ operationId: uuid(8), sourceVersion: version, sourceSha256: sha(sourceJson),
      anchors: [anchor], sourceReceipts: selection.sourceReceipts }] } };
  return { ...f, sourceJson, selection, state, anchor,
    input: () => ({ sourceJson: JSON.stringify(state), target, reports: [f.reportJson], nativeSourceJsons: [sourceJson] }) };
}
