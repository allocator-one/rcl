# Changelog

## Unreleased

- **Distinct report finding identities** (RCL-51): consensus findings that
  share a line-bucket anchor receive separate report keys, including findings
  below the report threshold. Native location matching and existing ledger
  identities are unchanged. Legacy reports with conflicting classifications
  for one report key fail before the round state is written, rather than
  silently discarding a mapping. Preserve those reports for supported recovery;
  this change does not relabel already-published evidence.

## 3.2.0 — 2026-09-08

- **`rcl review … --attest`** (RCL-40): inside the organization's gate
  workflow on GitHub Actions, rcl asks the runner for the job's OIDC token
  (audience: the Harness origin from `HARNESS_API_URL`), exchanges it at
  `POST /api/v1/reviews/attest` for a run-bound credential (`rbc_…`, thirty
  minutes, one run id, valid while the Actions run is in progress) and records
  the review under it — envelope, artifacts, model keys and model stats — so
  Harness stores the run as `credential_kind: attested`, the tier the enforced
  gate reads. Fails loudly before any token is requested or any reviewer is
  paid: outside Actions (`ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` unset),
  without `HARNESS_API_URL`, off a pull request target, with a telemetry level
  other than `full` (environment or project config), or when the exchange is
  refused (the reason is printed). Never falls back to `HARNESS_API_TOKEN` or
  the stored login, implies `--evidence-required`, never spools (the
  credential does not outlive the workflow run), and mints the credential
  again for the same run id before delivery when a long review has used up
  most of its thirty minutes.
- **`round_processed` carries the round's classification** (RCL-47):
  `identities: [{identity_key, matched_identity, status, suppress_reason?}]`
  — each sighting's own report key, the identity `converge-report` matched it
  to by location, and whether it was `new`, `repeat`, `suppressed` or
  `regating`. Harness applies a standing verdict to a key that moved with the
  code only when it knows the matched identity (IO-12601); without it a
  re-sighted fixed or dismissed finding reads as actionable and the gate says
  `unresolved` for a loop rcl judged converged. One entry per key; text goes
  through the usual scrubber.
## 3.1.0 — 2026-09-08

- **`rcl evidence status` reports a pull request nothing has been judged for**
  (RCL-44). Harness sends `conclusive: null` for a projection without a
  judged current-head run (status `none`, `stale`, `unverified`); the reader
  refused every such answer as malformed, so the command failed exactly where
  it should have said "no evidence yet". `conclusive` is now boolean or null,
  an unjudged projection prints without an `(inconclusive)` label, and the
  exit status is unchanged (`1`, not converged).
- **`rcl review … --for-pr owner/repo#N`** (RCL-39; `RCL_FOR_PR`): a
  patch-file review is bound to the pull request it was taken from
  (`target.repo`, `pr_number`, `url` on the `patch` target), so Harness can
  verify its `--head-sha` against that pull request's head; counting such a
  round for the pull request's gate is the server half, IO-12585 — until it
  lands, `rcl evidence status` still reads `stale`/`none` for patch-file loops.
  A `--converge-target` of the same form attributes the run too; the flag
  needs `--head-sha`, lower-cases the names, and is refused on PR and
  git-mode targets, which name their own (`RCL_FOR_PR` only ever attributes a
  patch file). The
  `rcl-converge` skill passes `--converge-target '<TARGET>' --round <R>
  --attempt <ATTEMPT>` on every launch and adds `--for-pr <owner/repo#N>` when
  the round reviews a patch file taken from the pull request (a pull request or
  git-mode target names its own), counts a
  spooled round as evidence only once its flush is acknowledged (ledger
  `evidence: pending` until then), reads `rcl evidence status` after the loop
  next to the machine resolution, and records that the converge ledger is
  rendered by Harness (IO-12482) rather than uploaded — the server accepts
  only artifacts a run declared at delivery.

- **Org-wide model weights** (RCL-38): `rcl models` merges Harness's
  `GET /api/v1/reviews/model-stats` (the organization's window over every run
  it recorded, backfilled history included) with this machine's store — the
  server's weight for a model it holds ≥ 20 outcomes for, the local weight
  below that, neutral for a model neither knows enough about — and shows each
  row's `source`; `--local` keeps to the machine. Reviews weight consensus the
  same way (`loadMergedWeights`, three-second bound, local fallback).
- **`rcl telemetry backfill --from <dir> --repo <owner/repo> [--dry-run] [--json]`**
  (RCL-38): pre-3.0 reports and converge ledgers become runs with
  `provenance: backfill` (synthesized header bound to the repository, findings
  with stable identities, reviewer calls, both report files as artifacts) and
  `verdicts_recorded` events; ids are UUIDv5 of `(host, repo, sha256 of the
  report)` so a second run adds nothing. `RunHeader.provenance` and `uuidv5`
  are new; `openReadSink` is the shared credential-only sink for reads.

