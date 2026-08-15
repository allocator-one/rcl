import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

function runConvergeAttempt(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', 'converge-attempt', '--json', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }
  );
}

describe('converge-attempt CLI', () => {
  it('emits structured JSON and exit 3 for an invalid cap', () => {
    const result = runConvergeAttempt(['--target', 'rcl-test', '--max-attempts', '0']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: 'maxAttempts (--max-attempts) must be a positive safe integer.',
      },
    });
  });

  it('emits structured JSON when the cap option has no value', () => {
    const result = runConvergeAttempt(['--target', 'rcl-test', '--max-attempts']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'RCL_CONVERGE_ATTEMPT_STATE' },
    });
  });

  it('emits structured JSON and exit 3 when the target is missing', () => {
    const result = runConvergeAttempt([]);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: '--target is required.',
      },
    });
  });

  it('emits structured JSON when the target option has no value', () => {
    const result = runConvergeAttempt(['--target']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: '--target is required.',
      },
    });
  });
});
