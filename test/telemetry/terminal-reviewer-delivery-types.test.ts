import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { typescriptBin } from '../vitest-global-setup.js';

describe('published terminal reviewer delivery declarations', () => {
  it('compile a 4.5.8 consumer that reads the legacy result fields without narrowing', async () => {
    const result = await promisify(execFile)(process.execPath, [typescriptBin(), '--noEmit', '--strict',
      '--ignoreConfig',
      '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node',
      'test/fixtures/terminal-reviewer-delivery-consumer.ts'], { cwd: new URL('../..', import.meta.url) });
    expect(result.stderr).toBe('');
  });
});
