// Recovery-only validation extracted from ff36a93; no descriptor generation or producer matching.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Finding } from '../../../consensus/types.js';
import { hasOpposingSentiment, jaccardSimilarity, tokenize } from './lexical.js';

/** Wire version, independent of native state and matching algorithm versions. */
export interface ClaimDescriptor {
  version: 1;
  operation: string;
  invariant: string;
  evidence: string[];
}
export type MatchRationale = 'new_claim' | 'exact_descriptor' | 'supported_paraphrase' | 'ambiguous' | 'explicit_split';

const descriptorText = z.string().refine((s) => s.trim().length > 0 && [...s].length <= 500 &&
  Buffer.byteLength(s, 'utf8') <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) &&
  !/[\uD800-\uDFFF]/u.test(s), 'Invalid claim descriptor text');
export const claimDescriptorSchema = z.object({ version: z.literal(1), operation: descriptorText,
  invariant: descriptorText, evidence: z.array(descriptorText).min(1).max(20) }).strict();

function anchors(s: string): string[] {
  return [...new Set([...s.matchAll(/`([^`]+)`|\b([A-Za-z_$][\w.$]*(?:\/\d+|(?=\()))/g)]
    .map(m => m[1] ?? m[2]!))].sort();
}
export function descriptorKey(d: ClaimDescriptor): string {
  return JSON.stringify([d.version, d.operation, d.invariant, d.evidence]);
}

/** A versioned semantic key; historical stableFindingKey deliberately stays unchanged. */
export function semanticFindingKey(file: string, category: string, descriptor: ClaimDescriptor): string {
  return createHash('sha256').update(JSON.stringify(['semantic-claim-v1', file, category, descriptorKey(descriptor)])).digest('hex').slice(0, 16);
}

function substantive(s: string): string[] {
  return [...tokenize(s)].filter(t => !new Set(['code', 'issue', 'bug', 'function', 'method', 'should', 'could', 'would', 'may', 'fix', 'change', 'value', 'data']).has(t));
}
function invariantWords(s: string): string[] {
  const grammar = new Set(['the', 'a', 'an', 'their', 'its', 'is', 'are', 'was', 'were', 'been', 'being']);
  const inflections: Record<string, string> = { returns: 'return', returned: 'return', returning: 'return', checks: 'check', checked: 'check', checking: 'check', entries: 'entry' };
  return (s.toLowerCase().match(/[\p{L}\p{N}_]+|[<>!=]=?/gu) ?? []).filter(t => !grammar.has(t)).map(t => inflections[t] ?? t);
}
function similarity(a: string, b: string): number {
  return substantive(a).length >= 3 && substantive(b).length >= 3 ? jaccardSimilarity(a, b) : 0;
}
function opposed(a: ClaimDescriptor, b: ClaimDescriptor): boolean {
  // Negation changes an invariant even when nearly every other token agrees.
  const negative = (s: string) => /\b(?:not|never|no|without|cannot|can't|mustn't)\b/i.test(s);
  if (negative(a.invariant) !== negative(b.invariant)) return true;
  const asFinding = (d: ClaimDescriptor) => ({ title: d.invariant, description: d.evidence.join(' ') }) as Finding;
  return hasOpposingSentiment(asFinding(a), asFinding(b), true);
}

/** High confidence lexical support, not arbitrary-language equivalence. */
export function compareClaims(a: ClaimDescriptor, b: ClaimDescriptor): 'exact_descriptor' | 'supported_paraphrase' | undefined {
  if (!claimDescriptorSchema.safeParse(a).success || !claimDescriptorSchema.safeParse(b).success) return undefined;
  const informative = (d: ClaimDescriptor) => ![d.operation, d.invariant, ...d.evidence].some(t => t.includes('[redacted]') || t.includes('[insufficient-evidence:')) &&
    d.evidence.some(e => e !== d.invariant && substantive(e).length >= 3);
  if (!informative(a) || !informative(b)) return undefined;
  if (substantive(a.invariant).length < 3 || substantive(b.invariant).length < 3 || opposed(a, b)) return undefined;
  if (descriptorKey(a) === descriptorKey(b)) return 'exact_descriptor';
  // Explicit symbols, digit-bearing constraints and omitted-text commitments must agree.
  const guards = (d: ClaimDescriptor) => JSON.stringify([
    anchors([d.operation, d.invariant, ...d.evidence].join(' ')),
    [...new Set([d.operation, d.invariant, ...d.evidence].flatMap(text => (text.match(/\S+/g) ?? []).filter(token => /\d/.test(token))))].sort(),
    [...d.operation.matchAll(/\[sha256:[a-f0-9]{64}\]/g), ...d.invariant.matchAll(/\[sha256:[a-f0-9]{64}\]/g),
      ...d.evidence.flatMap(e => [...e.matchAll(/\[sha256:[a-f0-9]{64}\]/g)])].map(m => m[0]).sort(),
  ]);
  if (guards(a) !== guards(b)) return undefined;
  const scope = (d: ClaimDescriptor) => d.operation.split(' :: ')[0];
  if (scope(a) !== scope(b)) return undefined;
  // Require invariant support AND a second independent field, not merely a
  // helper name, broad concept, location or identical suggested fix.
  // Lexical overlap alone cannot establish subject, argument or condition
  // equivalence. Only grammatical variants of the same ordered assertion
  // qualify automatically; broader paraphrases remain separate for triage.
  if (JSON.stringify(invariantWords(a.invariant)) !== JSON.stringify(invariantWords(b.invariant))) return undefined;
  if (similarity(a.invariant, b.invariant) < 0.72) return undefined;
  const independent = (d: ClaimDescriptor) => d.evidence.filter(e => e !== d.invariant);
  if (!independent(a).some(x => independent(b).some(y => similarity(x, y) >= 0.72))) return undefined;
  return 'supported_paraphrase';
}
