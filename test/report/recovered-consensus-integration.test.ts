import { describe, expect, it } from 'vitest';
import { deriveConsensusAssembly } from '../../src/report/consensus-assembly.js';
import { deduplicateSemanticFindings } from '../../src/consensus/semantic-deduper.js';
import type { Finding, ModelReview } from '../../src/consensus/types.js';

const role = { name: 'general', systemPrompt: '', description: '', focus: [], isSpecialized: false };
const finding = (id: string, extras: Partial<Finding> = {}): Finding => ({
  id, file: 'cache.ts', startLine: 1, endLine: 1, severity: 'critical', category: 'security', confidence: 0.99,
  title: 'Foreign tenant data disclosure',
  description: 'Authorization accepts a foreign account before validating tenant ownership.',
  suggestedFix: 'Check tenant membership before authorizing the account.', ...extras,
});
const review = (model: string, findings: Finding[], extras: Partial<ModelReview> = {}): ModelReview => ({
  model, role: role.name, provider: 'fake', status: 'success', durationMs: 1, findings, ...extras,
});

describe('recovered consensus integration with retained report assembly', () => {
  it('keeps every raw contribution after repeated votes collapse, including appendix lineage', () => {
    const input = {
      runId: '019921a0-0000-7000-8000-000000000105',
      chunkReviews: [review('a', [finding('first'), finding('repeat')]),
        review('b', [finding('second')]),
        review('c', [finding('appendix', { file: 'other.ts', severity: 'minor', confidence: 0.1 })]),
        review('failed', [finding('unaccepted')], { status: 'error' })],
      arrivedAsync: [], roleMap: new Map([[role.name, role]]), thresholds: { minConfidence: 1, minConsensusScore: 1 },
      recoveredProduction: { version: 1 as const, nativeSha256: 'a'.repeat(64) }, collectContributions: true,
    };
    const original = structuredClone(input);
    const result = deriveConsensusAssembly(input);
    expect(result.reportFindings.map(f => f.file)).toEqual(['cache.ts']);
    expect(result.droppedFindings.map(f => f.file)).toEqual(['other.ts']);
    expect(result.contributions).toEqual([
      { reportIdentity: result.reportFindings[0]!.identity, disposition: 'kept', contributions: [
        { reviewIndex: 0, findingIndex: 0 }, { reviewIndex: 0, findingIndex: 1 }, { reviewIndex: 1, findingIndex: 0 },
      ] },
      { reportIdentity: result.droppedFindings[0]!.identity, disposition: 'below_threshold',
        contributions: [{ reviewIndex: 2, findingIndex: 0 }] },
    ]);
    expect(result.consensusFindings.every(f => f.claimDescriptor?.version === 1)).toBe(true);
    expect(input).toEqual(original);
    const withoutLineage = deriveConsensusAssembly({ ...input, collectContributions: false });
    expect(withoutLineage.contributions).toBeUndefined();
    expect(withoutLineage.consensusFindings).toEqual(result.consensusFindings);
  });

  it('honors deterministic UTF-16 ordering without changing ordinary locale ordering', () => {
    const reviews = [review('a', [finding('lower', { file: 'a.ts' }), finding('upper', { file: 'Z.ts' })])];
    const files = (ordering: 'legacy' | 'utf16') => deduplicateSemanticFindings(reviews, undefined, undefined,
      undefined, true, ordering).map(g => g.representative.file);
    expect(files('utf16')).toEqual(['Z.ts', 'a.ts']);
    expect(files('legacy')).toEqual(['Z.ts', 'a.ts'].sort((a, b) => a.localeCompare(b)));
    expect(deduplicateSemanticFindings(reviews).every(g => g.contributions === undefined)).toBe(true);
  });

  it('refuses an unsupported ordering rather than silently applying different identity ordering', () => {
    expect(() => deduplicateSemanticFindings([], undefined, undefined, undefined, true,
      'unsupported' as 'legacy')).toThrow('deduper_invalid_ordering');
  });
});