- **`rcl evidence status [<pr>]` and `rcl evidence show <run id>`** (RCL-41):
  the read side of the evidence ledger. `status` fetches
  `GET /api/v1/reviews/prs/:owner/:repo/:number` — a bare `N` or `#N` is read
  against the checkout's `origin` remote, `owner/repo#N` and pull request URLs
  stand alone — and prints both projections, their rounds, the open actionable
  findings and the merge decision; `--json` prints the API object. Exit 0 only
  when the judged projection (`--enforced` or the default advisory) is
  `converged`, 1 for any other status, 2 when the pull request cannot be
  named, 3 when the read could not be answered (no credential, evidence off,
  unknown pull request, refused credential, unreachable host). `show` fetches
  `GET /api/v1/reviews/runs/:id` and lists the run's header, reviewer health,
  artifact state and findings with identity, gating reason and verdict. Reads
  use the delivery credential rules (`reviews:read`) and ignore the telemetry
  level. `HarnessSink` gained `getGateStatus` and `getRun`, each refusing an
  answer that is not about what was asked.

## 3.0.0 — 2026-09-07

Review Council evidence (epic IO-12475). **Behavior change:** in a
Harness-managed repository (one carrying `.harness-cli/config.json`) with a
`harness login`, a review now records itself on Harness by default — the run
header, consensus findings (which quote code), reviewer call statistics and
the JSON and Markdown reports as written. Hence the major version; every
report field is additive and pre-3.0 reports load unchanged.

- **`src/telemetry/`** (RCL-37): a pure, allow-listed `buildRunEnvelope`
  wraps the report's `run` header with wire-shaped findings and calls, the
  report's `stats`, the SHA-256 digests of the exact bytes written to
  `--json-file` / `--markdown`, and how the delivery came about. `HarnessSink`
  posts the envelope, PUTs each declared artifact and posts converge events
  under a 10 s timeout per request, sending the token only to the host that
  minted it. An `Outbox` at `~/.rcl/outbox/<run id>/` keeps what Harness could
  not take and retries it — same run id, `delivery: {mode: retried,
  spooled_at}` — at the start of every command (five-second bound) or via
  `rcl telemetry flush`; above 1 GB it stops spooling artifacts and reports the
  affected runs as a `loss` event on the next successful flush.
- **Credentials.** The stored `harness login` is the default; `HARNESS_API_TOKEN`
  + `HARNESS_API_URL` serve CI, and an environment token never pairs with the
  stored host (half a pair is an error, not a fallback). A base URL carries no
  user-info, query or fragment; a trailing slash is normalized away.
- **Configuration.** `harness.telemetry: off | envelope | findings | full`
  (default `full`), `--no-telemetry`, `RCL_TELEMETRY` (`off`, `0`, `false`,
  `no`, or a level name);
  `harness.parseFailures` opts in to a parse-failed call's raw answer (fenced
  code and key-shaped strings removed, 32 KB cap) — by default only the parser
  message travels.
- **`--evidence-required`** exits 4 when the evidence is incomplete — the
  envelope was not acknowledged (spooled, refused, or the org has evidence
  off), or a declared artifact was spooled or refused — and refuses a patch
  file without `--head-sha` and a run with `--no-telemetry`,
  `RCL_TELEMETRY=off` or `harness.telemetry: off`. Under `--ci` the gate's
  exit code wins; the evidence failure is printed beside it. At the
  `envelope` and `findings` levels the declared artifact digests still
  describe the reports rcl wrote — the server shows them as declared, not
  received — and evidence is complete once the envelope is acknowledged.
- **Consent.** The first delivery from a machine to a host prints a one-time
  notice; `~/.rcl/telemetry-notice` records it.
- **Status line.** `Evidence recorded: <url>` · `Evidence spooled (Harness
  unreachable); run rcl telemetry flush` · `Evidence not sent: <host> has not
  enabled review evidence for this organization`.
- **Converge events.** `converge-attempt` emits `attempt_claimed` (and
  `cap_changed` under `--max-attempts`), `converge-report` emits
  `round_processed` (and `cap_changed` under `--max-rounds`) and persists the
  round's run id in the run state, `converge-verdict` emits
  `verdicts_recorded` and `resolution` bound to that run id.
- **`rcl telemetry status | flush [--run <id>]`** for operators. Loss
  reports go out in batches and are only removed once the server accounts
  for every event; a refused batch is kept as `loss/<id>.json.refused`,
  listed by `status`, never retried. A flush bounded by a deadline bounds
  each request by what remains of it, and reports loss reports still
  pending.
- **Transport hardening.** Receipts larger than 64 KB are refused unread; a
  WHATWG opaque redirect reads as a redirect; the credential's URL is
  re-validated when the sink is built (`https`, or `http` to `localhost`,
  `127.0.0.0/8`, `::1` and `*.localhost` — the host comes from the login or
  the environment, never from the repository). The consent notice precedes
  the first transmission of any kind, converge events and flushes included.
