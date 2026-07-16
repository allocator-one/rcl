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
