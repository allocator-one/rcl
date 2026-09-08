import { describe, expect, it } from 'vitest';
import { parsePullRequestArg, parseRemoteUrl } from '../../src/evidence/target.js';

describe('parseRemoteUrl', () => {
  it('reads owner and repo from every GitHub remote form', () => {
    for (const url of [
      'git@github.com:allocator-one/rcl.git',
      'git@github.com:allocator-one/rcl',
      'ssh://git@github.com/allocator-one/rcl.git',
      'https://github.com/allocator-one/rcl.git',
      'https://github.com/allocator-one/rcl',
      'git://github.com/allocator-one/rcl.git',
      'https://user@github.com/allocator-one/rcl/',
      'https://x-access-token:ghs_secret@github.com/allocator-one/rcl.git',
      'ssh://git@github.com:22/allocator-one/rcl.git',
      'https://GitHub.com/allocator-one/rcl',
    ]) {
      expect(parseRemoteUrl(url), url).toEqual({ owner: 'allocator-one', repo: 'rcl' });
    }
  });

  it('refuses remotes that are not a GitHub repository, or that carry characters GitHub does not allow', () => {
    for (const url of [
      'https://gitlab.com/a/b.git',
      'git@github.com:onlyowner',
      '/local/path.git',
      '',
      'git@github.com:allocator-one/r\u001b[31mcl.git',
      'https://github.com/allocator-one/..',
      'https://github.com/-bad-/rcl',
      'https://github.com/allocator-one/rcl/extra',
    ]) {
      expect(parseRemoteUrl(url), JSON.stringify(url)).toBeNull();
    }
  });
});

describe('parsePullRequestArg', () => {
  const remote = { owner: 'allocator-one', repo: 'allocator-one' };

  it('accepts a bare number or #number against the current remote', () => {
    expect(parsePullRequestArg('8524', remote)).toEqual({ owner: 'allocator-one', repo: 'allocator-one', number: 8524 });
    expect(parsePullRequestArg('#8524', remote)).toEqual({ owner: 'allocator-one', repo: 'allocator-one', number: 8524 });
  });

  it('accepts owner/repo#number and a pull request URL without a remote', () => {
    expect(parsePullRequestArg('allocator-one/rcl#42', null)).toEqual({ owner: 'allocator-one', repo: 'rcl', number: 42 });
    expect(parsePullRequestArg('https://github.com/allocator-one/rcl/pull/42/files', null)).toEqual({
      owner: 'allocator-one',
      repo: 'rcl',
      number: 42,
    });
  });

  it('names the way out when the number has no repository or the form is unknown', () => {
    expect(() => parsePullRequestArg('42', null)).toThrow(/owner\/repo#42/);
    expect(() => parsePullRequestArg('0', remote)).toThrow(/positive/);
    expect(() => parsePullRequestArg('feature-branch', remote)).toThrow(/owner\/repo#N/);
    expect(() => parsePullRequestArg('../x#1', null)).toThrow();
  });
});
