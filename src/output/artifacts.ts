import { writeFile } from 'node:fs/promises';
import type { ReviewResult } from '../consensus/types.js';
import type { ArtifactBytes } from '../telemetry/envelope.js';
import { scrubText } from '../telemetry/scrub.js';
import { toJson } from './json.js';
import { toMarkdown } from './markdown.js';

/** Render once, so requested files and evidence delivery carry identical bytes. */
export function renderReportArtifacts(result: ReviewResult): ArtifactBytes {
  return { report_json: toJson(result), report_md: toMarkdown(result) };
}

/** Try every requested output and retain write failures for evidence delivery. */
export async function writeReportArtifacts(
  artifacts: ArtifactBytes,
  paths: { jsonFile?: string; markdown?: string; exclusive?: boolean },
  callbacks: { onWritten?: (label: string, path: string) => void; onError?: (message: string) => void } = {}
): Promise<Array<{ path: string; message: string }>> {
  const diagnostics: Array<{ path: string; message: string }> = [];
  for (const [kind, path, label] of [
    ['report_json', paths.jsonFile, 'JSON'], ['report_md', paths.markdown, 'Markdown'],
  ] as const) {
    if (!path) continue;
    try {
      await writeFile(path, artifacts[kind] ?? '', paths.exclusive ? { encoding: 'utf-8', flag: 'wx' } : 'utf-8');
      callbacks.onWritten?.(label, path);
    } catch (error) {
      const message = `Could not write ${label}: ${scrubText(String(error), 300)}`;
      diagnostics.push({ path: `output.${kind}`, message });
      callbacks.onError?.(message);
    }
  }
  return diagnostics;
}
