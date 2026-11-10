import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isGitHubTarget, parseGitHubTarget } from '../resolver/github.js';
import { convergeRunStatePath } from './run-state.js';

/**
 * The native target keys a `converge-status --target` value can name (RCL-235).
 *
 * A converge target is a free-form key, and a pull request loop launches under
 * one of two spellings: the sanitized `<repo>-<N>` slug the rcl-converge skill
 * passes (and `rcl review` derives when no `--converge-target` is given), or
 * the `owner/repo#N` form that also attributes a patch run to its pull
 * request. A caller that names the pull request by the other spelling, or by
 * its URL, reads a key that holds no state and sees `not_launched` for a round
 * that is running or finished.
 */
export class UnsupportedConvergeTargetForm extends Error {
  constructor(target: string) {
    super(`converge_target_form_unsupported: "${target}" is not a target key, owner/repo#N or a GitHub pull request URL. ` +
      'Name the key the round launched under, or the pull request as owner/repo#N.');
    this.name = 'UnsupportedConvergeTargetForm';
  }
}

/** A value shaped like a pull request reference that no accepted form covers: `#17256`, `17256`, an issue URL. */
function looksLikeUnsupportedReference(target: string): boolean {
  return /^#?\d+$/.test(target) || /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.includes('#');
}

/**
 * The key as typed first, then the keys a pull request reference stands for:
 * the slug as the skill writes it (case kept, characters outside
 * `[A-Za-z0-9._-]` replaced), as `rcl review` derives it (repo lowercased) and
 * as `owner/repo#N`, so a URL reads a round launched under that short form.
 * Any other value is its own and only key.
 */
export function convergeTargetCandidates(input: string): { key: string; aliases: string[] } {
  const key = input.trim();
  if (!isGitHubTarget(key)) return { key, aliases: [] };
  const { owner, repo, number } = parseGitHubTarget(key);
  const slug = `${repo.replace(/[^A-Za-z0-9._-]+/g, '-')}-${number}`;
  const aliases = [...new Set([slug, `${repo.toLowerCase()}-${number}`, `${owner}/${repo}#${number}`])].filter(alias => alias !== key);
  return { key, aliases };
}

/** Whether the value is a reference form that cannot resolve to a key, so a miss must refuse instead of reading as idle. */
export function isUnsupportedConvergeTargetForm(input: string): boolean {
  const key = input.trim();
  return !isGitHubTarget(key) && looksLikeUnsupportedReference(key);
}

const STATE_NAME_SLUG_LIMIT = 48; // run-state.ts stateBaseName cuts the slug here, then appends `-` and a 16 digit hash and `.json`
const STATE_NAME_CUT_LENGTH = STATE_NAME_SLUG_LIMIT + '-'.length + 16 + '.json'.length;
const RECORDED_REFERENCE_KEY = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/;

/**
 * The `owner/repo#N` keys a `<repo>-<N>` slug stands for, read from the targets
 * the repository already recorded: a slug names no owner, so the keys cannot be
 * derived, only found. One git common dir holds one repository's pull requests,
 * so a repository-only match is the same pull request.
 *
 * The state file name carries the target's sanitized slug, which narrows the
 * candidates before any file is opened; a name cut at the length limit may hide
 * the number, so it stays a candidate when it still names the repository. The
 * recorded `target` decides.
 */
export async function recordedReferenceKeys(gitCommonDir: string, input: string): Promise<string[]> {
  const slug = /^(.+)-(\d+)$/.exec(input.trim());
  if (!slug) return [];
  const [, repo, number] = slug as unknown as [string, string, string];
  const directory = dirname(convergeRunStatePath(gitCommonDir, input.trim()));
  // Only a missing directory is an empty one: any other failure means the recorded keys are unknown, and an
  // answer built on that would read as a reliable miss.
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const repoSlug = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const candidates = names.filter(name => name.endsWith('.json') && (name.toLowerCase().includes(`-${repoSlug}-${number}-`)
    || (name.length >= STATE_NAME_CUT_LENGTH && name.toLowerCase().includes(`-${repoSlug}`))));
  const keys: Array<string | undefined> = [];
  for (const name of candidates) { // one at a time: a status poll must not open every long-named state file at once
    try {
      const { target } = JSON.parse(await readFile(join(directory, name), 'utf8')) as { target?: unknown };
      const reference = typeof target === 'string' ? RECORDED_REFERENCE_KEY.exec(target) : null;
      keys.push(reference && reference[2]!.toLowerCase() === repo.toLowerCase() && reference[3] === number ? target as string : undefined);
    } catch { keys.push(undefined); } // an unreadable or foreign file is not this target's record
  }
  return [...new Set(keys.filter((key): key is string => key !== undefined))];
}
