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
