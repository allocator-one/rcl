import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  captureProcessIdentity,
  inspectProcessIdentity,
  type ProcessIdentityIO,
} from '../../src/converge/process-identity.js';

const scope = {
  platform: 'linux' as const,
  boot: '11111111-1111-4111-8111-111111111111',
  namespace: '1:123',
};

function io(overrides: Partial<ProcessIdentityIO> = {}): Partial<ProcessIdentityIO> {
  return {
    platform: 'linux',
    scope: async () => scope,
    probe: () => {},
    linuxStat: async () => '17 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20',
    ...overrides,
  };
}

describe('process identity', () => {
  it('binds a PID to the current boot, PID namespace and kernel birth marker', async () => {
    await expect(captureProcessIdentity(17, io())).resolves.toEqual({
      version: 1,
      pid: 17,
      scope,
      birthSha256: 'b96b41be9755dd5f08973358f4e5700f02bb9bffefe6171f8927aa896b6c65bc',
    });
  });

  it('uses the bounded fixed-environment system command for the Darwin birth marker', async () => {
    const command = vi.fn(async () => 'Thu Oct  2 12:34:56 2026\n');
    const darwinScope = { platform: 'darwin' as const, boot: scope.boot, namespace: 'native' as const };
    const identity = await captureProcessIdentity(17, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {}, command,
    });
    expect(command).toHaveBeenCalledWith('/bin/ps', ['-p', '17', '-o', 'lstart=']);
    expect(identity.birthSha256).toBe(createHash('sha256')
      .update('darwin\0darwin:Thu Oct  2 12:34:56 2026').digest('hex'));
  });

  it('distinguishes a reused PID from the original live process', async () => {
    const original = await captureProcessIdentity(17, io());
    const reused = io({
      linuxStat: async () => '17 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 999999 20',
    });
    await expect(inspectProcessIdentity(original, reused)).resolves.toBe('dead');
    await expect(inspectProcessIdentity(original, io())).resolves.toBe('alive');
  });

  it('does not treat a missing Darwin ps executable as proof that the owner died', async () => {
    const darwinScope = { platform: 'darwin' as const, boot: scope.boot, namespace: 'native' as const };
    const original = await captureProcessIdentity(17, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {},
      command: async () => 'Thu Oct  2 12:34:56 2026\n',
    });
    await expect(inspectProcessIdentity(original, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {},
      command: async () => { throw Object.assign(new Error('missing ps'), { code: 'ENOENT' }); },
    })).resolves.toBe('unverifiable');
  });

  it('fails closed when scope or process birth cannot be established', async () => {
    const original = await captureProcessIdentity(17, io());
    const probe = vi.fn();
    await expect(inspectProcessIdentity(original, io({
      scope: async () => ({ ...scope, boot: '22222222-2222-4222-8222-222222222222' }),
      probe,
    }))).resolves.toBe('unverifiable');
    expect(probe).not.toHaveBeenCalled();
    await expect(inspectProcessIdentity(original, io({
      linuxStat: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
    }))).resolves.toBe('unverifiable');
    await expect(inspectProcessIdentity(original, io({
      linuxStat: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
    }))).resolves.toBe('dead');
    await expect(inspectProcessIdentity(original, io({
      probe: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
    }))).resolves.toBe('unverifiable');
    await expect(inspectProcessIdentity(original, io({
      probe: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    }))).resolves.toBe('dead');
  });
});