- **Scrubbing.** Every free-text field that leaves the process (errors,
  warnings, runner claims, finding prose, consensus excerpts) is truncated and
  scrubbed for bearer/key-shaped substrings. The reports written to
  `--json-file` / `--markdown` are that same delivery view (a `parse_failed`
  call keeps only the parser message unless `harness.parseFailures` is set),
  so the uploaded artifacts are byte-identical to the files; with telemetry
  off the raw report is written as before.
- **Transport.** The Harness credential travels over TLS only, except to
  loopback hosts (a local development server); a 401 keeps a spooled entry
  for retry after re-login instead of failing it for good.
- The rcl and rcl-converge skills document the evidence line, the
  `--evidence-required` flush-retry rule (five minutes, then stop the loop),
  and the opt-outs.

Phase 0 of the Review Council evidence ledger (RCL-36, epic IO-12475): the
report now says what it reviewed. The one network change: PR mode now
fetches the changed files through a compare pinned to the PR's base and head
object ids (`GET /compare/{base}...{head}`) for PRs up to GitHub's 300-file
compare cap, so the report's `head_sha` provably identifies the reviewed
patches even if the PR moves mid-fetch; larger PRs use the paged files
listing bracketed by PR reads and refuse to bind if the head or base moved.

- **Self-describing `run` header** on every report (`ReviewResult.run`):
  client run id (UUIDv7), rcl version, command, target with exact
  `head_sha`/`base_sha`/refs and a `diff_sha256`, roster with lanes
  (`blocking` / `secondary` / `async` / `verification`), config digest with
  thresholds and gating inline, spec and context-file digests, a best-effort
  `runner` claim, timing, `ci_exit_code` (computed even without `--ci`), and
  the converge context. The Markdown report gains a matching **Reviewed** line.
- **Exact-head binding.** `PRMetadata` gains `headSha`, `baseSha` and
  `mergeCommitSha` from the PR response GitHub already returns; `--staged` /
  `--working-tree` resolve `HEAD` and the merge-base with the remote default
  branch; `--head-sha` / `--base-sha` vouch for a patch file's commits;
  `--expect-head-sha` fails fast when the resolved head is not the expected
  one — checked before the empty-diff exit, so a moved target never reads as a
  clean round.
- **`--spec-source`** (`flag` | `repo_file` | `harness_issue:<ID>`) and
  `--converge-target` / `--round` / `--attempt` (or `RCL_CONVERGE_*`) are
  recorded in the header.
- **Identity on every finding.** `ConsensusFinding.identity` carries the
  converge `stableFindingKey` at review time, on kept and below-threshold
  findings alike.
- **Token usage on calls.** Adapters record `usage`
  (`inputTokens` / `outputTokens` / `reasoningTokens`) where the SDK exposes
  it — Anthropic `usage`, OpenAI and OpenRouter `usage` (with
  `completion_tokens_details.reasoning_tokens`), Google `usageMetadata` —
  including on truncated or refused answers; chunked reviews sum it.
- Pre-3.0 reports (no `run`, no `identity`) load unchanged in
  `converge-report`, `discuss`, and `models seed`.

## 2.1.4

- **Oversized single-file patches are reviewed losslessly.** The chunker now
  emits sequential fragments with accurate unified-diff continuation headers
  instead of dropping every line after the first 2,000; malformed oversized
  patches fail closed rather than producing incomplete review evidence. A
  blocking reviewer contributes only after every fragment succeeds, and hard
  32-chunk / 512-call limits stop pathological paid-work fanout before dispatch.
- **Verification keeps the reported lines in view.** Large hunks are excerpted
  around every finding with accurate synthetic coordinates instead of blindly
  keeping the first 4,000 characters. If all referenced ranges cannot fit, the
  finding remains gating and is marked unavailable to the verifier.

## 2.1.3

- Fix trusted-publishing tag validation when Actions checkout has materialized
  the pushed annotated tag as a conflicting local ref. The validation job now
  force-refreshes only its local tag from the immutable protected remote tag
  before checking its object type, peeled commit, ancestry, and package version.

## 2.1.2

- Bump the default Google reviewer and direct-API verification model from
  `gemini-3.6-flash` to the stable, generally available `gemini-3.8-flash`.
  The Google adapter already uses a compatible generation config and forwards
  the stable model ID without deprecated sampling parameters.

## 2.1.1

