import { describe, it, expect } from 'vitest';
import {
  sanitizeInline,
  sanitizeBlock,
  fencedCodeBlock,
} from '../../src/output/sanitize.js';

describe('sanitizeInline', () => {
  it('neutralizes @mentions so they do not ping', () => {
    expect(sanitizeInline('ping @org/security-team now')).toContain('`@org/security-team`');
    expect(sanitizeInline('cc @octocat')).toContain('`@octocat`');
  });

  it('neutralizes issue references', () => {
    expect(sanitizeInline('see #1234 for context')).toContain('`#1234`');
  });

  it('strips HTML tags', () => {
    expect(sanitizeInline('title <img src=x onerror=alert(1)> end')).not.toContain('<img');
  });

  it('collapses whitespace and truncates', () => {
    const long = 'a'.repeat(300);
    const out = sanitizeInline(long);
    expect(out.length).toBeLessThan(220);
    expect(out).toMatch(/truncated/);
  });
});

describe('sanitizeBlock', () => {
  it('strips HTML comments', () => {
    expect(sanitizeBlock('text <!-- hidden --> more')).not.toContain('<!--');
  });

  it('keeps newlines but neutralizes mentions', () => {
    const out = sanitizeBlock('line one @admin\nline two');
    expect(out).toContain('\n');
    expect(out).toContain('`@admin`');
  });
});

describe('fencedCodeBlock', () => {
  it('uses a longer fence when the content contains triple backticks', () => {
    const out = fencedCodeBlock('```js\nalert(1)\n```');
    // outer fence must be at least 4 backticks so the inner ``` cannot close it
    expect(out.startsWith('````')).toBe(true);
    expect(out.trimEnd().endsWith('````')).toBe(true);
  });

  it('uses a standard fence for plain content', () => {
    const out = fencedCodeBlock('const x = 1;');
    expect(out.startsWith('```\n')).toBe(true);
  });
});
