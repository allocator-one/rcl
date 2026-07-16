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
