import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/prepare/prompt-builder.js';
import { chunkDiff } from '../../src/prepare/chunker.js';
import type { FileChange } from '../../src/resolver/types.js';
import type { Role } from '../../src/roles/types.js';

function makeChunk() {
  const file: FileChange = {
    filename: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1 +1 @@\n-old\n+new',
    language: 'typescript',
  };
  return chunkDiff([file])[0]!;
}

function makeRole(over: Partial<Role> = {}): Role {
  return {
    name: 'security-auditor',
    systemPrompt: 'You are a security auditor.',
    focus: ['security'],
    description: 'security',
    isSpecialized: true,
    ...over,
  };
}

describe('buildPrompt — severity bias', () => {
  it('folds a declared severityBias into the system prompt as calibration guidance', async () => {
    const role = makeRole({ severityBias: { security: 1.2 } });
    const { systemPrompt } = await buildPrompt(makeChunk(), role);

    expect(systemPrompt).toContain('Severity calibration');
    expect(systemPrompt).toContain('MORE severe rating for security');
  });

  it('renders a downward bias as leaning less severe', async () => {
    const role = makeRole({ severityBias: { 'best-practices': 0.8 } });
    const { systemPrompt } = await buildPrompt(makeChunk(), role);

    expect(systemPrompt).toContain('LESS severe rating for best-practices');
  });

  it('adds no calibration text for roles without a bias', async () => {
    const { systemPrompt } = await buildPrompt(makeChunk(), makeRole());

    expect(systemPrompt).not.toContain('Severity calibration');
  });
});

describe('context documents', () => {
  it('loadContextDocs reads once and digests the exact bytes the prompt carries', async () => {
    const { mkdtemp, writeFile, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { createHash } = await import('node:crypto');
    const { loadContextDocs } = await import('../../src/prepare/prompt-builder.js');
    const dir = await mkdtemp(join(tmpdir(), 'rcl-ctx-'));
    try {
      const path = join(dir, 'rules.md');
      await writeFile(path, '# Rules\nNever.\n');
      const { docs, skipped } = await loadContextDocs([path, join(dir, 'missing.md'), dir]);
      expect(docs).toHaveLength(1);
      // Skips are reported, never silent: the caller warns per path.
      expect(skipped).toEqual([join(dir, 'missing.md'), dir]);
      expect(docs[0]).toMatchObject({
        label: path,
        content: '# Rules\nNever.\n',
        sha256: createHash('sha256').update('# Rules\nNever.\n').digest('hex'),
      });
      // The prompt is built from the pre-read docs, so a later edit cannot change it.
      await writeFile(path, 'changed');
      const { userPrompt } = await buildPrompt(makeChunk(), makeRole(), { contextDocs: docs });
      expect(userPrompt).toContain('Never.');
      expect(userPrompt).not.toContain('changed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildPrompt — diff budget', () => {
  it('fails closed when a caller bypasses chunking with an oversized secured diff', async () => {
    const chunk = makeChunk();
    chunk.files[0]!.patch = `@@ -0,0 +1,1 @@\n+${'x'.repeat(64 * 1024)}`;

    await expect(buildPrompt(chunk, makeRole())).rejects.toThrow(
      /secured diff requires.*65,536 bytes/i
    );
  });
});
