import { describe, expect, it } from 'vitest';
import { buildPrompt, type ContextDoc } from '../../src/prepare/prompt-builder.js';
import { chunkDiff, formatChunkForPrompt } from '../../src/prepare/chunker.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { capturePreparedCouncil } from '../../src/dispatch/capture-council.js';
import type { Config } from '../../src/config/schema.js';
import type { Diff, FileChange } from '../../src/resolver/types.js';
import type { ReviewAssignment } from '../../src/roles/types.js';

const role = { name: 'general', systemPrompt: 'Review carefully.', focus: [], description: 'General', isSpecialized: false };
const assignments: ReviewAssignment[] = [
  { model: 'openai/gpt-5.6-sol', provider: 'openai', role },
  { model: 'openai/gpt-5.6-sol', provider: 'openai', role: { ...role } },
];
function file(filename: string, patch: string): FileChange {
  return { filename, status: 'modified', patch, additions: 2001, deletions: 0, language: 'typescript' };
}
async function fixture() {
  const patch = `@@ -0,0 +1,2001 @@\n${Array.from({ length: 2001 }, (_, i) => `+line ${i + 1}`).join('\n')}\n`;
  const diff: Diff = { source: 'local', files: [file('z.ts', patch), file('a.ts', patch)] };
  const chunks = chunkDiff(diff.files);
  expect(chunks.length).toBeGreaterThan(1);
  const contextDocs: ContextDoc[] = [{ label: 'rules.md', content: 'Exact rules', sha256: sha256Hex('Exact rules') }];
  const prompts = await Promise.all(chunks.flatMap(chunk => assignments.map(assignment => buildPrompt(chunk, assignment.role, { contextDocs }))));
  const config: Config = { models: ['openai/gpt-5.6-sol'], quorumFraction: 2 / 3, githubToken: 'never-captured', harness: { telemetry: 'full' } };
  return { target: 'allocator-one/allocator-one#9165', headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), diff, chunks, assignments, prompts, config, specBytes: 'exact spec bytes', contextDocs, compatibility: { parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 1 } } };
}

describe('capture prepared council', () => {
  it('freezes and round-trips actual prepared prompts as chunk-major cells with distinct assignment-index seats', async () => {
    const input = await fixture();
    const result = capturePreparedCouncil(input);
    expect(result.plan.cells.map(cell => cell.id)).toEqual(input.chunks.flatMap((chunk, chunkIndex) => assignments.map((_, seat) => `assignment:${seat}:${chunkIndex}`)));
    expect(result.plan.roster.map(seat => seat.seat)).toEqual(['assignment:0', 'assignment:1']);
    expect(result.captured.prompts).toEqual(input.prompts);
    expect(result.captured.assignments).toEqual(input.chunks.flatMap(() => assignments));
    expect(result.captured.config.githubToken).toBeUndefined();
    expect(result.captured.config.harness).toBeUndefined();
    expect(result.aggregation).toEqual(input.compatibility.aggregation);
    expect(Object.isFrozen(result.plan)).toBe(true);
  });

  it('uses the existing diff/config digest meanings and is insensitive to irrelevant base tip data', async () => {
    const input = await fixture();
    const reversed = { ...input, diff: { ...input.diff, files: [...input.diff.files].reverse() } };
    const result = capturePreparedCouncil(input);
    expect(capturePreparedCouncil({ ...input, baseTip: 'upstream-tip-changed' }).plan.digest).toBe(result.plan.digest);
    expect(result.patchBytes).toBe(stableStringify([...input.diff.files].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0).map(f => ({ filename: f.filename, status: f.status, previousFilename: f.previousFilename ?? null, patch: f.patch, additions: f.additions, deletions: f.deletions, blobSha: f.blobSha ?? null }))));
    expect(sha256Hex(result.patchBytes)).toBe(diffDigest(input.diff.files));
    expect(diffDigest(reversed.diff.files)).toBe(diffDigest(input.diff.files));
    expect(result.plan.configSha256).toBe(configDigest(input.config));
    expect(result.configBytes).not.toContain('never-captured');
    expect(result.configBytes).not.toContain('harness');
  });

  it('refuses regenerated/misaligned material inputs instead of recapturing them', async () => {
    const input = await fixture();
    expect(() => capturePreparedCouncil({ ...input, prompts: input.prompts.slice(1) })).toThrow('capture_council_incomplete_matrix');
    const changed = { ...input, diff: { ...input.diff, files: [{ ...input.diff.files[0]!, patch: `${input.diff.files[0]!.patch} +changed` }, ...input.diff.files.slice(1)] } };
    expect(() => capturePreparedCouncil(changed)).toThrow();
  });
});
