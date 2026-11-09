import { describe, expect, it } from 'vitest';
import { generatedPathMatcher, leaveOutGenerated } from '../../src/resolver/generated-paths.js';
import type { FileChange } from '../../src/resolver/types.js';

function file(filename: string, extra: Partial<FileChange> = {}): FileChange {
  return {
    filename, status: 'modified', additions: 2, deletions: 1, language: 'text',
    patch: '@@ -1 +1,2 @@\n-a\n+b\n+c\n', blobSha: 'e'.repeat(40), ...extra,
  };
}

describe('generatedPathMatcher', () => {
  const matches = (attributes: string, path: string) => generatedPathMatcher(attributes)(path);

  it('matches a rooted file, a basename at any depth, and a directory glob', () => {
    const attributes = [
      'spec/infraone.json linguist-generated',
      '*.min.js linguist-generated=true',
      'docs/infraone/** linguist-generated',
    ].join('\n');
    expect(matches(attributes, 'spec/infraone.json')).toBe(true);
    expect(matches(attributes, 'assets/js/app.min.js')).toBe(true);
    expect(matches(attributes, 'docs/infraone/commands.md')).toBe(true);
    expect(matches(attributes, 'docs/infraone/nested/more.md')).toBe(true);
    expect(matches(attributes, 'docs/other.md')).toBe(false);
    expect(matches(attributes, 'src/spec/infraone.json')).toBe(false);
  });

  it('lets a later line win, as git does', () => {
    const attributes = '*.json linguist-generated\nspec/keep.json -linguist-generated\n';
    expect(matches(attributes, 'spec/other.json')).toBe(true);
    expect(matches(attributes, 'spec/keep.json')).toBe(false);
    expect(matches('*.json linguist-generated\n*.json !linguist-generated', 'a.json')).toBe(false);
    expect(matches('*.json linguist-generated=false', 'a.json')).toBe(false);
  });

  it('keeps a path in review for any syntax it does not implement', () => {
    const attributes = [
      '# comment',
      '[attr]generated linguist-generated',
      '"quoted name.json" linguist-generated',
      '!negated.json linguist-generated',
      'directory/ linguist-generated',
      'other.json text eol=lf',
    ].join('\n');
    for (const path of ['comment', 'quoted name.json', 'negated.json', 'directory/x.json', 'other.json']) {
      expect(matches(attributes, path)).toBe(false);
    }
  });

  it('does not let * cross a directory boundary in a rooted pattern', () => {
    expect(matches('docs/*.md linguist-generated', 'docs/a.md')).toBe(true);
    expect(matches('docs/*.md linguist-generated', 'docs/nested/a.md')).toBe(false);
    expect(matches('**/gen/*.ts linguist-generated', 'a/b/gen/x.ts')).toBe(true);
  });
});

describe('leaveOutGenerated', () => {
  const generated = (path: string) => path.startsWith('spec/') || path.endsWith('.gitattributes');

  it('blanks the patch, keeps the file bound by blob id and counts, and lists it', () => {
    const { files, leftOut } = leaveOutGenerated([file('src/a.ts'), file('spec/api.json')], generated, 'b'.repeat(40));
    expect(files.map((f) => [f.filename, f.patch === ''])).toEqual([['src/a.ts', false], ['spec/api.json', true]]);
    expect(files[1]).toMatchObject({ blobSha: 'e'.repeat(40), additions: 2, deletions: 1 });
    expect(leftOut).toEqual({ reason: 'linguist-generated', ref: 'b'.repeat(40), count: 1, paths: ['spec/api.json'] });
  });

  it('never leaves out a .gitattributes file, nor a file without a blob id', () => {
    const { files, leftOut } = leaveOutGenerated(
      [file('.gitattributes'), file('spec/.gitattributes'), file('spec/unbound.json', { blobSha: undefined })],
      generated,
      'b'.repeat(40)
    );
    expect(files.every((f) => f.patch !== '')).toBe(true);
    expect(leftOut).toBeUndefined();
  });

  it('lists at most 100 paths but counts them all', () => {
    const many = Array.from({ length: 130 }, (_, i) => file(`spec/f-${String(i).padStart(3, '0')}.json`));
    const { leftOut } = leaveOutGenerated(many, generated, 'b'.repeat(40));
    expect(leftOut?.count).toBe(130);
    expect(leftOut?.paths).toHaveLength(100);
    expect(leftOut?.paths[0]).toBe('spec/f-000.json');
  });
});