Dismissals are terminal (RCL-30). The 2.0.0 regating rule — a dismissed
finding reopens whenever ≥2 models raise it again — put popular false
positives on a treadmill: dismiss → fresh corroboration → regate → re-triage →
fresh round, every round, unboundedly once 2.1.0 lifted the round cap
(allocator-one PR #7774 ran 24 rounds on one un-killable claim). Identity
matching is location-anchored, so a claim about different code is a *new*
identity by construction; corroboration count alone adds no new evidence.

- **A dismissal is terminal on its evidence.** A dismissed identity stays
  `suppressed` regardless of how many models re-raise it. The one re-gate
  trigger left: escalation to critical after a non-critical dismissal.
  Re-dismissing at critical is terminal for critical sightings too.
- **Dismissal-only rounds converge.** `converge-verdict` now reports the
  round's resolution once every gating identity is triaged:
  `converged-dismissal-only` (all dismissed, nothing fixed — the round
  converges on the spot; no confirmation round), `fixes-pending-fresh-round`,
  or `unresolved` with the open identities. This restores the 1.9-era
  convergence rhythm (dismiss-everything → done) on top of 2.x's exact
  cross-round bookkeeping.
- Verdicts now record the severity they triaged (`verdictSeverity`), and the
  run state keeps the last round's classified identities so the resolution is
  machine-decided instead of re-derived by the driving agent. Pre-2.1.1 run
  states load unchanged.

## 2.1.0

Recalibration after the first night of 2.0.0 converge runs (RCL-29): roughly
half of real runs hit the 3-round evidence cap without converging, and drivers
began rebadging capped targets to keep working — the cap was tighter than the
work, not the noise. The default posture is now *run until it converges*.

- **Converge round cap: default 3 (hard max 5) → default 15 (hard max 99).**
  The default is a consent boundary, not a stop: at 15 rounds the workflow
  asks the user; an approved continuation supplies a higher `--max-rounds`
  (up to 99, past which no override exists). The skill now also names target
  rebadging ("v2" targets for the same PR) as a cap bypass.
- **Converge attempt cap: default 7 → 20 launches per target**, so the attempt
  budget no longer interrupts before the 15-round consent boundary (every
  evidence round consumes one attempt).
- **Blocking per-call timeout: 300 s → 540 s.** Heavier reasoning defaults
  pushed real calls past 300 s; losing a reviewer costs more than waiting.
  The async lane keeps its own 900 s cap.

## 2.0.0

The speed & convergence release — implements all five recommendations of the
RCL-21 audit (922 rounds, 15,268 calls, 143 converge runs). Major version
because several defaults change behavior: the blocking roster shrinks to the
direct-API trio, the per-call timeout drops to 300 s, rounds close at quorum,
CI gates on verified consensus instead of raw severity, and converge evidence
rounds are machine-capped at 3 (hard max 5). Corpus-replayed headline:
median review round 14.4 → 2.0 min; the converge stop condition becomes
satisfiable (median first zero-gating round 2–3, was 1/143 runs ever).

- **RCL-27: rcl learns from its own triage history.** Every reviewer call
  and every `converge-verdict` outcome (fixed/dismissed, with the finding's
  supporting models) now accrues in a cross-run store at `~/.rcl`
  (`RCL_DATA_DIR` overrides; deliberately not /tmp or the repo's converge
  dirs, so history survives cleanup). New `rcl models` prints per-model
  trailing precision, triage volume, call volume, dead-call rate, and p50
  latency over a 90-day window, plus the consensus **weight** each model
  earns: 0.5 + precision, clamped to [0.5, 1.5], neutral below 20 outcomes.
  Weights scale each model's consensus vote — confidence in the report and
  the consensus-gating threshold both use weighted vote mass (two
  persistently noisy models no longer auto-gate; they go through the
  verification pass) — and are visible per finding
  (`consensus.weightedScore`, `consensus.modelWeights`) and per run
  (`stats.modelWeights`). `rcl models seed --from <dir>` backfills the store
  from recovered reports and converge ledgers; seeded from the RCL-21 audit
  corpus it reproduces the audit's shape (overall precision ~27%; per-model
  19–55%). The roster question R3 settled by one-off audit is now something
  the tool answers continuously.

- **RCL-24: converge loops are capped at 3 rounds and findings keep a stable
  identity across rounds.** New `rcl converge-report` dedupes each round's
  report against the persisted run state (`.git/rcl-converge-runs/`),
  classifying every finding as new / repeat / suppressed / regating by a
  location-anchored identity — hash of (file, category, line bucket) plus
  overlap matching — instead of titles, which models rephrase (corpus
  spot-check over 374 consecutive-round pairs: identity recognizes a median
  64% of next-round findings as repeats; exact titles ~1%). The same command
  machine-enforces the evidence-round cap: default 3, explicit `--max-rounds`
  up to a hard 5, rounds past 5 impossible. `rcl converge-verdict` persists
  fixed/dismissed triage outcomes; a dismissed finding cannot re-gate in a
  later round without new corroboration (≥2 models or critical) — it is
  reported as suppressed, visibly, with per-round new/repeat/suppressed/
  regating counts for the ledger. The rcl-converge skill drives both
  commands and records the counts.

