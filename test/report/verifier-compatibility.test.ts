import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planGatingForCapturedContract } from '../../src/consensus/gating.js';
import { inspectReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { snapshotVerificationEvent } from '../../src/dispatch/checkpoint-verification.js';
import { stableStringify } from '../../src/report/run-header.js';
import { decodeCapturedInputs } from '../../src/dispatch/captured-inputs.js';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-verifier-v1.json', import.meta.url), 'utf8'));

describe('captured verifier protocol compatibility', () => {
  it('reopens exact qualified legacy report and sealed verifier bytes without selecting current defaults', () => {
    const before = JSON.stringify(legacy);
    const inspected = inspectReviewerArtifact(legacy.artifactBytes, legacy.expectations);
    expect(inspected.reportBytes).toBe(legacy.expectations.expectedReportBytes);
    expect(inspected.captured.bytes).toBe(legacy.capturedBytes);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(decodeCapturedInputs(legacy.capturedBytes, legacy.expectations.expectedPlan).aggregation?.bytes)
      .not.toContain('verifierContractVersion');
  });
});


it('refuses impossible per-version saved verifier request shapes', () => {
  const saved = JSON.parse(legacy.verificationProof.bytes).records[0].event.plan;
  const historical = JSON.parse(saved.gatingPlanBytes);
  expect(snapshotVerificationEvent({type:'plan',plan:saved})).toBeDefined();
  for (const kind of ['v1 effort','v1 evidence','v2 missing evidence']) {
    const plan = structuredClone(historical);
    if(kind === 'v1 effort') plan.verificationReasoningEffort = 'high';
    if(kind === 'v1 evidence') plan.batches[0].sourcePatches = {};
    if(kind === 'v2 missing evidence') plan.version = 2;
    expect(() => snapshotVerificationEvent({type:'plan',plan:{...saved,gatingPlanBytes:stableStringify(plan)}}))
      .toThrow('checkpoint_verification_invalid_gating_plan');
  }
});


const legacyPlannerCases=JSON.parse(readFileSync(new URL('../fixtures/legacy-verifier-planner.json',import.meta.url),'utf8'));
it.each(legacyPlannerCases)('preserves exact C6 planner bytes for $name input', (row:any)=>{
  expect(stableStringify(planGatingForCapturedContract(row.findings,row.options,1))).toBe(stableStringify(row.expectedPlan));
});
