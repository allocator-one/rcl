import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPlanAsDiff } from '../../src/resolver/plan.js';
import { chunkDiff, formatChunkForPrompt } from '../../src/prepare/chunker.js';

describe('loadPlanAsDiff', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcl-plan-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('wraps a plan document as a single added-file diff with 1:1 line numbers', async () => {
    const path = join(dir, 'plan.md');
    await writeFile(path, '# Plan\n\n## Phase 1\nDo the thing.\n');
    const diff = await loadPlanAsDiff(path);

    expect(diff.source).toBe('local');
    expect(diff.files).toHaveLength(1);
    const file = diff.files[0]!;
    expect(file.filename).toBe(path);
    expect(file.status).toBe('added');
    expect(file.additions).toBe(4);
    expect(file.deletions).toBe(0);
    // The synthetic hunk starts at +1, so finding line N == plan line N
    expect(file.patch.startsWith('@@ -0,0 +1,4 @@\n+# Plan\n+\n+## Phase 1\n+Do the thing.')).toBe(
      true
    );
  });

  it('flows through the chunker unchanged', async () => {
    const path = join(dir, 'chunkable.md');
    await writeFile(path, 'line one\nline two\n');
    const diff = await loadPlanAsDiff(path);
    const chunks = chunkDiff(diff.files);
    expect(chunks).toHaveLength(1);
    const rendered = formatChunkForPrompt(chunks[0]!);
    expect(rendered).toContain('+line one');
    expect(rendered).toContain('+line two');
  });

  it('rejects an empty plan file', async () => {
    const path = join(dir, 'empty.md');
    await writeFile(path, '  \n\n');
    await expect(loadPlanAsDiff(path)).rejects.toThrow(/empty/);
  });

  it('rejects an unreadable path with a clear error', async () => {
    await expect(loadPlanAsDiff(join(dir, 'nope.md'))).rejects.toThrow(/Could not read plan file/);
  });

  it('rejects oversized plans', async () => {
    const path = join(dir, 'huge.md');
    await writeFile(path, 'x'.repeat(500_000));
    await expect(loadPlanAsDiff(path)).rejects.toThrow(/exceeds/);
  });
});