- **RCL-23: convergence gates on verified consensus, not raw single-model
  claims.** Every kept finding is annotated with `gating.reason` in the
  report JSON: `consensus` (≥2 distinct models after dedup), `critical`,
  `verified` (single-model important that survived a refutation pass), or
  `none`. Single-model important findings get ONE batched refutation call to
  a fast direct-API model (`gating.verificationModel`, default
  gemini-3.6-flash, 60 s cap; openrouter-routed verifiers are rejected); a
  refuted claim stays in the report but stops blocking convergence and CI. A
  failed verification pass fails safe: candidates keep gating, marked
  `unavailable`. `gating.mode: all-findings` restores the legacy
  severity-only behavior. The CI gate and the rcl-converge stop condition
  now read gating annotations (legacy reports fall back to severity).
  Corpus replay (143 converge runs): median gating findings per round drop
  16 → 3 (recorded roster) / 2 (new-roster projection), and the stop
  condition becomes satisfiable — median first zero-gating round 3
  (recorded roster) / 2 (new-roster projection) among runs that ran long
  enough to observe one, where the old definition reached zero in 1 of 143
  runs ever.

- **RCL-26: rounds close at quorum; per-call latency is capped.** A review
  round now closes once ⅔ of its planned calls have completed
  (`quorumFraction`, default 2/3, `1` disables): outstanding calls are
  canceled (new `canceled` review status), aborted at the socket, and
  recorded in `stats.canceledCalls` with model, role, and elapsed time so
  persistent stragglers stay visible per round. Calls from the blocking
  council's own `models` are never canceled — round wall-clock is bounded by
  max(time to quorum, slowest core-model call). Corpus replay (922 rounds,
  recorded pre-RCL-25 roster): median round 14.4 → 6.3 min, −45% total
  review wall, with 100% of multi-model gating findings still surfaced.
  Under the RCL-25 default roster every blocking call is core, so quorum
  cancels nothing and exists purely as robustness against future slow
  reviewers. The default per-call timeout drops 600 s → 300 s (every
  direct-API model's corpus p90 is under 260 s; slow reasoning models belong
  in the async lane with its 900 s cap).

- **RCL-25: OpenRouter models are off the blocking path.** The default
  blocking council is now the direct-API trio (claude-fable-5, gpt-5.6-sol,
  gemini-3.6-flash). The RCL-21 audit of 922 rounds found the four
  OpenRouter-routed models at p50 7–9.5 min per call with 19–39% dead calls
  and last-finisher in 97.6% of rounds; replaying the corpus with the trio
  alone drops the median round from 14.4 to 2.0 min while 91% of multi-model
  findings still surface. deepseek-v4-flash, qwen3.8-max and grok-4.5 leave
  the default roster entirely. kimi-k3 (best corroboration rate in the
  council) keeps a seat in the new **async lane** (`asyncModels` config):
  async reviewers are fired with the round via detached workers, never
  awaited, and whatever has arrived by the next round of the same target is
  merged into that round's dedup, marked `async` in the report JSON
  (`stats.asyncLaunched` / `stats.asyncMerged`). A new `asyncTimeout`
  (default 900 s) gives the lane headroom without holding any round open.

## 1.9.0

- **RCL-18: convergence attempt budgets are machine-enforced.** The generated
  `rcl-converge` workflow now claims every council launch through the new
  `rcl converge-attempt` command. Claims are atomically persisted under the
  repository common Git directory, shared across linked worktrees and
  sessions, and fail closed at the configured boundary. New targets default
  to seven attempts, while an explicit invocation can set or raise the cap;
  reaching it requires the workflow to stop and ask the user before any
  continuation. Existing evidence ledgers seed the machine counter during
  upgrade on a best-effort basis (old ledgers cannot reconstruct failed or
  missing-report launches). Attempt mutexes are atomically published with
  exclusive hard links that cannot replace legacy lock directories, reclaim
  dead owners through token-scoped tombstones, and fail closed on invalid
  locks. CLI exit codes distinguish a cap refusal from accounting or
  infrastructure failures, and `--json` also covers missing/invalid claim
  options. State and directory entries are synced before a claim succeeds.
  Post-record lock-release problems surface as non-retriable claim warnings.
  The skill's legacy `--max-rounds` flag remains an evidence-round limit;
  `--max-attempts` is the distinct overridable launch budget.
  Failed, killed, missing-report, and inconclusive launches remain spent, so
  agent bookkeeping cannot turn the cap into an unattended retry loop.
- **RCL-19: large chunked runs remain observable when redirected.** RCL now
  prints the reviewer × chunk call plan, concurrency, waves, per-call timeout,
  and timeout-bound queue estimate. Non-TTY runs emit bounded completion
  checkpoints and heartbeat lines with success/timeout/error/parse-failure
  counts instead of leaving a static spinner line for tens of minutes.
