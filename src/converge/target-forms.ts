import { open, readdir } from 'node:fs/promises';
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
export function convergeTargetCandidates(input: string): { key: string; aliases: string[]; owner?: string } {
  const key = input.trim();
  if (!isGitHubTarget(key)) return { key, aliases: [] };
  const { owner, repo, number } = parseGitHubTarget(key);
  const slug = `${repo.replace(/[^A-Za-z0-9._-]+/g, '-')}-${number}`;
  const aliases = [...new Set([slug, `${repo.toLowerCase()}-${number}`, `${owner}/${repo}#${number}`])].filter(alias => alias !== key);
  return { key, aliases, owner };
}

/** Whether the value is a reference form that cannot resolve to a key, so a miss must refuse instead of reading as idle. */
export function isUnsupportedConvergeTargetForm(input: string): boolean {
  const key = input.trim();
  return !isGitHubTarget(key) && looksLikeUnsupportedReference(key);
}

const STATE_NAME_SLUG_LIMIT = 48; // run-state.ts stateBaseName cuts the slug here, then appends `-` and a 16 digit hash and `.json`
const STATE_NAME_SUFFIX_LENGTH = '-'.length + 16 + '.json'.length;
const STATE_NAME_CUT_LENGTH = STATE_NAME_SLUG_LIMIT + STATE_NAME_SUFFIX_LENGTH;
const MAX_GITHUB_OWNER_LENGTH = 39;
const STATE_HEADER_BYTES = 1024; // run-state.ts writes `version` then `target` first, so the key sits in the first lines
const STATE_HEADER_TARGET = /"target"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const RECORDED_REFERENCE_KEY = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/;

/**
 * Whether a state file name cut at the slug limit can still be `<owner>-<repoSlug>-<number>`: GitHub owners are at
 * most 39 characters, so the name's slug holds `<owner>-` and then a prefix of `<repoSlug>-<number>`. A cut name
 * that cannot be is another target's, and its unreadable contents are none of this lookup's business.
 */
function cutNameMayRecordReference(name: string, repoSlug: string, number: string): boolean {
  const slug = name.slice(0, name.length - STATE_NAME_SUFFIX_LENGTH).toLowerCase();
  const rest = `${repoSlug}-${number}`;
  for (let dash = slug.indexOf('-'); dash !== -1 && dash <= MAX_GITHUB_OWNER_LENGTH; dash = slug.indexOf('-', dash + 1)) {
    if (dash > 0 && rest.startsWith(slug.slice(dash + 1))) return true;
  }
  return false;
}

/** The `target` a state file records, read from its first bytes so a long file costs no more than a short one. */
async function recordedTarget(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const { bytesRead, buffer } = await file.read(Buffer.alloc(STATE_HEADER_BYTES), 0, STATE_HEADER_BYTES, 0);
    const found = STATE_HEADER_TARGET.exec(buffer.toString('utf8', 0, bytesRead));
    if (!found) throw new Error(`converge_state_unreadable: no target in the first ${STATE_HEADER_BYTES} bytes of ${path}`);
    return JSON.parse(`"${found[1]}"`) as string;
  } finally { await file.close(); }
}

/**
 * The `owner/repo#N` keys a `<repo>-<N>` slug stands for, read from the targets
 * the repository already recorded: a slug names no owner, so the keys cannot be
 * derived, only found. A request that names an owner keeps only that owner's
 * keys; a bare slug that matches more than one owner's refuses as ambiguous
 * instead of picking the latest.
 *
 * The state file name carries the target's sanitized slug, which narrows the
 * candidates before any file is opened. A name cut at the length limit may have
 * lost part of the repository or the number, so it stays a candidate when it can
 * still be `<owner>-<repo>-<N>`; the recorded `target` decides, read one file at
 * a time from its first bytes. A listing or read of a candidate that fails
 * throws: a miss or a stale answer built on a failed discovery would read as a
 * round that was never launched or is not the latest.
 */
export async function recordedReferenceKeys(gitCommonDir: string, input: string, owner?: string): Promise<string[]> {
  const slug = /^(.+)-(\d+)$/.exec(input.trim());
  if (!slug) return [];
  const [, repo, number] = slug as unknown as [string, string, string];
  const directory = dirname(convergeRunStatePath(gitCommonDir, input.trim()));
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]; // only a missing directory is an empty one
    throw error;
  });
  const repoSlug = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const candidates = names.filter(name => name.endsWith('.json')
    && (name.length >= STATE_NAME_CUT_LENGTH ? cutNameMayRecordReference(name, repoSlug, number)
      : name.toLowerCase().includes(`-${repoSlug}-${number}-`)));
  const keys = new Set<string>();
  for (const name of candidates) {
    const target = await recordedTarget(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined; // removed since the listing
      throw error;
    });
    const reference = target === undefined ? null : RECORDED_REFERENCE_KEY.exec(target);
    if (reference && reference[2]!.toLowerCase() === repo.toLowerCase() && reference[3] === number
      && (owner === undefined || reference[1]!.toLowerCase() === owner.toLowerCase())) keys.add(target!);
  }
  const owners = new Set([...keys].map(key => key.slice(0, key.indexOf('/')).toLowerCase()));
  if (owners.size > 1) throw new Error(`converge_target_ambiguous: "${input.trim()}" matches recorded rounds of ${[...keys].join(', ')}. Name the pull request as owner/repo#N.`);
  return [...keys];
}
