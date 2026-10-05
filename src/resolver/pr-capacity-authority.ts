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
type CapacityLabel = { name: string; description: string; allocation: PRCapacityAuthorization };
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

function capacityLabel(pr: PullRequest): CapacityLabel | undefined {
  const labels = pr.labels.filter(label => /^rcl-cap(?:\/|$)/i.test(label.name));
  if (labels.length === 0) return undefined;
  if (labels.length !== 1) throw new CapacityRefused('ambiguous capacity labels.');
  const label = labels[0]!;
  if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || label.name !== `rcl-cap/${pr.head.sha}`) {
    throw new CapacityRefused('the capacity label must name the exact current PR head.');
  }
  const description = label.description;
  if (typeof description !== 'string') {
    throw new CapacityRefused('expected label description chunks=<n>;calls=<n>.');
  }
  // No whitespace, coercion, implicit defaults, or trailing fields in a grant.
  const match = /^chunks=([1-9][0-9]*);calls=([1-9][0-9]*)$/.exec(description);
  if (!match || match[0] !== description) {
    throw new CapacityRefused('expected label description chunks=<n>;calls=<n>.');
  }
  const maxReviewChunks = Number(match[1]);
  const maxBlockingCalls = Number(match[2]);
  if (!Number.isSafeInteger(maxReviewChunks) || maxReviewChunks > MAX_REVIEW_CAPACITY.maxChunks ||
      !Number.isSafeInteger(maxBlockingCalls) || maxBlockingCalls > MAX_BLOCKING_CALLS_HARD_LIMIT) {
    throw new CapacityRefused('capacity limits exceed the supported hard bounds.');
  }
  return { name: label.name, description, allocation: { maxReviewChunks, maxBlockingCalls, headSha: pr.head.sha } };
}

async function latestApplication(client: Octokit, target: GitHubTarget, name: string): Promise<IssueEvent> {
  const ids = new Set<number>();
  let pages = 0, latest: IssueEvent | undefined;
  // REST issue events have no documented ordering guarantee. Read complete
  // bounded history, retaining only matching IDs and the latest transition.
  // One overflow page detects incompleteness without collecting the history.
  for await (const { data: events } of client.paginate.iterator(client.issues.listEvents, {
    owner: target.owner, repo: target.repo, issue_number: target.number, per_page: HISTORY_PAGE_SIZE,
  })) {
    if (++pages > MAX_HISTORY_PAGES || events.length > HISTORY_PAGE_SIZE) {
      throw new CapacityRefused('capacity label history exceeds the 1000-event limit.');
    }
    for (const event of events) {
      if ((event.event !== 'labeled' && event.event !== 'unlabeled') ||
          eventLabelName(event)?.toLowerCase() !== name.toLowerCase()) continue;
      const createdAt = Date.parse(event.created_at);
      if (!Number.isSafeInteger(event.id) || event.id < 1 || ids.has(event.id) ||
          !Number.isFinite(createdAt)) {
        throw new CapacityRefused('ambiguous capacity label history.');
      }
      ids.add(event.id);
      // IDs disambiguate transitions within GitHub's timestamp precision.
      if (!latest || createdAt > Date.parse(latest.created_at) ||
          createdAt === Date.parse(latest.created_at) && event.id > latest.id) latest = event;
    }
  }
  if (!latest || latest.event !== 'labeled' || eventLabelName(latest) !== name ||
      !latest.actor?.login || !Number.isSafeInteger(latest.actor.id) || latest.actor.id < 1) {
    throw new CapacityRefused('capacity label is removed or has no attributable application.');
  }
  return latest;
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
    const initial = capacityLabel((await getGitHubPullRequest(client, target)).data);
    if (!initial) return undefined;

    const authentication = await client.auth() as { type?: string; token?: string };
    if (authentication?.type !== 'token' || !authentication.token?.trim()) {
      throw new CapacityRefused('authenticated GitHub metadata is required.');
    }
    const application = await latestApplication(client, target, initial.name);
    const actor = application.actor!;
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

    const rechecked = capacityLabel((await getGitHubPullRequest(client, target)).data);
    if (rechecked?.name !== initial.name || rechecked.description !== initial.description) {
      throw new CapacityRefused('capacity label or PR head changed during authorization.');
    }
    // Bind the final PR snapshot to the original approval: a remove/reapply
    // during that read must not reuse the previous actor's permission check.
    const recheckedApplication = await latestApplication(client, target, initial.name);
    if (recheckedApplication.id !== application.id ||
        recheckedApplication.actor?.id !== actor.id ||
        recheckedApplication.actor.login !== actor.login ||
        recheckedApplication.created_at !== application.created_at) {
      throw new CapacityRefused('capacity label application changed during authorization.');
    }
    return initial.allocation;
  } catch (error) {
    if (error instanceof CapacityRefused) throw error;
    // API failures can carry credentials or response bodies. They confer no
    // authority and must never be interpreted as an absent optional label.
    throw new CapacityRefused('GitHub metadata or permission could not be verified.');
  }
}