- Gemini responses containing literal JSON control characters inside string
  values get one narrowly scoped, semantics-preserving escape pass with an
  explicit warning. Controls outside strings and every other malformed shape
  remain `parse_failed`.

## 1.8.2

- **Cross-model agreement no longer disappears when reviewers describe the
  same defect in different words.** Dedup now recognizes independently
  corroborated findings in a tight file/line neighborhood before report
  thresholds run, so agreement raises the signal instead of splitting into
  single-reviewer findings that all sink below `minConsensusScore`.
- The agreement fallback is deliberately conservative: it requires distinct
  model/role evidence, dense local support, strict lexical confirmations, and
  bounded spans; established and opposing concepts remain separate. The
  behavior is pinned by nine real council runs, including two-sided over-merge
  guards. No report threshold was loosened.

## 1.8.1

- **A reviewer that returns no findings array is no longer reported as
  successful.** Follow-up to the 1.8.0 parse-failure work, which gated the
  new `parse_failed` status on the dropped-findings counter — and that
  counter only moves inside the salvage loop, which never runs when the
  response has no `findings` array at all. So a truncated, refused, or
  prose-only answer still came out as `success` with zero findings:
  arguably the more common total loss than "every individual finding was
  malformed", which was the case 1.8.0 did fix. The parser now returns an
  explicit `unusable` verdict and the status gates on that. The markdown
  degraded-coverage banner fires on either signal, so a lost reviewer with
  no malformed-finding count is still named.

## 1.8.0

- **String line numbers no longer discard findings.** Models routinely emit
  `"startLine": "59"`, and the strict `z.number()` rejected it. When every
  finding in a response was affected the whole reviewer was lost — in an
  observed run, an entire `test-coverage` role vanished, and it was the only
  reviewer across three rounds to catch a real test gap. Line numbers are
  coerced now, and severity/category tolerate stray casing and whitespace.
- **A reviewer whose output was wholly unparseable is no longer reported as
  successful.** It gets the new `parse_failed` status, so — like a refusal —
  it renders as failed, is excluded from `successfulReviews`, and drops out
  of consensus rather than counting as a reviewer that "found nothing".
- **Degraded coverage reaches the report.** `ModelReview` now carries
  `droppedFindings` and `warnings`, summed across chunks; the markdown report
  gets a banner above the reviewer table naming the lost reviewers, and the
  terminal, GitHub, and JSON surfaces show per-reviewer drop counts. The
  skills tell people to read reports from files rather than console
  scrollback, so warnings that only ever reached `console.warn` were
  invisible exactly when the documented workflow was followed correctly.

## 1.7.0

- **A model refusal is no longer reported as a clean review.** Providers
  decline in-band — Claude answers HTTP 200 with `stop_reason: "refusal"`,
  OpenRouter reports the same upstream refusal as
  `finish_reason: "content_filter"`, Gemini as a `SAFETY` finish reason —
  and rcl recorded all of them as a *successful review with zero findings*.
  That was worst exactly where it mattered most: refusals cluster on
  security-relevant diffs, the reviewer still counted toward
  `successfulReviews` (so the CI "nothing was reviewed" guard stayed quiet),
  and consensus treated it as a relevant reviewer that looked and found
  nothing — which *lowered* the confidence of real findings other models
  caught. All four adapters now classify refusals as `error` with the
  provider's category/explanation, so they render `✗` in the reviewer table
  and drop out of consensus. Backstop: any empty response body after a 200
  is an error too, since a reviewer that returned nothing reviewed nothing.

- **Key distribution via Harness.** In repos with a committed
  `.harness-cli/config.json`, provider keys missing from the environment are
  fetched from the Harness backend (`GET /api/v1/model-keys`, staff-gated)
  using the `harness login` credential, and injected for the run. Env always
  wins; the token is only sent to the host that minted it; every failure
  degrades silently to plain-env behavior (3s timeout, nothing written to
  disk or logs). Disable with `RCL_NO_HARNESS_KEYS`.

## 1.6.0

- **`rcl discuss` — one-shot council discussion of a finding.** Ask the
  models that flagged a finding a follow-up question, with context
  reconstructed from a saved report (`--report report.json --finding <id>
  "question"`, `<id>:<n>` disambiguates colliding model-generated ids,
  appendix findings addressable, `--context` attaches code). Answers run in
  parallel through the normal adapter timeout/retry machinery via a new
  free-text `ask()` on every provider adapter. No session state — each
  discuss is one independent round. Below-threshold and disputed findings
  (which carry per-model positions since this release) are the intended
  targets.
- Taxonomy phrases now match across arbitrary whitespace (line-wrapped
  "cross-site scripting" still fires) — surfaced by dogfooding `rcl
  discuss` against the taxonomy's own review findings.

