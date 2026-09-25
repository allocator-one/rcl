import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { fetchPRDiff } from '../../src/resolver/github.js';
import { postGitHubReview } from '../../src/output/github.js';
import { sampleResult } from '../telemetry/fixtures.js';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  construct: vi.fn(),
  get: vi.fn(),
  compare: vi.fn(),
  createReview: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function (options) {
    mocks.construct(options);
    return {
      pulls: { get: mocks.get, createReview: mocks.createReview },
      repos: { compareCommitsWithBasehead: mocks.compare },
    };
  }),
}));

const target = { owner: 'owner', repo: 'private', number: 7 };
const metadata = {
  ...target, title: 'Fixture', body: '', author: 'fixture', base: 'main', head: 'feature',
  url: 'https://github.com/owner/private/pull/7', labels: [], draft: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GITHUB_TOKEN', '');
  mocks.get.mockResolvedValue({ data: {
    title: 'Fixture', body: '', user: { login: 'fixture' }, labels: [], draft: false,
    html_url: metadata.url, changed_files: 0,
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'feature', sha: 'b'.repeat(40) },
  } });
  mocks.compare.mockResolvedValue({ data: { files: [] } });
  mocks.createReview.mockResolvedValue({});
  mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(null, 'gh-fixture-token\n', '');
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('explicit GitHub operations resolve credentials before requests', () => {
  it('falls back to bounded non-shell gh authentication for github.com', async () => {
    await fetchPRDiff(target);

    expect(mocks.execFile).toHaveBeenCalledWith(
      'gh', ['auth', 'token', '--hostname', 'github.com'],
      expect.objectContaining({ encoding: 'utf8', timeout: 5000, maxBuffer: 16384 }),
      expect.any(Function),
    );
    expect(mocks.construct).toHaveBeenCalledWith({ auth: 'gh-fixture-token' });
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit configured credentials ahead of environment and gh', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'environment-fixture');

    await fetchPRDiff(target, 'configured-fixture');

    expect(mocks.construct).toHaveBeenCalledWith({ auth: 'configured-fixture' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('uses a nonempty environment token when configured credentials are empty', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'environment-fixture');

    await fetchPRDiff(target, '  ');

    expect(mocks.construct).toHaveBeenCalledWith({ auth: 'environment-fixture' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('keeps public anonymous reads possible when gh is unavailable without exposing stderr', async () => {
    const diagnostic = 'secret-fixture-that-must-not-escape';
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error(diagnostic), diagnostic, diagnostic);
    });

    await expect(fetchPRDiff(target)).resolves.toMatchObject({ source: 'github' });

    expect(mocks.construct).toHaveBeenCalledWith({ auth: undefined });
  });

  it('does not treat blank gh output as an authentication credential', async () => {
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '  \n', '');
    });

    await fetchPRDiff(target);

    expect(mocks.construct).toHaveBeenCalledWith({ auth: undefined });
  });

  it('gives an actionable sanitized 404 rather than exposing credentials or gh diagnostics', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('SECRET-Fixture'), { status: 404 }));

    const error = await fetchPRDiff(target).catch(error => error);

    expect(error.message).toMatch(/404.*private.*GITHUB_TOKEN.*githubToken/i);
    expect(error.message).not.toContain('SECRET-Fixture');
    expect(error.cause).toBeUndefined();
  });

  it('preserves non-404 API failures instead of disguising them as missing credentials', async () => {
    const failure = Object.assign(new Error('Rate limited'), { status: 429 });
    mocks.get.mockRejectedValue(failure);

    await expect(fetchPRDiff(target)).rejects.toBe(failure);
  });

  it('resolves the same gh fallback for explicitly requested GitHub review output', async () => {
    await postGitHubReview(sampleResult(), metadata);

    expect(mocks.construct).toHaveBeenCalledWith({ auth: 'gh-fixture-token' });
    expect(mocks.createReview).toHaveBeenCalledTimes(1);
  });

  it('gives the same actionable private-PR error when posting cannot resolve the PR', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('SECRET-Fixture'), { status: 404 }));

    await expect(postGitHubReview(sampleResult(), metadata)).rejects.toThrow(
      /404.*private.*GITHUB_TOKEN.*githubToken/i,
    );
    expect(mocks.createReview).not.toHaveBeenCalled();
  });

  it('does not consult account credentials for an injected GitHub client', async () => {
    const client = {
      pulls: { get: mocks.get },
      repos: { compareCommitsWithBasehead: mocks.compare },
    } as unknown as Octokit;

    await fetchPRDiff(target, undefined, client);

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.construct).not.toHaveBeenCalled();
  });
});
