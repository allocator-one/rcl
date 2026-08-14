import { describe, it, expect } from 'vitest';
import { deduplicateFindings } from '../../src/consensus/deduper.js';
import { DEFAULT_THRESHOLDS } from '../../src/config/defaults.js';
import type { ModelReview } from '../../src/consensus/types.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const corpusDir = join(__dirname, '../fixtures/undermerge-corpus');

interface CorpusCase {
  case: string;
  source: { report: string; rclVersion: string; note: string };
  expected: {
    file: string;
    lineRange: [number, number];
    severity: string;
    distinctReviewerPairs: number;
    successfulReviews: number;
    agreementRatioIfMerged: number;
    minConsensusScore: number;
    clearsThresholdIfMerged: boolean;
    memberTitles: string[];
    miningProxyOvermerged?: boolean;
    mustStaySeparate?: [string, string];
    excludedTitles?: string[];
  };
  reviews: ModelReview[];
}

function loadCorpus(): CorpusCase[] {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(corpusDir, f), 'utf8')) as CorpusCase);
}

/** Findings the fixture says belong to one concept, located in the dedup output. */
function groupsHoldingMembers(
  groups: ReturnType<typeof deduplicateFindings>,
  titles: string[]
): ReturnType<typeof deduplicateFindings> {
  const wanted = new Set(titles);
  return groups.filter((g) => g.members.some((m) => wanted.has(m.finding.title)));
}

const corpus = loadCorpus();

describe('under-merge corpus (RCL-17)', () => {
  it('loads every fixture', () => {
    expect(corpus.length).toBeGreaterThan(0);
    for (const c of corpus) {
      expect(c.reviews.length).toBeGreaterThan(0);
      expect(c.expected.memberTitles.length).toBeGreaterThan(1);
    }
  });

  describe('desired behaviour — one concept, one group', () => {
    for (const c of corpus) {
      if (c.expected.miningProxyOvermerged) {
        it(`${c.case}: keeps the two mined concepts separate`, () => {
          const groups = deduplicateFindings(c.reviews);
          const [left, right] = c.expected.mustStaySeparate!;
          const leftGroup = groups.find((group) =>
            group.members.some((member) => member.finding.title === left)
          );
          const rightGroup = groups.find((group) =>
            group.members.some((member) => member.finding.title === right)
          );

          expect(leftGroup).toBeDefined();
          expect(rightGroup).toBeDefined();
          expect(leftGroup).not.toBe(rightGroup);
        });

        it(`${c.case}: neither separated concept clears minConsensusScore`, () => {
          const groups = deduplicateFindings(c.reviews);
          for (const title of c.expected.mustStaySeparate!) {
            const group = groups.find((candidate) =>
              candidate.members.some((member) => member.finding.title === title)
            );
            expect(group).toBeDefined();
            const pairs = new Set(
              group!.members.map((member) => `${member.model}::${member.role}`)
            );
            expect(pairs.size / c.expected.successfulReviews).toBeLessThan(
              DEFAULT_THRESHOLDS.minConsensusScore
            );
          }
        });
        continue;
      }

      it(`${c.case}: members collapse into a single group`, () => {
        const groups = deduplicateFindings(c.reviews);
        const holding = groupsHoldingMembers(groups, c.expected.memberTitles);
        expect(holding).toHaveLength(1);
      });

      it(`${c.case}: merged group clears minConsensusScore`, () => {
        const groups = deduplicateFindings(c.reviews);
        const holding = groupsHoldingMembers(groups, c.expected.memberTitles);
        expect(holding).toHaveLength(1);

        const pairs = new Set(holding[0].members.map((m) => `${m.model}::${m.role}`));
        const ratio = pairs.size / c.expected.successfulReviews;
        expect(ratio).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minConsensusScore);
      });
    }
  });

  // Guard against the opposite failure: a fix must not merge the world.
  // `ao-7536-r1` carries a SECOND, distinct concept at the same lines
  // ("global log capture is brittle, prefer per-test capture_log"), which is
  // both unactionable and correctly below threshold at 5/17. It must not be
  // absorbed into the matcher-precision group.
  describe('over-merge guard', () => {
    it('does not collapse two distinct concepts at the same location', () => {
      const c = corpus.find((x) => x.case === 'ao-7536-r1-icon-matcher-precision');
      expect(c).toBeDefined();

      const groups = deduplicateFindings(c!.reviews);
      const all = groups.flatMap((g) => g.members.map((m) => m.finding.title));

      const matcher = 'Icon name match is an unclosed prefix, not an exact name';
      const capture = 'Global log capture remains brittle; prefer per-test capture_log';
      expect(all).toContain(matcher);
      expect(all).toContain(capture);

      const matcherGroup = groups.find((g) => g.members.some((m) => m.finding.title === matcher));
      const matcherTitles = matcherGroup!.members.map((m) => m.finding.title);
      expect(matcherTitles).not.toContain(capture);
      for (const excluded of c!.expected.excludedTitles ?? []) {
        expect(matcherTitles).not.toContain(excluded);
      }
    });
  });
});
