import { describe, it, expect } from 'vitest';
import { parseReviewOutput } from '../../src/consensus/parser.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = join(__dirname, '../fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

describe('parseReviewOutput', () => {
  it('parses a valid claude fixture', () => {
    const raw = loadFixture('review-claude.json');
    const result = parseReviewOutput(raw, 'claude-opus-4-6', 'security-auditor');
    expect(result.warnings).toHaveLength(0);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('parses a valid gpt fixture', () => {
    const raw = loadFixture('review-gpt.json');
    const result = parseReviewOutput(raw, 'gpt-4o', 'general');
    expect(result.warnings).toHaveLength(0);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('parses a valid gemini fixture', () => {
    const raw = loadFixture('review-gemini.json');
    const result = parseReviewOutput(raw, 'gemini-2.0-flash', 'general');
    expect(result.warnings).toHaveLength(0);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('returns empty findings and warning for empty input', () => {
    const result = parseReviewOutput('', 'model', 'role');
    expect(result.findings).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns empty findings and warning for unparseable input', () => {
    const result = parseReviewOutput('not json at all', 'model', 'role');
    expect(result.findings).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('extracts JSON from markdown code fences', () => {
    const raw = '```json\n{"findings": []}\n```';
    const result = parseReviewOutput(raw, 'model', 'role');
    expect(result.findings).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

const VALID_FINDING = {
  file: 'src/a.ts',
  startLine: 1,
  endLine: 2,
  severity: 'minor',
  category: 'security',
  title: 'Missing input validation',
  description: 'Input is used unchecked',
};

describe('parseReviewOutput — untrusted output robustness', () => {
  it('keeps findings that omit id entirely and assigns unique generated ids', () => {
    const raw = JSON.stringify({
      findings: [VALID_FINDING, { ...VALID_FINDING, title: 'Second issue' }],
    });
    const result = parseReviewOutput(raw, 'model-x', 'general');

    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.id.length > 0)).toBe(true);
    expect(new Set(result.findings.map((f) => f.id)).size).toBe(2);
  });

  it('deduplicates colliding ids from the model', () => {
    const raw = JSON.stringify({
      findings: [
        { ...VALID_FINDING, id: 'dup' },
        { ...VALID_FINDING, id: 'dup', title: 'Second issue' },
      ],
    });
    const result = parseReviewOutput(raw, 'model-x', 'general');

    expect(result.findings).toHaveLength(2);
    expect(new Set(result.findings.map((f) => f.id)).size).toBe(2);
  });

  it('regenerates a unique id even when the model spoofs rcl\'s own id scheme', () => {
    // First finding literally carries the id the second would be assigned;
    // the regenerated id must skip past the collision.
    const raw = JSON.stringify({
      findings: [
        { ...VALID_FINDING, id: 'modelx_general_1' },
        { ...VALID_FINDING, id: '', title: 'Second issue' },
      ],
    });
    const result = parseReviewOutput(raw, 'model-x', 'general');

    expect(result.findings).toHaveLength(2);
    expect(new Set(result.findings.map((f) => f.id)).size).toBe(2);
  });

  it('recovers a JSON object followed by trailing prose', () => {
    const raw = `{"findings": [${JSON.stringify({ ...VALID_FINDING, id: 'a' })}]}\n\nNote: I also noticed the file could use refactoring.`;
    const result = parseReviewOutput(raw, 'model', 'role');

    expect(result.findings).toHaveLength(1);
  });

  it('parses a bare top-level findings array', () => {
    const raw = JSON.stringify([{ ...VALID_FINDING, id: 'a' }]);
    const result = parseReviewOutput(raw, 'model', 'role');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('Missing input validation');
  });

  it('salvages id-less findings when a sibling is malformed', () => {
    const raw = JSON.stringify({
      findings: [VALID_FINDING, { garbage: true }],
    });
    const result = parseReviewOutput(raw, 'model-x', 'general');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.id.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// RCL-14: models routinely emit line numbers as JSON strings. A strict
// z.number() discarded those findings, and when EVERY finding in a response
// was affected the whole reviewer was lost while the report said "success".
describe('tolerant field parsing', () => {
  const base = {
    file: 'src/a.ts',
    severity: 'important',
    category: 'correctness',
    title: 'Off-by-one',
    description: 'Loop runs one iteration too far.',
  };

  it('accepts string line numbers', () => {
    const out = parseReviewOutput(
      JSON.stringify({ findings: [{ ...base, startLine: '59', endLine: '61' }] }),
      'm',
      'r'
    );

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.startLine).toBe(59);
    expect(out.findings[0]!.endLine).toBe(61);
    expect(out.dropped).toBe(0);
  });

  it('accepts stray casing and whitespace on severity and category', () => {
    const out = parseReviewOutput(
      JSON.stringify({
        findings: [{ ...base, severity: 'Critical', category: ' Security ', startLine: 1, endLine: 2 }],
      }),
      'm',
      'r'
    );

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.severity).toBe('critical');
    expect(out.findings[0]!.category).toBe('security');
  });

  it('still rejects values that are not line numbers at all', () => {
    const out = parseReviewOutput(
      JSON.stringify({ findings: [{ ...base, startLine: 'somewhere', endLine: 2 }] }),
      'm',
      'r'
    );

    expect(out.findings).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it('reports how many findings were dropped when some survive', () => {
    const out = parseReviewOutput(
      JSON.stringify({
        findings: [
          { ...base, startLine: 1, endLine: 2 },
          { ...base, startLine: 'nope', endLine: 2 },
        ],
      }),
      'm',
      'r'
    );

    expect(out.findings).toHaveLength(1);
    expect(out.dropped).toBe(1);
    expect(out.warnings.some((w) => w.includes('dropped 1'))).toBe(true);
  });

  it('reports a wholly-unparseable response as dropped, not as empty', () => {
    // The RCL-14 case: every finding malformed. `dropped > 0` with no
    // findings is what lets the adapter tell this apart from a clean review.
    const out = parseReviewOutput(
      JSON.stringify({
        findings: [
          { ...base, startLine: 'a', endLine: 2 },
          { ...base, startLine: 'b', endLine: 2 },
        ],
      }),
      'm',
      'r'
    );

    expect(out.findings).toEqual([]);
    expect(out.dropped).toBe(2);
    expect(out.warnings.some((w) => w.includes('all 2 finding(s) failed'))).toBe(true);
  });

  it('a genuinely empty findings array is not a drop', () => {
    const out = parseReviewOutput(JSON.stringify({ findings: [] }), 'm', 'r');

    expect(out.findings).toEqual([]);
    expect(out.dropped).toBe(0);
  });
});

// RCL-15: the sibling of the all-findings-malformed case. A response with no
// findings array never reaches the salvage loop, so the dropped counter stays
// zero — the parser has to say "unusable" explicitly or the caller cannot
// tell this apart from a clean review.
describe('unusable responses', () => {
  it.each([
    ['an empty object', '{}'],
    ['prose with no JSON', 'Sorry, I cannot help with that.'],
    ['findings that is not an array', '{"findings":"none"}'],
    ['a findings key holding an object', '{"findings":{"a":1}}'],
    ['truncated JSON', '{"findings":[{"file":"a.ts"'],
    ['an empty body', ''],
  ])('%s is unusable, not a clean review', (_label, body) => {
    const out = parseReviewOutput(body, 'm', 'r');

    expect(out.findings).toEqual([]);
    expect(out.unusable).toBe(true);
  });

  it('a genuine empty findings array is usable', () => {
    const out = parseReviewOutput(JSON.stringify({ findings: [] }), 'm', 'r');

    expect(out.findings).toEqual([]);
    expect(out.unusable).toBe(false);
    expect(out.dropped).toBe(0);
  });

  it('a wholly malformed findings array is unusable and still counts drops', () => {
    const out = parseReviewOutput(
      JSON.stringify({ findings: [{ file: 'a.ts' }, { file: 'b.ts' }] }),
      'm',
      'r'
    );

    expect(out.unusable).toBe(true);
    expect(out.dropped).toBe(2);
  });

  it('a partially salvaged response is usable', () => {
    const good = {
      file: 'a.ts',
      startLine: 1,
      endLine: 2,
      severity: 'minor',
      category: 'tests',
      title: 't',
      description: 'd',
    };
    const out = parseReviewOutput(JSON.stringify({ findings: [good, { file: 'b.ts' }] }), 'm', 'r');

    expect(out.findings).toHaveLength(1);
    expect(out.dropped).toBe(1);
    expect(out.unusable).toBe(false);
  });
});
