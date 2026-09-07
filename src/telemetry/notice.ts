import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * The individual consent notice (epic IO-12475, section 8.7): the first
 * delivery from a machine to a given Harness host prints what is sent and
 * where; `<data dir>/telemetry-notice` records that it was shown. The
 * org-level switch is the organizational consent; this is the personal one.
 */

export const NOTICE_FILE = 'telemetry-notice';

interface NoticeRecord {
  shown: Record<string, string>;
}

async function readRecord(path: string): Promise<NoticeRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const shown = (parsed as { shown?: unknown } | null)?.shown;
    if (typeof shown === 'object' && shown !== null && !Array.isArray(shown)) {
      const clean: Record<string, string> = {};
      for (const [host, at] of Object.entries(shown as Record<string, unknown>)) {
        if (typeof at === 'string') clean[host] = at;
      }
      return { shown: clean };
    }
  } catch {
    // Missing or malformed reads as "never shown".
  }
  return { shown: {} };
}

export function noticeText(host: string): string {
  return [
    `Review Council now records evidence of this review on ${host}: the run header (commit, roster,`,
    'settings digests), consensus findings and reviewer call statistics, plus the JSON and Markdown',
    'reports as written. Never sent: API keys, tokens, prompts or raw model answers. Switch it off with',
    '`harness.telemetry: off` in .rclrc, `--no-telemetry`, or RCL_TELEMETRY=off. This notice shows once per host.',
  ].join('\n');
}

/**
 * Print the notice for `host` unless this machine has shown it before.
 * Returns whether it was printed. Failures to persist the record are
 * swallowed: a read-only data dir must not stop a review.
 */
export async function ensureNoticeShown(
  host: string,
  dataDir: string,
  write: (text: string) => void
): Promise<boolean> {
  const path = join(dataDir, NOTICE_FILE);
  const record = await readRecord(path);
  if (record.shown[host] !== undefined) return false;
  write(noticeText(host));
  record.shown[host] = new Date().toISOString();
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Shown, not recorded — it will show again next time, which is the safe side.
  }
  return true;
}
