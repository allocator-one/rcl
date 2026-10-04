import { expect, it } from 'vitest';
import { validateRetainedNativeEvidence } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { verifyNativeRecoveryLineage } from '../../../src/converge/recovery-state.js';
import { legacyFixture } from './fixtures.js';

it.each(['retained-content', 'native-lineage'])('validates legacy verdict severity at the %s boundary', boundary => {
  const f = legacyFixture();
  const entry = f.state.findings[f.key];
  entry.verdict = 'dismissed'; entry.verdictRound = 1;
  const validate = () => boundary === 'retained-content'
    ? validateRetainedNativeEvidence(f.input())
    : verifyNativeRecoveryLineage(JSON.stringify(f.state), f.state.target);

  // Old snapshots may omit this optional field; a supplied severity must be
  // from the supported vocabulary before obligation logic can consume it.
  expect(validate).not.toThrow();
  entry.verdictSeverity = 'important'; expect(validate).not.toThrow();
  entry.verdictSeverity = 'unknown-severity'; expect(validate).toThrow();
});
