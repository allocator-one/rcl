import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { inspectRoundLiveness } from '../../src/converge/round-liveness.js';
import { convergeTargetCandidates } from '../../src/converge/target-forms.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const headSha = 'a'.repeat(40);
const completion = { runId: '019921a0-0000-7000-8000-0000000000bb', reportJsonSha256: 'c'.repeat(64),
  successfulReviews: 3, totalReviews: 3, deliveryPending: false, reportPath: '/tmp/rcl-report-fixture.json' };

async function commonDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-target-forms-')));
  directories.push(dir);
  return dir;
}

/** A guarded round that ran to completion under exactly this key. */
async function completedRound(gitCommonDir: string, target: string): Promise<void> {
  await guardReviewLaunch({ gitCommonDir, target, headSha, inputSha256: 'b'.repeat(64),
    validate: vi.fn(async () => {}),
    beforeClaim: vi.fn(async () => ({ ordinaryInputs: { version: 1 as const, packetSha256: 'd'.repeat(64), baseSha: null } })),
    ordinaryCheckpoint: { exists: vi.fn(async () => true) },
    run: vi.fn(async () => completion) });
}

describe('converge-status resolves a pull request by every accepted form (RCL-235)', () => {
  const slug = 'allocator-one-17256';
  const forms = {
    'slug': slug,
    'owner/repo#N': 'allocator-one/allocator-one#17256',
    'pull request URL': 'https://github.com/allocator-one/allocator-one/pull/17256',
    'pull request sub-page URL': 'https://github.com/allocator-one/allocator-one/pull/17256/files',
  };

  it.each(Object.entries(forms))('reads the round a %s launched under the slug', async (_form, requested) => {
    const dir = await commonDir();
    await completedRound(dir, slug);

    const status = await inspectRoundLiveness({ gitCommonDir: dir, target: requested, headSha });

    expect(status).toMatchObject({ target: slug, status: 'completed', action: 'process_report',
      launch: { runId: completion.runId } });
    expect(status.requestedTarget).toBe(requested === slug ? undefined : requested);
  });

  it('reads a round launched under the literal owner/repo#N key, which is also a valid converge target', async () => {
    const dir = await commonDir();
    await completedRound(dir, 'allocator-one/allocator-one#17256');

    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: slug, headSha })).toMatchObject({
      target: 'allocator-one/allocator-one#17256', requestedTarget: slug, status: 'completed',
      launch: { runId: completion.runId } });
    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: forms['pull request URL'], headSha })).toMatchObject({
      target: 'allocator-one/allocator-one#17256', status: 'completed', launch: { runId: completion.runId } });
  });

  it('matches the lowercased slug rcl review derives for a mixed-case repository', async () => {
    const dir = await commonDir();
    await completedRound(dir, 'rcl-ios-9');

    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: 'allocator-one/RCL-iOS#9', headSha }))
      .toMatchObject({ target: 'rcl-ios-9', status: 'completed' });
  });

  it('answers with the latest record when a pull request holds rounds under both spellings', async () => {
    const dir = await commonDir();
    await completedRound(dir, 'allocator-one/allocator-one#17256');
    await new Promise(resolve => setTimeout(resolve, 5)); // timing is the behavior: the later launch has the later startedAt
    await completedRound(dir, slug);

    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: forms['owner/repo#N'], headSha }))
      .toMatchObject({ target: slug, requestedTarget: forms['owner/repo#N'] });
  });

  it('reports a pull request with no round as idle on the slug it would launch under', async () => {
    expect(await inspectRoundLiveness({ gitCommonDir: await commonDir(), target: forms['owner/repo#N'] }))
      .toMatchObject({ target: slug, requestedTarget: forms['owner/repo#N'], status: 'idle' });
  });

  it.each(['#17256', '17256', 'https://github.com/allocator-one/allocator-one/issues/17256', 'allocator-one/allocator-one#abc'])(
    'refuses %s, which names no key, instead of reporting it as not launched', async requested => {
      const dir = await commonDir();
      await completedRound(dir, slug);

      await expect(inspectRoundLiveness({ gitCommonDir: dir, target: requested, headSha }))
        .rejects.toThrow('converge_target_form_unsupported');
    });

  it('still reads a recorded key that merely looks like an unsupported form', async () => {
    const dir = await commonDir();
    await completedRound(dir, '17256');

    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: '17256', headSha })).toMatchObject({ status: 'completed' });
  });

  it('does not read another pull request\'s owner/repo#N round for a slug', async () => {
    const dir = await commonDir();
    await completedRound(dir, 'allocator-one/allocator-one#17257');

    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: slug, headSha })).toMatchObject({
      target: slug, status: 'not_launched' });
  });

  it('finds an owner/repo#N round whose state file name was cut inside the repository name', async () => {
    const dir = await commonDir();
    const reference = `${'o'.repeat(39)}/allocator-one#17256`; // the 48 character name slug ends at `allocator`
    await completedRound(dir, reference);

    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: slug, headSha })).toMatchObject({
      target: reference, requestedTarget: slug, status: 'completed' });
  });

  it('fails a slug status instead of reporting a miss when a candidate state file cannot be read', async () => {
    const dir = await commonDir();
    await mkdir(join(dir, 'rcl-converge-runs'));
    await writeFile(join(dir, 'rcl-converge-runs', `owner-allocator-one-17256-${'0'.repeat(16)}.json`), 'not json');

    await expect(inspectRoundLiveness({ gitCommonDir: dir, target: slug, headSha })).rejects.toThrow('converge_state_unreadable');
  });

  it('still answers a slug that holds its own round when another state file cannot be read', async () => {
    const dir = await commonDir();
    await completedRound(dir, slug);
    await writeFile(join(dir, 'rcl-converge-runs', `${'x'.repeat(48)}-${'0'.repeat(16)}.json`), 'not json'); // a cut name is a candidate for any slug

    expect(await inspectRoundLiveness({ gitCommonDir: dir, target: slug, headSha })).toMatchObject({
      target: slug, status: 'completed' });
  });

  it('fails a slug status instead of reporting a miss when the recorded keys cannot be listed', async () => {
    const dir = await commonDir();
    await writeFile(join(dir, 'rcl-converge-runs'), 'not a directory'); // a listing error that is not a missing directory

    await expect(inspectRoundLiveness({ gitCommonDir: dir, target: slug, headSha })).rejects.toThrow();
  });

  it('keeps every other key as its own and only candidate', () => {
    expect(convergeTargetCandidates(' rcl-7 ')).toEqual({ key: 'rcl-7', aliases: [] });
    expect(convergeTargetCandidates('fixture-liveness')).toEqual({ key: 'fixture-liveness', aliases: [] });
  });

  it('answers the owner/repo#N form from converge-status the same as the slug', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'rcl-target-forms-cli-')); directories.push(repo);
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const env = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    await completedRound(await realpath(join(repo, '.git')), slug);
    const run = (target: string) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
      fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      'converge-status', '--target', target, '--head', headSha, '--json'], {
      cwd: repo, encoding: 'utf8', timeout: 20_000,
      env: { ...env, NODE_NO_WARNINGS: '1', RCL_DATA_DIR: join(repo, 'private-data'),
        XDG_CONFIG_HOME: join(repo, 'private-config'), HARNESS_API_TOKEN: '', HARNESS_API_URL: '' } });

    const bySlug = run(slug), byForm = run(forms['owner/repo#N']), refused = run('#17256');

    expect([bySlug.status, byForm.status]).toEqual([0, 0]);
    expect(JSON.parse(byForm.stdout)).toMatchObject({ target: slug, status: 'completed', requestedTarget: forms['owner/repo#N'] });
    expect(JSON.parse(bySlug.stdout)).toMatchObject({ target: slug, status: 'completed' });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('converge_target_form_unsupported');
  });
});
