import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = await readFile(
  new URL('../.github/workflows/review_gate.yml', import.meta.url),
  'utf8'
);
const roots: string[] = [];
const headSha = 'a'.repeat(40);
const registeredAttempt = '12345678-1234-4abc-8def-1234567890ab';

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: unknown;
  if?: string;
  'timeout-minutes'?: number;
};

type WorkflowJob = {
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
};

function attestedReviewJob(): WorkflowJob {
  const parsed = parse(workflow) as {
    jobs?: { 'attested-review'?: WorkflowJob };
  };
  const job = parsed.jobs?.['attested-review'];
  if (!job) throw new Error('attested_review_job_not_found');
  return job;
}

function attestedReviewScript(): string {
  const script = attestedReviewJob().steps?.find(step => step.name === 'Attested review')?.run;
  if (typeof script !== 'string') throw new Error('attested_review_step_not_found');
  return script;
}

async function runReviewStep(
  attemptId: string,
  exitCode = 0,
  envOverrides: Record<string, string> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'rcl-review-gate-test-'));
  roots.push(root);
  const fakeBin = join(root, 'bin');
  const argsPath = join(root, 'rcl-args');
  const scriptPath = join(root, 'attested-review.sh');
  const dataDir = join(root, 'data');
  const exportDir = join(root, 'export');
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, 'rcl'),
    `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_RCL_ARGS"
json_file=
markdown_file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json-file) shift; json_file=$1 ;;
    --markdown) shift; markdown_file=$1 ;;
  esac
  shift
done
printf '{"fake":true}\\n' > "$json_file"
printf '# fake report\\n' > "$markdown_file"
mkdir -p "$RCL_DATA_DIR/quarantine"
printf 'retained\\n' > "$RCL_DATA_DIR/quarantine/fake.json"
exit "$FAKE_RCL_EXIT"
`
  );
  await chmod(join(fakeBin, 'rcl'), 0o700);
  await writeFile(scriptPath, attestedReviewScript());

  const result = spawnSync('/bin/bash', ['-e', scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      PR_NUMBER: '80',
      HEAD_SHA: headSha,
      GITHUB_REPOSITORY: 'allocator-one/rcl',
      GITHUB_RUN_ID: '35850000000',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'b'.repeat(40),
      GITHUB_TOKEN: 'test-token',
      ATTEMPT_ID: attemptId,
      RCL_DATA_DIR: dataDir,
      RCL_GATE_EXPORT: exportDir,
      FAKE_RCL_ARGS: argsPath,
      FAKE_RCL_EXIT: String(exitCode),
      ...envOverrides,
    },
  });
  return { result, argsPath, dataDir, exportDir };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Review Council gate workflow', () => {
  it.each([
    ['registered', registeredAttempt],
    ['manual', ''],
  ])('runs the actual review step for a valid %s dispatch', async (_kind, attemptId) => {
    const run = await runReviewStep(attemptId);
    expect(run.result.status, run.result.stderr).toBe(0);
    expect((await readFile(run.argsPath, 'utf8')).trim().split('\n')).toEqual([
      'review',
      'allocator-one/rcl#80',
      '--attest',
      '--expect-head-sha',
      headSha,
      '--evidence-required',
      '--json-file',
      join(run.exportDir, 'report.json'),
      '--markdown',
      join(run.exportDir, 'report.md'),
      '--ci',
    ]);
    expect(JSON.parse(await readFile(join(run.exportDir, 'workflow.json'), 'utf8'))).toEqual({
      ATTEMPT_ID: attemptId,
      GITHUB_REPOSITORY: 'allocator-one/rcl',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_ID: '35850000000',
      GITHUB_SHA: 'b'.repeat(40),
      HEAD_SHA: headSha,
      PR_NUMBER: '80',
    });
  });

  it.each([
    'not-a-uuid',
    '12345678-1234-4ABC-8def-1234567890ab',
    `not-a-uuid\n${registeredAttempt}`,
  ])('rejects malformed attempt id %s before output or review', async attemptId => {
    const run = await runReviewStep(attemptId);
    expect(run.result.status).toBe(2);
    expect(run.result.stderr).toContain('attempt_id must be a lowercase UUID when provided');
    await expect(readFile(run.argsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(run.exportDir, 'workflow.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['non-numeric pull request', { PR_NUMBER: 'eight' }],
    ['empty pull request', { PR_NUMBER: '' }],
    ['short head', { HEAD_SHA: 'a'.repeat(39) }],
    ['uppercase head', { HEAD_SHA: 'A'.repeat(40) }],
    ['multi-line head', { HEAD_SHA: `${headSha}\nextra` }],
  ])('rejects an invalid %s before output or review', async (_kind, envOverrides) => {
    const run = await runReviewStep(registeredAttempt, 0, envOverrides);
    expect(run.result.status).toBe(2);
    await expect(readFile(run.argsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(run.exportDir, 'workflow.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves exported originals and quarantine material after an adverse review', async () => {
    const run = await runReviewStep(registeredAttempt, 1);
    expect(run.result.status).toBe(1);
    expect(await readFile(join(run.exportDir, 'report.json'), 'utf8')).toBe('{"fake":true}\n');
    expect(await readFile(join(run.exportDir, 'report.md'), 'utf8')).toBe('# fake report\n');
    expect(JSON.parse(await readFile(join(run.exportDir, 'workflow.json'), 'utf8'))).toMatchObject({
      ATTEMPT_ID: registeredAttempt,
      HEAD_SHA: headSha,
    });
    expect(await readFile(join(run.dataDir, 'quarantine', 'fake.json'), 'utf8')).toBe('retained\n');
    expect(await readFile(join(run.exportDir, 'exit-status'), 'utf8')).toBe('1\n');
  });

  it('keeps runner paths step-scoped and uploads retained files on every outcome', () => {
    const jobPrefix = workflow.slice(workflow.indexOf('jobs:'), workflow.indexOf('steps:'));
    expect(jobPrefix).not.toContain('${{ runner.temp }}');
    expect(workflow).toContain('RCL_DATA_DIR: ${{ runner.temp }}/rcl-gate-data');
    expect(workflow).toContain('RCL_GATE_EXPORT: ${{ runner.temp }}/rcl-gate-evidence');
    expect(workflow).toContain(
      "run-name: Review Council gate · ${{ inputs.attempt_id || 'unregistered' }}"
    );

    const retention = workflow.slice(workflow.indexOf('- name: Retain original review evidence'));
    expect(retention).toContain('if: always()');
    expect(retention).toContain(
      'name: review-gate-${{ github.run_id }}-${{ github.run_attempt }}'
    );
    expect(retention).not.toContain('inputs.attempt_id');
    expect(retention).toContain('${{ runner.temp }}/rcl-gate-evidence/');
    expect(retention).toContain('${{ runner.temp }}/rcl-gate-data/quarantine/');
  });

  it('bounds sequential steps so retained evidence has time before the job deadline', () => {
    const job = attestedReviewJob();
    const steps = job.steps ?? [];
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
    const setupNode = steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    const install = steps.find(step => step.name === 'Install Review Council');
    const review = steps.find(step => step.name === 'Attested review');
    const retain = steps.find(step => step.name === 'Retain original review evidence');

    expect(job['timeout-minutes']).toBe(360);
    expect(checkout?.['timeout-minutes']).toBe(5);
    expect(setupNode?.['timeout-minutes']).toBe(5);
    expect(install?.['timeout-minutes']).toBe(10);
    expect(review?.['timeout-minutes']).toBe(330);
    expect(retain?.['timeout-minutes']).toBe(5);
    expect(retain?.if).toBe('always()');

    const aggregateBudget = [checkout, setupNode, install, review, retain].reduce(
      (total, step) => total + (step?.['timeout-minutes'] ?? 0),
      0
    );
    expect(aggregateBudget).toBe(355);
    expect((job['timeout-minutes'] ?? 0) - aggregateBudget).toBe(5);
  });
});