- **Taxonomy-boosted dedup.** When two findings at the same location (strictly
  overlapping line ranges) both name the same issue concept — sql injection,
  IDOR, hardcoded secret, race condition, … — they now merge regardless of
  wording (concept similarity 0.8+, taken as `max()` with token similarity so
  it can only add merges, never remove them). Closes the calibration gap
  where genuine cross-model duplicates scored 0.29–0.55 on token overlap.
  Benchmarked on the fixture corpus: merge recall 0.70 → 1.00 at precision
  1.00; the boost is location-gated so two *different* same-concept findings
  in nearby lines stay separate (the ungated code-council variant merged
  them). Concept phrases match at word boundaries — no substring taxonomy.
- **Plan review: `rcl review-plan <file>`.** Council a plan document (PRD,
  design doc) before code exists, with optional `--focus feasibility |
  completeness | risks | timeline`. The plan is loaded as a synthetic
  single-file diff so chunking, dedup, consensus, and the agreement-tier
  report work unchanged; prompts are plan-adapted (roles get a plan
  preamble, the base prompt reinterprets categories for design documents,
  code-language checklists are skipped). Defaults to a plan-suited role
  subset (general, architecture, edge-case-hunter, + spec-compliance with
  `--spec`); explicit role flags and config `roles` override.

- **Report restructured by agreement tier.** Markdown reports (and the
  GitHub summary comment) now organize findings by how broadly the fleet
  agrees — unanimous / majority / minority (2+ models) / disputed /
  single-model — instead of one severity-ranked list, so the reader triages
  independently-confirmed findings first and spends judgment where the
  council disagrees. Disputed findings render per-model positions ("who
  rated what, and why"). JSON consumers: `consensus.tier` and
  `consensus.positions` (disputed only) are new additive fields; existing
  fields are unchanged.
- **Below-threshold findings are demoted, not deleted.** Findings that fail
  `minConsensusScore`/`minConfidence` now land in a collapsed
  "worth checking" appendix (capped at 20 entries in markdown; the JSON
  `belowThresholdFindings` field carries all of them) instead of vanishing —
  in one dogfood round 73 of 96 deduped findings were silently dropped,
  including a genuine single-model catch. They are never counted in
  severity totals or CI gating. Disable with
  `output.belowThresholdAppendix: false`. Programmatic consumers of
  `applyReportThresholds` note: its `dropped` return field changed from a
  count to the dropped `ConsensusFinding[]` (use `dropped.length` for the
  old value).

- **Review uncommitted work: `rcl review --staged` / `--working-tree`.**
  `--staged` reviews `git diff --cached`, `--working-tree` reviews
  `git diff HEAD` (staged + unstaged) — no more `git diff > file` dance.
  The flags replace the positional target and are mutually exclusive with
  it. Untracked files are not included (invisible to `git diff`).
  `--post` on a non-PR source now warns instead of silently doing nothing.

- **`reasoningEffort` is configurable** (`low` | `medium` | `high`, default
  `medium`) instead of hardcoded, threaded from config through the runner to
  the OpenRouter adapter.
- **Skill definitions are generated from one source.** `skills/src/*.md`
  plus `npm run build:skills` produce all six `SKILL.md` files; `npm test`
  fails if the committed files drift from the source.
- Fixed: `src/index.ts` fell back to inline `120_000` / `3` / `6` literals
  when config values were absent, so the timeout default no longer matched
  `DEFAULT_TIMEOUT_MS` (600s). It now falls back to the shared constants.

## 1.5.0

- **OpenRouter provider.** Models prefixed `openrouter/` route through the
  OpenAI-compatible adapter against `https://openrouter.ai/api/v1`,
  authenticated via `OPENROUTER_API_KEY`. The prefix keeps OpenRouter's
  vendor segment: `openrouter/moonshotai/kimi-k3` sends `moonshotai/kimi-k3`
  on the wire. A missing key fails that model's reviews loudly instead of
  silently falling back to `OPENAI_API_KEY`.
- **Default fleet reshuffle: seven models, seven labs, one seat each.**
  `DEFAULT_MODELS` (general role + specialist round-robin) is now
  claude-fable-5, gpt-5.6-sol, gemini-3.6-flash (bumped from 3.5-flash,
  verified served under that id by the native Gemini API), and
  `openrouter/moonshotai/kimi-k3`. `DEFAULT_SECONDARY_MODELS` (specialist
  round-robin only) replaces the previous-gen trio (claude-opus-4-8,
  gpt-5.4, gemini-2.5-pro) with `openrouter/qwen/qwen3.8-max`,
  `openrouter/deepseek/deepseek-v4-flash-0731`, and
  `openrouter/x-ai/grok-4.5`. Every default voter now comes from a
  distinct training lineage, so consensus agreement always reflects
  independent confirmation.
- **Defaults degrade gracefully without OPENROUTER_API_KEY.** Upgrading from
  1.4.x with only the big-three keys keeps working: openrouter/ entries are
  dropped from the *default* lists with a warning instead of erroring on
  every run. Explicitly configured openrouter models still fail loudly.
  Note the flip side: with the key set, default reviews also send code to
  OpenRouter (see README). Because the default *secondary* list is now
  entirely OpenRouter-hosted, running without the key leaves it empty and
  every specialist role is dispatched across the three remaining SOTA
  models — reviews still work, but with less reviewer diversity than
  1.4.x, which shipped three non-OpenRouter secondaries. The startup
  warning names the surviving fleet.
- **OpenRouter reviews run with bounded reasoning (`effort: medium`).**
  Unbounded, the fleet's reasoning models (kimi-k3, qwen3.8-max,
  deepseek-v4, grok-4.5) think for 5–10 minutes and/or exhaust the 16k
  completion budget before emitting findings — across three dogfood
  council rounds, 4 of 7 OpenRouter seats completed zero reviews.
  Bounding effort bounds both reasoning tokens and wall-clock.
