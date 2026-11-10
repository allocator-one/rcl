import { isGitHubTarget, parseGitHubTarget } from '../resolver/github.js';

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
