# Convergence and recovery

A convergence loop reviews a change, triages the findings, fixes what is real
and reviews the result again until a conclusive round converges. The
`/rcl-converge` agent skill drives this loop (see the
[README](https://github.com/allocator-one/rcl#agent-skills-rcl-and-rcl-converge));
this document describes the commands and native state it relies on, and the
supported recovery operations when a launch or delivery goes wrong.

Native convergence state lives under the repository's common Git directory, so
it survives sessions, linked worktrees and restarts:

| Directory | Contents (one JSON file per convergence target) |
| --- | --- |
| `.git/rcl-converge-attempts/` | Launch-attempt ledger and attempt cap |
| `.git/rcl-converge-runs/` | Admitted rounds, finding identities, verdicts and the round cap |

The state is a same-user local safety mechanism, not a tamper-proof store.
Deleting it is an explicit policy bypass, not a recovery step. Native
convergence is also not merge approval: merging still requires matching
enforced review evidence and CI (see
[Telemetry and evidence](https://github.com/allocator-one/rcl/blob/main/docs/telemetry-and-evidence.md)).

## Contents

- [Budgets: attempts and rounds](#budgets-attempts-and-rounds)
- [Reviewer health](#reviewer-health)
- [Guarded convergence launches](#guarded-convergence-launches)
- [Start a fresh review](#start-a-fresh-review)
- [`rcl converge-report` and `rcl converge-verdict`](#rcl-converge-report-and-rcl-converge-verdict)
- [Patch-file rounds bound to a pull request (`--for-pr`)](#patch-file-rounds-bound-to-a-pull-request---for-pr)
- [Recovery](#recovery)
  - [Failed, unknown or inconclusive launches](#failed-unknown-or-inconclusive-launches)
  - [Ordinary pending launches with a dead coordinator](#ordinary-pending-launches-with-a-dead-coordinator)
  - [Bound fix recovery](#bound-fix-recovery)
  - [Launch intents](#launch-intents)
  - [`rcl converge-stale`](#rcl-converge-stale)
  - [`rcl converge-gap`](#rcl-converge-gap)
  - [`rcl converge-rejected`](#rcl-converge-rejected)
- [`rcl converge-attempt` (legacy accounting)](#rcl-converge-attempt-legacy-accounting)

## Budgets: attempts and rounds

A convergence target has two separate counters:

- **Attempts** are paid launches. Each guarded launch durably consumes one
  attempt, including failed, killed, no-report and inconclusive runs. New
  targets default to 20 attempts; an explicit `--max-attempts <n>` sets any
  positive cap, and omitting it on resume preserves the persisted cap.
- **Evidence rounds** are admitted reports. `rcl converge-report` enforces the
  round cap: default 15, `--max-rounds` accepts 2–99, and rounds past 99 are
  impossible under any flag.

Both defaults are consent boundaries, not stops. At the boundary RCL refuses
before any provider call (exit code 2) and the workflow asks the user; an
approved continuation explicitly supplies a higher cap. Exit code 3 means
accounting itself failed (state, lock, Git, filesystem or another
infrastructure error); raising the cap is not the remedy for that.

A spent attempt with no terminal report remains spent but does not advance the
report ordinal. Never choose the next round from the spent-attempt count.

## Reviewer health

Full-fleet reviewer completion is not required. Reviewer health counts only the
report roster's blocking seats, and a seat counts only when every one of its
chunks succeeded. A round is conclusive when at least
`max(2, ceil(2 × blocking seats / 3))` blocking seats completed, or more under
a stricter configured `quorumFraction`. Each report records this as
`stats.blockingHealth` (`seats`, `successful`, `required`, `conclusive`).

Secondary, async and verification results keep their findings but never count
toward the quorum, so the aggregate `stats.successfulReviews` /
`stats.totalReviews` are informational only: 11 of 17 blocking seats plus one
async success is 12/18 in aggregate yet inconclusive, because 12 blocking seats
are required. Harness applies the same rule to delivered evidence. Round
closure uses the same seats and policy: bonus successes never cancel unfinished
blocking reviewers. Every timeout or error must be disclosed, and a result
below the requirement is inconclusive.

## Guarded convergence launches

```bash
rcl review change.patch --guarded-converge --converge-target repo-123 \
  --head-sha <captured-head> --base-sha <captured-base> --json-file fresh-report.json
```

Keep this command in the foreground inside a persistent host task or session.
It validates inputs, provider credentials and fresh output paths before
claiming; native target ownership spans claim through completion. Do not call
`converge-attempt` first or supply `--attempt`. RCL derives the next round from
admitted state and rejects a conflicting `--round`. Existing caps and all spent
attempts are retained. Guarded assignment order is stable, and missing
credentials never shrink the roster: a missing provider key refuses the launch
before a claim.

Process and triage the original report before another launch. Unchanged
reviewed inputs, including mere upstream base-tip movement, do not need another
council. A real fix needs a fresh resulting head; unresolved native blockers
refuse another launch. An unknown or failed dispatch requires an explicit
`--retry-reason` after recovery, even if the head changed. This does not refund
attempts or promise exactly-once provider billing. Credential presence cannot
prove provider availability.

Exit codes are those of `rcl review` (see the
[README](https://github.com/allocator-one/rcl#exit-codes)); under guarded
convergence, 2 is the attempt or round cap and 3 is a native state failure.

**Async reviewers across rounds.** For converging patch reviews, async
collection uses `--converge-target` (or `RCL_CONVERGE_TARGET`), not the patch
pathname. Each round can keep a distinct, immutable capture while sharing
results across linked worktrees of the same repository and target. Other review
modes keep their existing keys; previously spooled path-keyed results are not
migrated. Async findings can come from an earlier capture and still need
checking against the current code. This does not make detached-worker
completion part of the blocking round. `run.roster` records this round's
planned seats; collected async reviews retain their model and role in
`reviews` and can come from seats absent from the current roster.

## Start a fresh review

```bash
rcl review owner/repo#123 --start-over
```

This reviews the full current inputs again, even on an unchanged head or after
an exhausted previous cycle. RCL archives the original native state and
spending, creates a Harness review cycle, and starts at attempt 1 / round 1 with
the normal 20-attempt / 15-round budget. Previous approvals, dismissals and
reviewer responses stay historical. Explicit `--max-attempts` / `--max-rounds`
select different limits for the new cycle; old overrides are not inherited.

The command enables guarded launch and chooses private JSON/Markdown paths under
the Git common directory when omitted. It prints the cycle and cumulative prior
spending. Keep the files in place. A captured patch can use the same flag with
`--for-pr owner/repo#123 --head-sha <captured-head>`. Full Harness evidence and
a user/API actor credential are required; unbound local and attested starts are
refused.

An unfinished start resumes with the same command and operation, keeping spent
claims. A durable terminal dispatch record marks completion, including a
recorded failure. If the command output or acknowledgement is lost or
uncertain, inspect the native current operation and retained launch/report
before retrying; reuse a completed result instead of blindly repeating
`--start-over`. An invocation after terminal completion represents a new
request; identical command text cannot distinguish an acknowledgement retry
from a later deliberate fresh request. No user-supplied operation ID or
additional confirmation is required. Ordinary `rcl review owner/repo#123`
discovers the local cycle and continues its existing budget; it does not
replenish it. A concurrent fresh request cannot silently create another cycle
after waiting for the first.

Stop an active review through its recorded host task before replacing it. Late
reports and verdicts remain bound to their original cycle. After checking
reviewer health and exact-head freshness, admit the report with
`converge-report`; use `converge-verdict --run-id <report-run-id>` for triage in
a fresh cycle. All native, enforced and CI merge gates still apply. To complete
missing reviewers while preserving successful work, use the supported recovery
workflow instead of starting over.

## `rcl converge-report` and `rcl converge-verdict`

The cross-round memory of a converge run, persisted per target under
`.git/rcl-converge-runs/`.

`converge-report` dedupes one round's report JSON against every prior round of
the run using a location-anchored finding identity (hash of file + category +
line bucket, plus a line-overlap matcher; titles are deliberately ignored
because models rephrase almost all of them between rounds). Each finding is
classified `new`, `repeat`, `suppressed` (previously dismissed: a dismissal is
terminal on its evidence and fresh corroboration alone never reopens it), or
`regating` (previously dismissed at non-critical severity, now sighted as
critical, which is genuinely new evidence). The same call enforces the round
cap. Exit codes: 0 admitted, 2 round cap, 3 state failure, 4 reviewer health.

Before reading or writing native state, `converge-report` derives blocking
reviewer health from the report's roster and rows. An inconclusive report exits
4 (`report_health_inconclusive`) and is not admitted: its findings are not
classified or triaged. The refusal names the completed blocking seats, the
required count, every missing, failed or canceled seat, and the excluded
secondary/async successes (with `--json`, as `error.reviewerHealth`). A report
whose recorded `stats.blockingHealth` disagrees with its rows exits 4 with
`report_health_unverifiable`. The report, its attempt and all earlier rounds
stay unchanged. Continue with the same guarded review command plus
`--retry-reason`: the guard records blocking health for every new launch,
requires that explicit reason for an inconclusive one, and spends one more
attempt at the same round without resetting caps or cycle history. Retained
missing-reviewer recovery remains a separate workflow. Conclusive health does
not replace triage, and merging still requires matching enforced review and CI.

A report key must identify one canonical identity, status and suppression
reason. `converge-report` refuses conflicting mappings with exit 3 before
writing the round state, even when telemetry is off. Reports without finding
keys use the canonical identity as a fallback and are subject to the same
check. This leaves ambiguous older reports readable but not classifiable by
this command. Preserve the original report and ledger for separately supported
finding-ref recovery (`rcl evidence recover-finding`); rewriting published
evidence or rerunning an unchanged council is not recovery. Identical mappings
still deduplicate, and native ledger keys and verdicts do not change when new
run-scoped report keys appear. Until the current run's classification is
delivered, older runs' aliases cannot resolve its new report keys. A report
without a current classification does not inherit prior native verdicts, even
when its findings look unchanged.

`converge-verdict` records triage outcomes per finding identity —
`--fixed <key>` and `--dismissed '<key>=<reason>'` (both repeatable) — which
drives later-round suppression and accrues the per-model precision history
shown by `rcl models`. Add `--fixed-reason '<key>=<reason>'` to attach the
current fix explanation to an identity also passed to `--fixed`. A fixed
verdict without this option clears any prior explanation; it never reuses an
earlier dismissal reason. Each identity may appear once per command, and each
fixed reason must be nonempty and unique. In a fresh review cycle, pass the
report's run UUID with `--run-id`. Once every gating identity of the current
round is triaged, it also reports the round's resolution:
`converged-dismissal-only` (everything dismissed, nothing fixed — the round
converges on the spot, with no confirmation round),
`fixes-pending-fresh-round`, or `unresolved` with the identities still open.

```bash
rcl converge-report --target rcl-30 --report report-r2.json --round 2 --json
rcl converge-verdict --target rcl-30 --round 2 \
  --fixed 9787c6ea72ae778c \
  --fixed-reason '9787c6ea72ae778c=callback failures now have a distinct outcome' \
  --dismissed 'd2baf9675eb450f0=guard already exists'
```

## Patch-file rounds bound to a pull request (`--for-pr`)

A patch-file review (`rcl review changes.patch`) carries no repository or pull
request, so Harness records it as a `patch` run it cannot verify or count for
any gate. `--for-pr owner/repo#N` (or a pull request URL) names the pull
request the patch was taken from (`RCL_FOR_PR` in the environment does the same
for patch files): the run is bound to that pull request and its `--head-sha` —
required with the flag — is verified against the pull request's head. Owner and
repository are lower-cased, as GitHub reads them.

Harness counts such a run for that pull request's gate like a pull request
target: once it is verified, live, from the same repository and its head equals
the pull request's current head, `rcl evidence status` reads the round. The
enforced projection still requires an attested run. An unbound patch run (no
pull request named) stays unverified.

The flag is refused on PR and git-mode targets, which name their own pull
request or checkout. `rcl-converge` passes `--converge-target` on every round
and adds `--for-pr` when a pull request loop reviews a patch file taken from
the pull request (a pull request target names its own). A converge target of
the `owner/repo#N` form attributes the run the same way; a slug such as `rcl-7`
does not.

```bash
rcl review round-3.patch --head-sha "$HEAD" --base-sha "$BASE" --for-pr owner/repo#42 \
  --guarded-converge --converge-target owner/repo#42 \
  --json-file round-3.json --evidence-required
```

## Recovery

Every recovery operation below preserves original reports, spent attempts and
caps. None of them admits findings by itself, invents verdicts, raises a cap or
confers convergence or merge approval. Preview modes are read-only unless
stated otherwise.

### Failed, unknown or inconclusive launches

After a failed or unknown dispatch, or an inconclusive report, continue with the
same guarded review command plus an explicit bounded `--retry-reason`. The
retry spends one more attempt within the existing caps.

For a 4.1.10, 4.1.11 or 4.1.12 aggregate-only completion, retain the original
report and config and add `--retry-report original-report.json` with an
explicit bounded `--retry-reason` and a fresh `--json-file` destination. RCL
binds the exact original report, config, target, head, input, round, attempt,
cycle and roster before deriving blocking-only health with the shared quorum
policy. The new launch may review changed current inputs, but its original
proof stays bound to those original identities. When roles or verifier defaults
have since changed, RCL reconstructs the producer version's deterministic
roster from that bound config; unknown, substituted or ambiguous identities
still refuse before a claim. Healthy or ambiguous evidence refuses. The 4.1.10
producer predates review cycles and is accepted only when the retained report,
native state and attempt state all remain cycle-free. An unadmitted source
retries its pending round; an exact latest admitted source whose blocking
health was inconclusive continues at the next native round. Its original
admission, findings, verdicts and spent claims remain unchanged. The new claim
retains the source bytes and binding; no history or budget is reset.

### Ordinary pending launches with a dead coordinator

For an ordinary pending launch whose coordinator is provably dead, supply an
immutable package that binds the original target, head, base, guarded input,
attempt, round, PID and retained async artifact descriptors. RCL recomputes its
production guarded-input digest and checks every binding under the target lock
before it mutates native state.

**Export the package.** `--export-pending-package <path>` reconstructs that
package from the original guarded inputs without provider calls or native
writes:

```bash
rcl review owner/repo#123 --guarded-converge --converge-target repo-123 \
  --expect-base-sha <current-base> --export-pending-package /private/path/pending.json \
  [--preview-pending] [original --spec/--roles/--models/--config flags]
```

Pass the original preparation flags so the guarded-input digest matches, plus
`--expect-base-sha` naming the current base commit; the export refuses unless
the resolved base equals it. Export applies only to the latest ordinary
(non-cycle) pending launch of the target: its recorded coordinator must be
gone, and its head, round and guarded-input digest must match the reconstructed
inputs. When the launch retained its inputs before the claim, the package binds
those retained bytes and their base; otherwise it binds the current review
target. The retained async results must match the expected async reviewer
identities. The destination must lie outside the Git common directory and is
written exclusively; `--preview-pending` performs all checks and prints the
receipt without writing. The JSON receipt includes the package digest, the
native and attempt state digests, and the retained async SHA-256 values.
Export refuses launch, recovery, output and evidence flags (`--start-over`,
`--attest`, `--retry-*`, `--resume-pending`, `--finalize-pending-only`,
`--max-attempts`, `--max-rounds`, `--attempt`, `--launch-intent`, `--post`,
`--json`, `--json-file`, `--markdown`, `--ci`, `--evidence-required`,
`--staged`, `--working-tree`). `--expect-base-sha` is accepted only with
`--export-pending-package`.

**Preview.** Use `--preview-pending` with either `--resume-pending` or
`--finalize-pending-only` and `--ordinary-pending-package <path>` to
authenticate that package with zero state, output or provider writes.

**Resume.** Combined `--resume-pending` repeats the checks, marks the spent
attempt failed with blocking outcome unknown, archives the exact retained async
artifacts (`--resume-async-sha256`), and claims exactly the next checkpointed
attempt under its explicitly bounded cap. It requires `--retry-reason`,
`--evidence-required` and an explicit `--max-attempts`.

**Finalize only.** Use `--finalize-pending-only` when recovery must stop at
that failed/unknown finalization. Like `--resume-pending`, it takes the
retained async digests with `--resume-async-sha256`. Pass the unchanged cap
plus the exact
`nativeStateSha256` and `attemptStateSha256` returned by its preview as
`--pending-native-sha256` and `--pending-attempt-sha256`. Apply archives the
retained async artifacts idempotently and returns a source-bound receipt while
leaving the attempt counter, cap, round history and next-free ordinal
unchanged. Repeating the command reads back the same receipt; it never creates
a successor claim, checkpoint, reviewer callback or provider call. Receipt
readback validates either the exact finalized state or a monotonic successor
against retained source snapshots. An exact legacy receipt without those
snapshots is upgraded idempotently before a successor proceeds, without
changing native state or accounting. A later guarded convergence process may
claim the next attempt independently.

Ordinary guarded launches retain their inputs before spending the claim, so an
interrupted launch has a durable, digest-bound recovery source.

### Bound fix recovery

When native triage reports `converged-dismissal-only` but Harness still reports
`fixes_pending` with no actionable findings, an explicit recovery can authorize
one additional review of the same inputs:

```bash
rcl review change.patch --guarded-converge --converge-target repo-123 \
  --for-pr owner/repo#123 --head-sha <captured-head> --base-sha <captured-base> \
  --evidence-required --bound-fix-recovery <latest-admitted-run-id> \
  --json-file fresh-recovery-report.json
```

Reuse the original review inputs and configuration, including the specification
and reviewer roster; both the head and effective input digest must match the
latest completed, healthy, delivered and admitted native launch. Its resolution
must be `converged-dismissal-only` with `fixedThisRound: 0`. Use a PR target or
an explicit `--for-pr` binding, and explicitly supply `--guarded-converge` and
`--evidence-required`. This mode rejects `--start-over`, `--attest`,
`--retry-report`, `--retry-reason`, git working-tree/staged reviews, and launch
intents other than `review`.

Before claiming or dispatching reviewers, RCL reads authenticated live Harness
status and the selected run. The PR must be unmerged at the exact reviewed
head; its advisory projection must be conclusive, `fixes_pending`, have zero
actionable findings, and name that same run. The recorded run must match the
repository, PR, head, convergence target and native round. Exposed
classification and legacy pending fields must be clear, and an exposed bound
classification protocol must be version 1. Unanswered, malformed or mismatched
evidence refuses recovery.

Harness exposes `fixes_pending` for the whole PR and does not provide proof
identifying which convergence target owns a retained fix obligation. These
checks establish the native/server mismatch; they cannot establish that another
round on the selected target will clear it. Recovery therefore allows only one
claimed attempt per target, PR and head in the current native attempt ledger,
even if that attempt fails or a later run remains `fixes_pending`. The claim
durably retains its source run, binding, server status and response hashes.
Existing attempt and round caps still apply. Process and deliver the new report
normally; matching enforced evidence and CI remain required for merging.

### Launch intents

`--launch-intent stop-upstream` never cancels review. `stop-review` and
`retry-delivery` refuse new reviewer dispatch; cancel an existing review only
through its retained host handle. Retry evidence with
`rcl telemetry flush --run <run-id>`, not another council. Intent
interpretation and finding adjudication remain human/agent decisions;
native/enforced evidence and CI still gate merging.

### `rcl converge-stale`

A healthy report that became materially stale before admission must be
retained without assigning its findings or verdicts. The guarded launch refuses
with `report_not_admitted` and prints the current head and effective input
digest. Inspect the actual changes and use those exact values to preview a
disposition:

```bash
rcl converge-stale --preview --manifest stale.json --target repo-123 \
  --head <current-head> --input-sha256 <current-effective-input-sha256> \
  --report original.json --report-sha256 <original-sha256> \
  --reason "Committed changes and the current specification supersede this report"
rcl converge-stale --apply --manifest stale.json --manifest-sha256 <reviewed-manifest-sha256>
# After an interrupted apply, use the same immutable manifest:
rcl converge-stale --resume --manifest stale.json --manifest-sha256 <reviewed-manifest-sha256>
```

If the completed report has conclusive blocking reviewer health but retains a
`hardFailure` marker after its initially failed evidence delivery was
authentically reconciled, ensure the durable marker exists first. A run whose
pending bit was already cleared by 4.5.1 must run
`rcl telemetry flush --run <run-id>` again under 4.5.2. This performs no
reviewer calls or accounting changes. Require the exact
`Reconciled delivered run <run-id> with its guarded launch state.` output;
exit code zero alone is insufficient because unavailable or mismatched server
evidence leaves reconciliation unchanged. Then run the preview below and
inspect its `deliveryReconciliation` object directly: its run ID, report
SHA-256, round, attempt and head must equal the original retained launch.
Missing or mismatched marker evidence makes preview refuse. Preview the same
exact stale disposition with an explicit bounded retry reason:

```bash
rcl converge-stale --preview --manifest stale.json --target repo-123 \
  --head <current-head> --input-sha256 <current-effective-input-sha256> \
  --report original.json --report-sha256 <original-sha256> \
  --reason "Committed changes and the current specification supersede this report" \
  --retry-reason "Evidence delivery was reconciled; retry the changed inputs once"
```

The guarded review must use that exact `--retry-reason`. This variant binds the
durable authenticated delivery-reconciliation marker, conclusive
reviewer-health record, cycle, run, report, head, input, round, attempt and both
native snapshots. Backfill additionally requires its retained delivery-failure
exit and one exact server-stored report artifact. It never
clears `hardFailure` or makes
ordinary healthy stale reports, pending delivery, local-invalid rejection,
inconclusive health, same-input work, unresolved rounds or exhausted caps
eligible.

Preview writes only its exclusive manifest. Apply retains the original report
and exact native snapshots, then atomically adds a digest-bound audit entry
under native target ownership. Immutable shared objects and reconstructible
snapshot templates avoid copying the full report and growing history for every
correction. Incremental prefix hashing verifies the growing audit without
repeatedly serializing all earlier entries. It does not admit findings, claim
attempts, flush evidence, raise caps, or approve a PR. Resume is idempotent.
Continue with the original `review --guarded-converge` invocation; it
recomputes the real head/input digest and checks every retained receipt before
claiming one normal attempt at the next native ordinal. Admission of the fresh
report rechecks that retained history. The stale attempt stays spent.

Before any stale disposition, unchanged inputs require normal admission;
upstream tip movement alone is insufficient. After disposal, the original
report stays historical even if its inputs return. Inspect and apply those
inputs as another replacement to obtain a fresh review without reviving that
report. Unknown outcomes, unhealthy reports, pending delivery, missing original
evidence, changed state and unresolved earlier findings refuse safely. A
disposition is bound to one exact replacement input. If inputs change again
before continuation, inspect the new inputs and create a new preview and apply
operation; it appends another inspected replacement for the same preserved
report. Every earlier inspected replacement remains usable: returning to one
needs only the guarded review command, not another disposition. Preview refuses
a duplicate replacement plan. Missing or changed retained evidence, forged
manifests and accidentally truncated audit history are refused before an
attempt is claimed. Preview/apply bind the then-current native state; later
legitimate native transitions remain authoritative. This local audit does not
authenticate arbitrary edits to the entire native state file. Keep the audit
directory with its original repository location: repository relocation and
reconstruction of lost evidence are not supported by this command. Every
receipt remains required, including earlier inspected alternatives. Native
convergence, enforced review and CI remain required.

### `rcl converge-gap`

A paid attempt and an admitted report round are separate counters. If an
original later report already carries round 3 while native history ends at
round 1, preserve that original. Do not relabel it, create an empty round 2,
reset budgets, or launch reviewers again for bookkeeping.

For one explicitly evidenced missing terminal report, preview a local audit:

```bash
rcl converge-gap --preview --manifest gap.json --target rcl-81 \
  --gap-round 2 --admitting-round 3 --attempt 2 --run <original-run-uuid> \
  --report original-r3.json --report-sha256 <original-json-sha256> \
  --incomplete terminal-incomplete.md --incomplete-sha256 <original-evidence-sha256>
rcl converge-gap --apply --manifest gap.json --manifest-sha256 <preview-manifest-sha256>
# After interruption, reuse exactly the reviewed manifest and original sources:
rcl converge-gap --resume --manifest gap.json --manifest-sha256 <preview-manifest-sha256>
rcl converge-report --target rcl-81 --report original-r3.json --round 3 --json
```

Preview reads bounded original files and the native/attempt ledgers; its only
write is the requested exclusive manifest. An optional `--evidence <json-path>`
supplies an array of additional `{ "path": "...", "sha256": "..." }`
selections. Apply and resume accept only that manifest and its exact byte
digest. They share target ownership with ordinary writers, retain exact
original native, attempt and source bytes, and append audit checkpoints before
admission becomes available. They leave rounds, findings, verdicts, severities,
attempts used and caps unchanged. The controller exit stays `unknown`; supplied
files do not prove global absence. Neither audit mode flushes the outbox or
sends server events.

`converge-gap` supports one missing ordinal immediately before the selected
original report, with an explicit spent record for both ordinals and every
earlier ordinary round present from round 1. Histories with earlier gaps,
including audited gaps, are unsupported. Migrated totals without those records,
multiple gaps, altered sources and unsupported storage refuse. The later report
keeps its original round, run and contents. Later discovery of the missing
report needs separate explicit evidence recovery; an ordinary empty report
cannot fill the reserved gap. The audit is local history, never reviewer
health, convergence or gate approval, and it needs no Harness backend support.
Older clients preserve its additive metadata and still refuse an unadmitted
jump, but do not validate the receipt protocol; use a current client for gap
admission and recovery.

### `rcl converge-rejected`

A locally invalid report is retained in quarantine, outside the retryable
outbox. `deliveryFailure: local-invalid` describes delivery, independently of
reviewer quorum. It does not admit the report or authorize another review.
Transport failures and spooled evidence retain their existing delivery gates.

For an ordinary completed report rejected for missing verified-consensus
gating labels, preview a disposition using its original report and exact
digest:

```bash
rcl converge-rejected --preview --target owner-repo-123 --run ORIGINAL_RUN_UUID \
  --report /path/to/original.json --report-sha256 ORIGINAL_SHA256 \
  --reason "Original local rejection diagnosed; producer repair verified" \
  --manifest /path/to/rejection-preview.json --json
rcl converge-rejected --apply --manifest /path/to/rejection-preview.json \
  --manifest-sha256 REVIEWED_PREVIEW_SHA256 --json
```

The command verifies the original report, quarantine diagnostics and envelope,
blocking health, run/head/input identity, cycle and latest spent attempt. It
requires an exited coordinator and no admitted round or queued delivery. Valid
reports, unsupported rejection classes, incomplete or conflicting proof, live
or uncertain owners, and queued evidence refuse. Neither an empty outbox nor
exit code 4 establishes terminal rejection.

Apply retains complete immutable evidence before an atomic native-state update;
repeating the same apply is idempotent. The original reports, health, attempt
ledger, caps and review cycle stay unchanged. The native audit permanently bars
admission of the rejected original. A later normal guarded review still
requires an explicit bounded `--retry-reason`, normal preflight and remaining
budget; it claims the next attempt in the same cycle and native round. Recovery
itself uploads nothing, starts no provider calls and provides no convergence or
approval.

Queue checks are fail-closed observations, not a new global outbox lock. This
narrow recovery proves rejection before network delivery and requires the
original producer to have exited. It rechecks for queued evidence at apply and
before the later guarded claim. It never treats a server/transport refusal as
that proof. Historical audits use their retained copies, so ordinary temporary
source cleanup does not break subsequent review and admission.

## `rcl converge-attempt` (legacy accounting)

Low-level accounting command retained for legacy callers. The `rcl-converge`
skill instead uses `review --guarded-converge`; do not preclaim an attempt for
that path. Each call atomically and durably consumes one per-target attempt
under the repository's common Git directory, so the budget survives sessions,
linked worktrees, and abrupt system restarts. New targets default to twenty
attempts, but an explicit invocation can set any positive cap with
`--max-attempts`. Omitting the flag on resume preserves the persisted cap. At
the boundary, RCL refuses before provider calls and directs the workflow to ask
the user; an approved continuation explicitly supplies a higher cap.

Exit code 2 means the configured cap was exhausted and explicit continuation
approval is required. Exit code 3 means attempt accounting itself failed
(state, lock, Git, filesystem, or another infrastructure error); increasing the
cap is not the remedy. With `--json`, failures are emitted as structured JSON
on stderr. If the attempt is durably recorded but final lock release fails, the
claim still succeeds with a warning so retrying cannot spend a second slot for
the same intended launch.

The short accounting mutex is fully written as a private owner file and then
published with an exclusive hard link, which cannot replace an existing file or
legacy directory. State contents and, where supported, their directory entry
are synced before a claim succeeds. A dead owner is isolated through a
token-scoped hard-link tombstone before another claimant can proceed; inode
checks make that tombstone safe to remove after reclamation. Invalid or legacy
ownerless locks fail closed, and timeout errors include the manual recovery
path. When upgrading, an evidence ledger seeds only its highest recorded round:
historical failed or missing-report launches cannot be reconstructed, while
every claim after the machine state is created is counted exactly. The state
remains a same-user local safety mechanism, not a tamper-proof store:
deliberately deleting `.git/rcl-converge-attempts` is an explicit policy
bypass.

```bash
rcl converge-attempt --target owner-repo-123                    # default/persisted cap
rcl converge-attempt --target owner-repo-123 --max-attempts 10  # explicit override
```
