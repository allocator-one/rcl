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
  it('binds Windows identity to bounded boot and process birth markers', async () => {
    const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    const command = vi.fn(async (_file: string, args: string[]) =>
      args.at(-1)?.includes('Win32_OperatingSystem') ? '638950000000000000\r\n' : '638950123456789000\r\n');
    const identity = await captureProcessIdentity(17, {
      platform: 'win32', probe: () => {}, command, windowsPowerShell: powershell,
    });
    expect(identity).toEqual({
      version: 1,
      pid: 17,
      scope: {
        platform: 'win32',
        namespace: 'native',
        bootSha256: createHash('sha256').update('win32\0' + '638950000000000000').digest('hex'),
      },
      birthSha256: createHash('sha256').update('win32\0win32:638950123456789000').digest('hex'),
    });
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.every(([file]) => file === powershell)).toBe(true);
    expect(command.mock.calls.every(([, args]) => args.slice(0, 3).join(' ') === '-NoLogo -NoProfile -NonInteractive')).toBe(true);
    expect(command.mock.calls.every(([, , timeout]) => timeout === 5_000)).toBe(true);
  });

  it('resolves the default Windows PowerShell path from an ordinary SystemRoot', async () => {
    const previous = process.env.SystemRoot;
    process.env.SystemRoot = String.raw`C:\Windows`;
    const command = vi.fn(async (_file: string, args: string[]) =>
      args.at(-1)?.includes('Win32_OperatingSystem') ? '638950000000000000\r\n' : '638950123456789000\r\n');
    try {
      await expect(captureProcessIdentity(17, { platform: 'win32', probe: () => {}, command })).resolves.toMatchObject({
        scope: { platform: 'win32' },
      });
      expect(command.mock.calls.map(([file]) => file)).toEqual([
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      ]);
    } finally {
      if (previous === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previous;
    }
  });

  it('distinguishes Windows PID reuse and fails closed on ambiguous birth output', async () => {
    const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    const windowsScope = {
      platform: 'win32' as const,
      namespace: 'native' as const,
      bootSha256: 'a'.repeat(64),
    };
    const overrides = (output: string): Partial<ProcessIdentityIO> => ({
      platform: 'win32', scope: async () => windowsScope, probe: () => {}, windowsPowerShell: powershell,
      command: async () => output,
    });
    const original = await captureProcessIdentity(17, overrides('638950123456789000\r\n'));
    await expect(inspectProcessIdentity(original, overrides('638950123456789000\r\n'))).resolves.toBe('alive');
    await expect(inspectProcessIdentity(original, overrides('638950123456789001\r\n'))).resolves.toBe('dead');
    await expect(inspectProcessIdentity(original, overrides('RCL_PROCESS_MISSING\r\n'))).resolves.toBe('dead');
    await expect(inspectProcessIdentity(original, overrides('638950123456789000\r\nextra\r\n')))
      .resolves.toBe('unverifiable');
  });

  it('binds a PID to the current boot, PID namespace and kernel birth marker', async () => {
    await expect(captureProcessIdentity(17, io())).resolves.toEqual({
      version: 1,
      pid: 17,
      scope,
      birthSha256: 'b96b41be9755dd5f08973358f4e5700f02bb9bffefe6171f8927aa896b6c65bc',
    });
  });

  it('accepts zero as a valid Linux process start tick', async () => {
    const zeroBirth = io({
      linuxStat: async () => '17 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 0 20',
    });
    const identity = await captureProcessIdentity(17, zeroBirth);
    await expect(inspectProcessIdentity(identity, zeroBirth)).resolves.toBe('alive');
  });

  it('uses the bounded fixed-environment system command for the Darwin birth marker', async () => {
    const command = vi.fn(async () => [
      'Process:         node [17]',
      'Date/Time:       2026-10-02 12:35:00.000 +0200',
      'Launch Time:     2026-10-02 12:34:56.123 +0200',
      'Report Version:  7',
      '',
    ].join('\n'));
    const darwinScope = { platform: 'darwin' as const, boot: scope.boot, namespace: 'native' as const };
    const identity = await captureProcessIdentity(17, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {}, command,
    });
    expect(command).toHaveBeenCalledWith('/usr/bin/vmmap', ['-summary', '17'], 5_000);
    expect(identity.birthSha256).toBe(createHash('sha256')
      .update('darwin\0darwin:2026-10-02 12:34:56.123 +0200').digest('hex'));
  });

  it('distinguishes Darwin PID reuse within the same wall-clock second', async () => {
    const darwinScope = { platform: 'darwin' as const, boot: scope.boot, namespace: 'native' as const };
    const output = (launch: string) => `Process: node [17]\nLaunch Time: ${launch}\nReport Version: 7\n`;
    const original = await captureProcessIdentity(17, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {},
      command: async () => output('2026-10-02 12:34:56.123 +0200'),
    });
    await expect(inspectProcessIdentity(original, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {},
      command: async () => output('2026-10-02 12:34:56.987 +0200'),
    })).resolves.toBe('dead');
    await expect(inspectProcessIdentity(original, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {},
      command: async () => output('2026-10-02 12:34:56.123 +0200'),
    })).resolves.toBe('alive');
  });

  it('rejects missing, duplicate and malformed Darwin launch markers', async () => {
    const darwinScope = { platform: 'darwin' as const, boot: scope.boot, namespace: 'native' as const };
    const capture = (output: string) => captureProcessIdentity(17, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {}, command: async () => output,
    });
    await expect(capture('Process: node [17]\n')).rejects.toThrow('invalid_darwin_process_birth');
    await expect(capture([
      'Launch Time: 2026-10-02 12:34:56.123 +0200',
      'Launch Time: 2026-10-02 12:34:56.123 +0200',
    ].join('\n'))).rejects.toThrow('invalid_darwin_process_birth');
    await expect(capture('Launch Time: Thu Oct 2 12:34:56 2026\n'))
      .rejects.toThrow('invalid_darwin_process_birth');
  });

  it('distinguishes a reused PID from the original live process', async () => {
    const original = await captureProcessIdentity(17, io());
    const reused = io({
      linuxStat: async () => '17 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 999999 20',
    });
    await expect(inspectProcessIdentity(original, reused)).resolves.toBe('dead');
    await expect(inspectProcessIdentity(original, io())).resolves.toBe('alive');
  });

  it('does not treat a missing Darwin process-inspection executable as proof that the owner died', async () => {
    const darwinScope = { platform: 'darwin' as const, boot: scope.boot, namespace: 'native' as const };
    const original = await captureProcessIdentity(17, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {},
      command: async () => 'Launch Time: 2026-10-02 12:34:56.123 +0200\n',
    });
    await expect(inspectProcessIdentity(original, {
      platform: 'darwin', scope: async () => darwinScope, probe: () => {},
      command: async () => { throw Object.assign(new Error('missing vmmap'), { code: 'ENOENT' }); },
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
