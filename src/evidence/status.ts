import { resolveHarnessCredential } from '../telemetry/credentials.js';
import { describeOutcome, HarnessSink } from '../telemetry/sink.js';
import { formatGateStatus, safeJson, text } from './format.js';
import { needsRemote, parsePullRequestArg, resolveRemoteRepo, type RepoRef } from './target.js';

/**
 * `rcl evidence status [<pr>]` (RCL-41): the gate status Harness computed for
 * a pull request — never the client's own claim. The exit code is the
 * contract the skills gate on: 0 only when the judged projection (advisory by
 * default, `--enforced` on request) is `converged`; 1 for every other
 * status; 2 when the pull request cannot be named; 3 when the read could not
 * be answered (no credential, evidence off for the organization, unknown
 * pull request, refused credential, unreachable host) — an unanswered read is
 * never "not converged".
 */

export const EVIDENCE_EXIT = { converged: 0, notConverged: 1, usage: 2, unanswered: 3 } as const;

export interface EvidenceDeps {
  rclVersion: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  cwd?: string;
  credentialsPath?: string;
  /** The repository the checkout's `origin` names; injected by tests. */
  remoteRepo?: () => Promise<RepoRef | null>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface StatusOptions {
  json?: boolean;
  enforced?: boolean;
}

/**
 * A sink for reads, from the same credential rules as delivery — the stored
 * login or the `HARNESS_API_TOKEN` + `HARNESS_API_URL` pair, the token sent
 * to its own host only — but independent of the telemetry level: switching
 * delivery off does not blind the reads.
 */
export async function openSink(deps: EvidenceDeps): Promise<HarnessSink | null> {
  const resolved = await resolveHarnessCredential({
    env: deps.env ?? process.env,
    cwd: deps.cwd ?? process.cwd(),
    ...(deps.credentialsPath !== undefined ? { credentialsPath: deps.credentialsPath } : {}),
    requireRepo: false,
  });
  if (!resolved.credential) {
    deps.stderr(`Cannot read evidence: ${resolved.note ?? 'no Harness credential'}`);
    return null;
  }
  return new HarnessSink({
    credential: resolved.credential,
    rclVersion: deps.rclVersion,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

export async function runEvidenceStatus(
  prArg: string | undefined,
  options: StatusOptions,
  deps: EvidenceDeps
): Promise<number> {
  if (prArg === undefined || prArg.trim() === '') {
    deps.stderr('Name the pull request: N or #N (against the current git remote), owner/repo#N, or its URL.');
    return EVIDENCE_EXIT.usage;
  }
  let target;
  try {
    const remote = needsRemote(prArg)
      ? await (deps.remoteRepo ?? (() => resolveRemoteRepo(deps.cwd ?? process.cwd())))()
      : null;
    target = parsePullRequestArg(prArg, remote);
  } catch (err) {
    // The argument or the remote may be the reason; neither reaches the terminal raw.
    deps.stderr(text(err instanceof Error ? err.message : String(err), 400));
    return EVIDENCE_EXIT.usage;
  }

  const sink = await openSink(deps);
  if (!sink) return EVIDENCE_EXIT.unanswered;

  const outcome = await sink.getGateStatus(target.owner, target.repo, target.number);
  const name = text(`${target.owner}/${target.repo}#${target.number}`, 200);
  if (outcome.kind !== 'ok') {
    deps.stderr(`Cannot read the gate status of ${name}: ${describeOutcome(outcome)}`);
    return EVIDENCE_EXIT.unanswered;
  }

  const status = outcome.value;
  const judged = options.enforced ? 'enforced' : 'advisory';
  if (options.json) {
    deps.stdout(safeJson(status));
  } else {
    for (const line of formatGateStatus(status, judged)) deps.stdout(line);
  }
  return status[judged].status === 'converged' ? EVIDENCE_EXIT.converged : EVIDENCE_EXIT.notConverged;
}
