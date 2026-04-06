import { writeFile } from 'fs/promises';
import type { ReviewResult } from '../consensus/types.js';

export function toJson(result: ReviewResult, pretty = true): string {
  return JSON.stringify(result, null, pretty ? 2 : 0);
}

export async function writeJsonOutput(result: ReviewResult, path: string): Promise<void> {
  await writeFile(path, toJson(result), 'utf-8');
}