- **Default per-call timeout raised 120s → 600s.** Reasoning-heavy models
  (kimi-k3, qwen3.8-max, deepseek-v4, grok-4.5) time out wholesale at 120s
  on real diffs, and mostly still at 300s (successful calls measured
  217–291s) — found by dogfooding this release on its own diff.

## 1.4.1

- Bump the default OpenAI SOTA model from `gpt-5.5` to `gpt-5.6-sol` in
  `DEFAULT_MODELS`. No other behavior changes; `gpt-5.6-sol` routes through
  `max_completion_tokens` automatically (gpt-5.x family).

## 1.4.0

A correctness and reliability pass fixing every finding from a full multi-track
code review (see `REVIEW_FIXES_PRD.md`). Test count grew from 79 to 190.

### Fixed — coverage

- **Multi-chunk review.** Large diffs were only reviewed up to the first chunk
  (~2000 lines / 20 files); the rest was silently dropped. Reviews now fan out
  across every chunk and merge back to one result per reviewer.
- **PR file listing is paginated** — PRs with more than 100 changed files are no
  longer truncated.
- **Oversized single-file patches are capped** with an explicit truncation
  marker instead of being sent to models unbounded.

### Fixed — reliability

- **CI fails when zero reviewers succeed** (previously exited 0 — green with
  nothing reviewed).
- **Timeout classification** now works: SDK abort errors were never detected, so
  timeouts were misreported as generic errors.
- **Google adapter** clears its timeout timer and passes an abort signal, so runs
  no longer hang up to 120s after finishing and timed-out requests are cancelled.
- **`openai-compat/` model prefix** is stripped before the API call (local models
  were 404ing on every request).
- **Truncated responses** (hit token limit) are reported as errors, not empty
  successes.
- SDK-internal retries disabled; the adapter owns retries with a predicate
  covering 429/500/502/503/504/529.
- Runner uses a worker pool (no head-of-line blocking) and always completes its
  progress counter.

### Fixed — security

- **No executable config discovery.** Config search is limited to declarative
  files (`.yml`/`.yaml`/`.json`) in the current directory only — running rcl in
  an untrusted checkout can no longer execute attacker JS with your API keys.
- **Invalid config is fatal** instead of silently falling back to cloud default
  models.
- **Prompt-injection delimiters** in untrusted diff/context content are
  neutralized so a PR can't fake the untrusted-region boundary.
- **Model output is sanitized** before posting to GitHub/markdown: `@mentions`
  and `#refs` neutralized, HTML stripped, `suggestedFix` safely fenced.
- **GitHub comment anchors are validated** against the diff; unmappable findings
  demote to the summary and a rejected review retries summary-only, so one bad
  line number can never drop the whole review.

### Fixed — consensus

- Specialist confirmation is gated on `isSpecialized`, so the all-category
  `general` role no longer inflates every finding's relevance/isolation score.
- A model that omits finding ids no longer loses its entire output; JSON
  extraction recovers from trailing prose and bare arrays.
- Line-overlap window is applied once (a window of 5 behaved as 10).
- One consensus vote per `(model, role)` reviewer; blocking findings are never
  filtered out by report thresholds.
- `minConfidence` / `minConsensusScore` now filter reported findings; role
  `severityBias` becomes calibration guidance in the prompt (all three were
  previously dead config).

### Fixed — roles

- Content-dependent roles (`project-rules`, `spec-compliance`) are skipped when
  their content is absent instead of burning a call and hallucinating.
- All-invalid `--reviewer` pairs error instead of running an empty review.
- Custom roles inherit `isSpecialized`/`description` from an overridden builtin
  (matched case-insensitively); role lookups are case-insensitive.

### Dependencies

- Removed unused `simple-git` (high-severity RCE advisory, zero imports).
- `npm audit fix` for `protobufjs` (critical) and `ws` (high). No high/critical
  advisories remain in the production tree.
