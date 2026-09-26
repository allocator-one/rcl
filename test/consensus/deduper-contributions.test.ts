import { describe, expect, it } from 'vitest';
import { deduplicateFindings } from '../../src/consensus/deduper.js';
import type { Finding, ModelReview } from '../../src/consensus/types.js';

function finding(id: string, title = 'SQL injection in search', line = 10): Finding {
  return { id, file: 'src/search.ts', startLine: line, endLine: line + 1, severity: 'important', category: 'security', title, description: `${title} allows attacker controlled query execution` };
}
function review(model: string, role: string, findings: Finding[], status: ModelReview['status'] = 'success'): ModelReview {
  return { model, role, provider: 'test', findings, status, durationMs: 1 };
}
const refs = (groups: ReturnType<typeof deduplicateFindings>) => groups.flatMap(group => group.contributions ?? []).sort((a, b) => a.reviewIndex - b.reviewIndex || a.findingIndex - b.findingIndex);

describe('deduplicateFindings contribution lineage', () => {
  it('preserves every successful raw finding through within-review and same-model-role collapse', () => {
    const reviews = [
      review('m1', 'general', [finding('a'), finding('a-repeat')]),
      review('m1', 'general', [finding('b')]),
      review('m2', 'security', [finding('bridge')]),
      review('m3', 'general', [finding('unrelated', 'Race condition in queue', 80)]),
      review('failed', 'general', [finding('excluded')], 'error'),
    ];
    const groups = deduplicateFindings(reviews, undefined, undefined, undefined, true);
    expect(groups).toHaveLength(2);
    expect(refs(groups)).toEqual([
      { reviewIndex: 0, findingIndex: 0 }, { reviewIndex: 0, findingIndex: 1 },
      { reviewIndex: 1, findingIndex: 0 }, { reviewIndex: 2, findingIndex: 0 },
      { reviewIndex: 3, findingIndex: 0 },
    ]);
    const sql = groups.find(group => group.representative.title.includes('SQL injection'))!;
    expect(sql.contributions).toEqual([
      { reviewIndex: 0, findingIndex: 0 }, { reviewIndex: 0, findingIndex: 1 },
      { reviewIndex: 1, findingIndex: 0 }, { reviewIndex: 2, findingIndex: 0 },
    ]);
  });

  it('maps references to the supplied review order and preserves exact legacy output without the flag', () => {
    const first = review('m1', 'general', [finding('first')]);
    const second = review('m2', 'security', [finding('second')]);
    const legacy = deduplicateFindings([first, second]);
    expect(legacy).toEqual(deduplicateFindings([first, second], undefined, undefined, undefined, false));
    expect(legacy.every(group => group.contributions === undefined)).toBe(true);
    const swapped = deduplicateFindings([second, first], undefined, undefined, undefined, true);
    expect(swapped[0]!.contributions).toEqual([{ reviewIndex: 0, findingIndex: 0 }, { reviewIndex: 1, findingIndex: 0 }]);
  });
});
