import { describe, it, expect } from 'vitest';
import { parseLedgerBullets, matchBulletToFindings } from '../../src/models/seed.js';

const LEDGER = `# RCL converge ledger — repo-1

## Round 1 — report /tmp/rcl-report-repo-1-r1.json — 3 findings

### Fixed
- [fixed] evaluator.ex — :zero_byte was missing from the unhealthy integrity list, so an
  empty note could mark a required slot satisfied. Findings 18/19.
- [dismissed] rules.ex — "quarterly filename shadows tax filings" — folder pattern already covers it

## Round 2 — report /tmp/rcl-report-repo-1-r2.json — 1 finding
- [minor/fixed] config.ex — typo in comment
`;

describe('parseLedgerBullets', () => {
  it('parses verdicts, wrapped lines, and per-round report basenames', () => {
    const bullets = parseLedgerBullets(LEDGER);
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toMatchObject({ verdict: 'fixed', reportBase: 'rcl-report-repo-1-r1.json' });
    expect(bullets[0]!.text).toContain('required slot satisfied');
    expect(bullets[1]).toMatchObject({ verdict: 'dismissed' });
    expect(bullets[2]).toMatchObject({ verdict: 'fixed', reportBase: 'rcl-report-repo-1-r2.json' });
  });
});

describe('matchBulletToFindings', () => {
  const findings = [
    {
      file: 'lib/app/evaluator.ex',
      title: 'zero_byte missing from unhealthy integrity list',
      description: 'empty note marks a required slot satisfied',
      severity: 'important',
      models: ['m1', 'm2'],
    },
    {
      file: 'lib/app/evaluator.ex',
      title: 'descending range produces wrong slot count',
      description: 'Enum.to_list on a reversed range',
      severity: 'important',
      models: ['m3'],
    },
    {
      file: 'lib/app/rules.ex',
      title: 'quarterly filename rule shadows tax filings',
      description: '',
      severity: 'important',
      models: ['m4'],
    },
  ];

  it('matches by file basename plus title-token overlap', () => {
    const [bullet] = parseLedgerBullets(LEDGER);
    const matched = matchBulletToFindings(bullet!, findings);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.models).toEqual(['m1', 'm2']);
  });

  it('does not match findings in other files or with unrelated titles', () => {
    const bullet = { verdict: 'fixed' as const, text: 'evaluator.ex — something entirely different about caching' };
    expect(matchBulletToFindings(bullet, findings)).toHaveLength(0);
  });
});
