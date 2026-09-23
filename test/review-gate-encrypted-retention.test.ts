import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

type WorkflowStep = {
  name?: string;
  run?: unknown;
};

function encryptedRetentionScript(): string {
  const parsed = parse(workflow) as {
    jobs?: { 'attested-review'?: { steps?: WorkflowStep[] } };
  };
  const script = parsed.jobs?.['attested-review']?.steps?.find(
    step => step.name === 'Prepare encrypted review evidence'
  )?.run;
  if (typeof script !== 'string') throw new Error('encrypted_retention_step_not_found');
  return script;
}

function runOpenSsl(args: string[]) {
  return spawnSync('openssl', args, { encoding: 'utf8' });
}

function createSyntheticRecipient(root: string, name: string) {
  const cert = join(root, name + '-cert.pem');
  const key = join(root, name + '-key.pem');
  const result = runOpenSsl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=synthetic-' + name,
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  expect(result.status, result.stderr).toBe(0);
  return { cert, key };
}

async function runRetention(
  root: string,
  exportDir: string,
  quarantineDir: string,
  cert: string,
  suffix: string
) {
  const recoveryDir = join(root, 'recovery-' + suffix);
  const scriptPath = join(root, 'retention-' + suffix + '.sh');
  await writeFile(scriptPath, encryptedRetentionScript());
  const result = spawnSync('/bin/bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      RUNNER_TEMP: root,
      RCL_GATE_EXPORT: exportDir,
      RCL_QUARANTINE: quarantineDir,
      RCL_RECOVERY_DIR: recoveryDir,
      RCL_RECOVERY_CERT: cert,
    },
  });
  return {
    ciphertext: join(recoveryDir, 'review-evidence.cms'),
    recoveryDir,
    result,
  };
}

function decrypt(ciphertext: string, cert: string, key: string, output: string) {
  return runOpenSsl([
    'cms',
    '-decrypt',
    '-binary',
    '-inform',
    'DER',
    '-in',
    ciphertext,
    '-recip',
    cert,
    '-inkey',
    key,
    '-out',
    output,
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('encrypted review evidence retention', () => {
  it('checks AES-GCM support without an early pipeline consumer under pipefail', () => {
    const script = encryptedRetentionScript();
    expect(script).toContain("openssl list -cipher-algorithms | grep -F 'AES-256-GCM' >/dev/null");
    expect(script).not.toContain("openssl list -cipher-algorithms | grep -Fq 'AES-256-GCM'");
  });

  it('round-trips deterministic originals and refuses wrong-key or tampered ciphertext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rcl-encrypted-retention-test-'));
    roots.push(root);
    const exportDir = join(root, 'evidence');
    const quarantineDir = join(root, 'quarantine');
    await mkdir(exportDir);
    await mkdir(quarantineDir);

    const report = '{"finding":"PRIVATE-RECOVERY-CANARY-7ad916ab"}\n';
    const quarantine = 'PRIVATE-QUARANTINE-CANARY-a9ce14dd\n';
    await writeFile(join(exportDir, 'report.json'), report);
    await writeFile(join(exportDir, 'exit-status'), '1\n');
    await writeFile(join(quarantineDir, 'failure.json'), quarantine);

    const recipient = createSyntheticRecipient(root, 'recipient');
    const wrongRecipient = createSyntheticRecipient(root, 'wrong');
    const first = await runRetention(
      root,
      exportDir,
      quarantineDir,
      recipient.cert,
      'first'
    );
    const second = await runRetention(
      root,
      exportDir,
      quarantineDir,
      recipient.cert,
      'second'
    );
    expect(first.result.status, first.result.stderr).toBe(0);
    expect(second.result.status, second.result.stderr).toBe(0);
    expect(await readdir(first.recoveryDir)).toEqual(['review-evidence.cms']);
    expect(await readdir(second.recoveryDir)).toEqual(['review-evidence.cms']);

    const firstTar = join(root, 'first.tar');
    const secondTar = join(root, 'second.tar');
    expect(decrypt(first.ciphertext, recipient.cert, recipient.key, firstTar).status).toBe(0);
    expect(decrypt(second.ciphertext, recipient.cert, recipient.key, secondTar).status).toBe(0);
    expect(await readFile(firstTar)).toEqual(await readFile(secondTar));

    const listing = spawnSync('tar', ['-tf', firstTar], { encoding: 'utf8' });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout.trim().split('\n')).toEqual([
      'MANIFEST.json',
      'evidence/exit-status',
      'evidence/report.json',
      'quarantine/failure.json',
    ]);

    const manifestResult = spawnSync('tar', ['-xOf', firstTar, 'MANIFEST.json'], {
      encoding: 'utf8',
    });
    expect(manifestResult.status, manifestResult.stderr).toBe(0);
    const manifest = JSON.parse(manifestResult.stdout) as {
      schema: string;
      files: Array<{ bytes: number; path: string; sha256: string }>;
    };
    expect(manifest).toEqual({
      files: [
        {
          bytes: 2,
          path: 'evidence/exit-status',
          sha256: createHash('sha256').update('1\n').digest('hex'),
        },
        {
          bytes: Buffer.byteLength(report),
          path: 'evidence/report.json',
          sha256: createHash('sha256').update(report).digest('hex'),
        },
        {
          bytes: Buffer.byteLength(quarantine),
          path: 'quarantine/failure.json',
          sha256: createHash('sha256').update(quarantine).digest('hex'),
        },
      ],
      schema: 'rcl-review-evidence-archive-v1',
    });

    for (const [member, expected] of [
      ['evidence/exit-status', '1\n'],
      ['evidence/report.json', report],
      ['quarantine/failure.json', quarantine],
    ] as const) {
      const extracted = spawnSync('tar', ['-xOf', firstTar, member], { encoding: 'utf8' });
      expect(extracted.status, extracted.stderr).toBe(0);
      expect(extracted.stdout).toBe(expected);
    }

    const ciphertext = await readFile(first.ciphertext);
    expect(ciphertext.includes(Buffer.from('PRIVATE-RECOVERY-CANARY-7ad916ab'))).toBe(false);
    expect(ciphertext.includes(Buffer.from('PRIVATE-QUARANTINE-CANARY-a9ce14dd'))).toBe(false);

    const wrongOutput = join(root, 'wrong.tar');
    const wrongKey = decrypt(
      first.ciphertext,
      wrongRecipient.cert,
      wrongRecipient.key,
      wrongOutput
    );
    expect(wrongKey.status).not.toBe(0);

    const tamperedPath = join(root, 'tampered.cms');
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 1;
    await writeFile(tamperedPath, tampered);
    const tamperedOutput = join(root, 'tampered.tar');
    expect(decrypt(tamperedPath, recipient.cert, recipient.key, tamperedOutput).status).not.toBe(0);
  });
});
