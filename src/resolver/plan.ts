import { readFile } from 'fs/promises';
import type { Diff } from './types.js';

/**
 * Plans beyond this size are not reviewable in one council pass anyway;
 * failing loudly beats silently truncating what the models see. (The
 * chunker additionally splits/truncates at its own line limits.)
 */
const MAX_PLAN_BYTES = 400_000;

/**
 * Load a plan document as a synthetic single-file diff (the whole document
 * as added lines) so the entire review pipeline — chunking, prompts,
 * dedup, consensus, output — works unchanged. Finding line numbers map
 * 1:1 onto plan document lines because the synthetic hunk starts at +1.
 */
export async function loadPlanAsDiff(path: string): Promise<Diff> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`Could not read plan file: ${path}`);
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_PLAN_BYTES) {
    throw new Error(
      `Plan file exceeds ${MAX_PLAN_BYTES / 1000}KB: ${path}. Split it or review a section.`
    );
  }
  if (!content.trim()) {
    throw new Error(`Plan file is empty: ${path}`);
  }

  const lines = content.replace(/\n$/, '').split('\n');
  const patch = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join('\n');

  return {
    files: [
      {
        filename: path,
        status: 'added',
        additions: lines.length,
        deletions: 0,
        patch,
        language: 'plan',
      },
    ],
    source: 'local',
  };
}
