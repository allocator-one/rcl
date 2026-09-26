import { describe, expect, it, vi } from 'vitest';
import { deduplicateFindings } from '../../src/consensus/deduper.js';
import type { ModelReview } from '../../src/consensus/types.js';

function reviews(): ModelReview[] {
  return [{ model: 'm1', role: 'general', provider: 'fake', status: 'success', durationMs: 0,
    findings: ['a.ts', 'ä.ts', 'z.ts', '😀.ts', '\uE000.ts'].map((file, index) => ({
      id: `f${index}`, file, startLine: 1, endLine: 1, severity: 'important', category: 'correctness',
      title: 'Missing guard', description: 'Missing tenant access guard',
    })) }];
}

describe('explicit checkpoint deduper ordering', () => {
  it('uses UTF-16 code units without consulting the ambient locale', () => {
    const source = reviews(), before = structuredClone(source);
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('ambient collation forbidden'); });
    try {
      const groups = deduplicateFindings(source, 0.3, 5, 0, true, 'utf16');
      expect(groups.map(group => group.representative.file)).toEqual(['a.ts', 'z.ts', 'ä.ts', '😀.ts', '\uE000.ts']);
      expect(groups.map(group => group.contributions)).toEqual([0, 2, 1, 3, 4].map(findingIndex => [{ reviewIndex: 0, findingIndex }]));
      expect(source).toEqual(before);
    } finally { locale.mockRestore(); }
  });

  it('keeps ordinary calls on their existing locale comparator', () => {
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) {
      return this < other ? 1 : this > other ? -1 : 0;
    });
    try {
      expect(deduplicateFindings(reviews()).map(group => group.representative.file)).toEqual(['\uE000.ts', '😀.ts', 'ä.ts', 'z.ts', 'a.ts']);
      expect(locale).toHaveBeenCalled();
    } finally { locale.mockRestore(); }
  });

  it('refuses an unknown ordering even when the review is empty', () => {
    expect(() => deduplicateFindings([], 0.3, 5, 0, false, 'unknown' as never)).toThrow('deduper_invalid_ordering');
  });
});
