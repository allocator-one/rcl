import { retainedCycleFixture } from '../../fixtures/retained-cycle-content.js';
import { expect, it } from 'vitest';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { legacyFixture, semanticFixture } from './fixtures.js';
const { bundle: retained } = await retainedCycleFixture();
it('keeps the existing legacy-v1 and semantic-v2 content controls accepted', () => {
  expect(validateRetainedNativeEvidence(legacyFixture().input()).qualification).toBe('content-only');
  expect(validateRetainedNativeEvidence(semanticFixture().input()).qualification).toBe('content-only');
});
it('validates genuine current public cycle-v2 content without inventing semantic sightings', () => {
  const input = { sourceJson: retained.sourceJson, target: retained.target, reports: [] as string[] };
  const before = structuredClone(input);
  const state = JSON.parse(input.sourceJson);
  expect(state.version).toBe(2);
  expect(state).not.toHaveProperty('sightings');
  expect(verifyNativeRecoveryLineage(input.sourceJson, input.target).state).toEqual(state);
  const result = validateRetainedNativeEvidence(input);
  expect(result).toMatchObject({ qualification: 'content-only', state });
  expect(result.state.cycle).toEqual(state.cycle);
  expect(result.state.roundCap).toBe(15);
  expect(result.state.rounds).toEqual(state.rounds);
  expect(result.state).not.toHaveProperty('sightings');
  expect(input).toEqual(before);
});
it('still refuses malformed cycle identity before content qualification', () => {
  const state = JSON.parse(retained.sourceJson); state.cycle.id = 'not-a-uuid';
  expect(() => validateRetainedNativeEvidence({sourceJson:JSON.stringify(state),target:retained.target,reports:[]})).toThrow();
});
