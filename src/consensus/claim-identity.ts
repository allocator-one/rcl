import { createHash } from 'node:crypto';
import type { Finding } from './types.js';
import { normalizeGeneratedText, scrubText } from '../telemetry/scrub.js';
import { claimDescriptorSchema, type ClaimDescriptor } from '../evidence/claim-recovery/validation/claims.js';
import { describeContract } from './claim-contract.js';
export { claimDescriptorSchema, descriptorKey, semanticFindingKey, compareClaims } from '../evidence/claim-recovery/validation/claims.js';
export type { ClaimDescriptor, MatchRationale } from '../evidence/claim-recovery/validation/claims.js';

/** Do this before report serialization, never while replaying an original. */
function clean(s: string): string {
  return normalizeGeneratedText(s).trim();
}
function bounded(s: string): string {
  const value = clean(scrubText(clean(s), Math.max(500, [...s].length + 1)));
  const points = [...value];
  if (points.length <= 500) return value;
  // Retain a commitment to the omitted text. Two long claims must not become
  // identical merely because their first 500 code points agree.
  const suffix = ` [sha256:${createHash('sha256').update(value).digest('hex')}]`;
  return points.slice(0, 500 - suffix.length).join('') + suffix;
}
function anchors(s: string): string[] {
  return [...new Set([...s.matchAll(/`([^`]+)`|\b([A-Za-z_$][\w.$]*(?:\/\d+|(?=\()))/g)]
    .map(m => m[1] ?? m[2]!))].sort();
}
export function describeClaim(finding: Pick<Finding, 'file' | 'title' | 'description' | 'suggestedFix'>): ClaimDescriptor {
  const contract = describeContract(finding);
  if (contract) return claimDescriptorSchema.parse({ ...contract, operation: bounded(contract.operation),
    invariant: bounded(contract.invariant), evidence: contract.evidence.map(bounded) });
  const symbols = anchors(`${finding.title} ${finding.description}`);
  const operation = symbols.length ? `${finding.file} :: ${symbols.join(', ')}` : `${finding.file} :: ${finding.title}`;
  const invariant = bounded(finding.description) || bounded(finding.title) || '[insufficient-evidence: no reviewer invariant]';
  const evidence = [...new Set([bounded(finding.title), bounded(finding.description), bounded(finding.suggestedFix ?? '')].filter(Boolean))];
  return claimDescriptorSchema.parse({ version: 1, operation: bounded(operation), invariant, evidence: evidence.length ? evidence : [invariant] });
}
