import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import { MAX_REVIEW_CAPACITY } from '../prepare/chunker.js';
import { MAX_BLOCKING_CALLS_HARD_LIMIT } from '../output/progress.js';
import type { GitHubTarget } from './github.js';
import { createGitHubClient, getGitHubPullRequest } from './github-client.js';

export interface PRCapacityAuthorization {
  maxReviewChunks: number;
  maxBlockingCalls: number;
  headSha: string;
}

type PullRequest = RestEndpointMethodTypes['pulls']['get']['response']['data'];
type IssueEvent = RestEndpointMethodTypes['issues']['listEvents']['response']['data'][number];
/**
 * A grant is three labels, each applied by a repository writer: the exact-head
 * marker and one label per limit. The limits live in the label names, never in
 * a description: a description is repository-level and editable after the
 * application, but each application event records who applied that exact name.
 */
type CapacityLabels = { names: string[]; allocation: PRCapacityAuthorization };
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 10;

function eventLabelName(event: IssueEvent): string | undefined {
  return 'label' in event && event.label && typeof event.label === 'object'
    ? event.label.name
    : undefined;
}

class CapacityRefused extends Error {
  constructor(reason: string) {
    super(`PR capacity authorization refused: ${reason}`);
  }
}

function capacityLabels(pr: PullRequest): CapacityLabels | undefined {
  const present = pr.labels.map(label => label.name).filter(name => /^rcl-cap(?:[/-]|$)/i.test(name));
  if (present.length === 0) return undefined;
  const heads = present.filter(name => /^rcl-cap(?:\/|$)/i.test(name));
  const chunks = present.filter(name => /^rcl-cap-chunks\//i.test(name));
  const calls = present.filter(name => /^rcl-cap-calls\//i.test(name));
  if (heads.length > 1 || chunks.length > 1 || calls.length > 1 ||
      heads.length + chunks.length + calls.length !== present.length) {
    throw new CapacityRefused('ambiguous capacity labels.');
  }
  if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || heads[0] !== `rcl-cap/${pr.head.sha}`) {
    throw new CapacityRefused('the capacity label must name the exact current PR head.');
  }
  if (chunks.length === 0 || calls.length === 0) {
    throw new CapacityRefused('expected one rcl-cap-chunks/<n> and one rcl-cap-calls/<n> label.');
  }
  // No whitespace, coercion, implicit defaults, or trailing fields in a grant.
  const chunkMatch = /^rcl-cap-chunks\/([1-9][0-9]*)$/.exec(chunks[0]!);
  const callMatch = /^rcl-cap-calls\/([1-9][0-9]*)$/.exec(calls[0]!);
  if (!chunkMatch || !callMatch) {
    throw new CapacityRefused('expected labels rcl-cap-chunks/<n> and rcl-cap-calls/<n>.');
  }
  const maxReviewChunks = Number(chunkMatch[1]);
  const maxBlockingCalls = Number(callMatch[1]);
  if (!Number.isSafeInteger(maxReviewChunks) || maxReviewChunks > MAX_REVIEW_CAPACITY.maxChunks ||
      !Number.isSafeInteger(maxBlockingCalls) || maxBlockingCalls > MAX_BLOCKING_CALLS_HARD_LIMIT) {
    throw new CapacityRefused('capacity limits exceed the supported hard bounds.');
  }
  return {
    names: [heads[0]!, chunks[0]!, calls[0]!],
    allocation: { maxReviewChunks, maxBlockingCalls, headSha: pr.head.sha },
  };
}

async function latestApplications(
  client: Octokit, target: GitHubTarget, names: string[]
): Promise<Map<string, IssueEvent>> {
  const wanted = new Map(names.map(name => [name.toLowerCase(), name]));
  const ids = new Set<number>();
  const latest = new Map<string, IssueEvent>();
  let pages = 0;
  // REST issue events have no documented ordering guarantee. Read complete
  // bounded history, retaining only matching IDs and the latest transition of
  // each capacity label. One overflow page detects incompleteness without
  // collecting the history.
  for await (const { data: events } of client.paginate.iterator(client.issues.listEvents, {
    owner: target.owner, repo: target.repo, issue_number: target.number, per_page: HISTORY_PAGE_SIZE,
  })) {
    if (++pages > MAX_HISTORY_PAGES || events.length > HISTORY_PAGE_SIZE) {
      throw new CapacityRefused('capacity label history exceeds the 1000-event limit.');
    }
    for (const event of events) {
      if (event.event !== 'labeled' && event.event !== 'unlabeled') continue;
      const key = eventLabelName(event)?.toLowerCase();
      if (key === undefined || !wanted.has(key)) continue;
      const createdAt = Date.parse(event.created_at);
      if (!Number.isSafeInteger(event.id) || event.id < 1 || ids.has(event.id) ||
          !Number.isFinite(createdAt)) {
        throw new CapacityRefused('ambiguous capacity label history.');
      }
      ids.add(event.id);
      const current = latest.get(key);
      // IDs disambiguate transitions within GitHub's timestamp precision.
      if (!current || createdAt > Date.parse(current.created_at) ||
          createdAt === Date.parse(current.created_at) && event.id > current.id) latest.set(key, event);
    }
  }
  const applications = new Map<string, IssueEvent>();
  for (const name of names) {
    const event = latest.get(name.toLowerCase());
    if (!event || event.event !== 'labeled' || eventLabelName(event) !== name ||
        !event.actor?.login || !Number.isSafeInteger(event.actor.id) || event.actor.id < 1) {
      throw new CapacityRefused('a capacity label is removed or has no attributable application.');
    }
    applications.set(name, event);
  }
  return applications;
}

/**
 * Resolve a live, exact-head capacity grant from GitHub metadata. An ordinary
 * PR returns undefined; any present but unverifiable opt-in fails closed.
 * PRs with more than 1000 issue events cannot opt in: each history scan is
 * limited to ten 100-event pages and one overflow request.
 * The caller must compare headSha with the diff it actually reviews.
 */
export async function resolvePRCapacity(
  target: GitHubTarget,
  token?: string,
  octokit?: Octokit,
): Promise<PRCapacityAuthorization | undefined> {
  try {
    const client = octokit ?? await createGitHubClient(token);
    const initial = capacityLabels((await getGitHubPullRequest(client, target)).data);
    if (!initial) return undefined;

    const authentication = await client.auth() as { type?: string; token?: string };
    if (authentication?.type !== 'token' || !authentication.token?.trim()) {
      throw new CapacityRefused('authenticated GitHub metadata is required.');
    }
    const applications = await latestApplications(client, target, initial.names);
    // Every label is a separate paid-spend decision: each one's latest
    // application must come from an actor with current write permission.
    const checked = new Set<number>();
    for (const application of applications.values()) {
      const actor = application.actor!;
      if (checked.has(actor.id)) continue;
      const { data: permission } = await client.repos.getCollaboratorPermissionLevel({
        owner: target.owner, repo: target.repo, username: actor.login,
      });
      // permission is GitHub's effective base permission; role_name may be an
      // arbitrary custom role. Never authorize from its name or author association.
      if (!['write', 'maintain', 'admin'].includes(permission.permission) ||
          permission.user?.id !== actor.id ||
          permission.user.login.toLowerCase() !== actor.login.toLowerCase()) {
        throw new CapacityRefused('the applying actor lacks verified current repository write permission.');
      }
      checked.add(actor.id);
    }

    const rechecked = capacityLabels((await getGitHubPullRequest(client, target)).data);
    if (rechecked === undefined || rechecked.names.join('\n') !== initial.names.join('\n') ||
        rechecked.allocation.headSha !== initial.allocation.headSha) {
      throw new CapacityRefused('capacity label or PR head changed during authorization.');
    }
    // Bind the final PR snapshot to the original approvals: a remove/reapply
    // during that read must not reuse a previous actor's permission check.
    const recheckedApplications = await latestApplications(client, target, initial.names);
    for (const [name, application] of applications) {
      const again = recheckedApplications.get(name);
      if (again?.id !== application.id ||
          again.actor?.id !== application.actor?.id ||
          again.actor?.login !== application.actor?.login ||
          again.created_at !== application.created_at) {
        throw new CapacityRefused('capacity label application changed during authorization.');
      }
    }
    return initial.allocation;
  } catch (error) {
    if (error instanceof CapacityRefused) throw error;
    // API failures can carry credentials or response bodies. They confer no
    // authority and must never be interpreted as an absent optional label.
    throw new CapacityRefused('GitHub metadata or permission could not be verified.');
  }
}

/**
 * Hosted attested reviews take capacity only from an authorized exact-head
 * label grant; a CLI flag may repeat the grant but never replace or raise it.
 */
export function assertAttestedCapacityGrant(
  flags: { maxReviewChunks?: string | undefined; maxBlockingCalls?: string | undefined },
  grant: PRCapacityAuthorization | undefined,
): void {
  if (!grant) {
    if (flags.maxReviewChunks !== undefined || flags.maxBlockingCalls !== undefined) {
      throw new Error('An attested PR review takes capacity only from an authorized exact-head PR capacity label grant; remove --max-review-chunks and --max-blocking-calls.');
    }
    return;
  }
  if ((flags.maxReviewChunks !== undefined && flags.maxReviewChunks !== String(grant.maxReviewChunks)) ||
      (flags.maxBlockingCalls !== undefined && flags.maxBlockingCalls !== String(grant.maxBlockingCalls))) {
    throw new Error('CLI review capacity conflicts with the authorized exact-head PR capacity label.');
  }
}
