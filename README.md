# review-council

> Multi-model AI code review in your terminal — many models, many roles, one consensus.

![npm](https://img.shields.io/npm/v/review-council) ![license](https://img.shields.io/npm/l/review-council) ![node](https://img.shields.io/node/v/review-council)

---

## Install

```bash
npm install -g review-council
```

Requires Node.js >= 18.

---

## Quick Start

```bash
# Review a GitHub PR with default models and roles
rcl review owner/repo#42

# Review with specific roles and post findings as a PR comment
rcl review owner/repo#42 --roles security-auditor,bug-hunter --post

# Review a local patch file; fail CI if critical/important findings exist
rcl review changes.patch --ci --markdown report.md
```

---

## Built-in Roles

| Role | Description |
|------|-------------|
| 🔍 `general` | Comprehensive review covering all dimensions |
| 🔒 `security-auditor` | Auth, injection, XSS, CSRF, IDOR, and sensitive data exposure |
| ⚡ `performance-engineer` | N+1 queries, caching, algorithmic complexity, and memory efficiency |
| 📐 `api-design` | API contracts, breaking changes, REST/gRPC conventions |
| 🧪 `test-coverage` | Missing tests, edge cases, flawed test logic |
| ✏️ `dx-critic` | Readability, naming, documentation, and developer ergonomics |
| 🏗️ `architecture` | Module boundaries, coupling, and architectural patterns |
| 🐛 `bug-hunter` | Logic errors, null paths, race conditions, off-by-one |
| ♿ `accessibility-auditor` | WCAG compliance, ARIA roles, keyboard navigation |
| 📋 `project-rules` | Enforces repo conventions from `AGENTS.md`, `CLAUDE.md`, etc. |
| 📄 `spec-compliance` | Checks implementation against a spec or plan file |

List roles in the terminal:

```bash
rcl roles list
rcl roles show security-auditor
```

---

## CLI Reference

### `rcl review [target]`

Review a PR, a local diff, or uncommitted work.

**Target formats:**
- `owner/repo#N` — GitHub PR number
- GitHub PR URL
- Path to a `.patch` or `.diff` file
- No target with `--staged` or `--working-tree` — review uncommitted changes in the current repository

**Options:**

| Flag | Description |
|------|-------------|
| `--staged` | Review staged changes (`git diff --cached`) |
| `--working-tree` | Review all uncommitted changes (`git diff HEAD`, staged + unstaged) |
| `--role <name>` | Use a single named role |
| `--roles <names>` | Comma-separated list of roles |
| `--reviewer <model:role>` | Explicit model:role pair (repeatable) |
| `--models <models>` | Comma-separated list of models to use |
| `--context <path>` | Context file or directory (repeatable) |
| `--spec <path>` | Specification file for `spec-compliance` role |
| `--focus <areas>` | Comma-separated focus areas |
| `--post` | Post review as a GitHub PR comment |
| `--json` | Print JSON output to stdout |
| `--json-file <path>` | Write JSON output to a file |
| `--markdown <path>` | Write Markdown report to a file |
| `--ci` | Exit non-zero if critical/important findings exist |
| `--head-sha <sha>` | Exact head commit a patch file was taken from (patch files only) |
| `--base-sha <sha>` | Exact base commit a patch file was taken from (patch files only) |
| `--expect-head-sha <sha>` | Fail fast unless the resolved head commit equals this SHA |
| `--spec-source <source>` | Where `--spec` came from: `flag`, `repo_file`, or `harness_issue:<ID>` |
| `--converge-target <key>` / `--round <n>` / `--attempt <n>` | Converge context recorded in the report (or `RCL_CONVERGE_TARGET` / `_ROUND` / `_ATTEMPT`) |
| `--attest` | GitHub Actions gate workflow only: exchange the job's OIDC token for a run-bound Harness credential and record the review as attested (see below) |
| `--config <path>` | Path to a config file |

`--role`, `--roles`, and `--reviewer` are mutually exclusive. So are a positional target, `--staged`, and `--working-tree` — pick exactly one review source. Untracked files are invisible to `git diff` and therefore not reviewed.

**Self-describing reports (3.0).** Every report carries a `run` header: a client run id (UUIDv7), the rcl version, the target with its exact `head_sha`/`base_sha` (from GitHub for PRs, from `git rev-parse HEAD` and the merge-base with the remote default branch for `--staged`/`--working-tree`, from `--head-sha`/`--base-sha` for patch files) and a `diff_sha256`, the roster with each seat's lane (`blocking`, `secondary`, `async`, `verification`), a config digest with thresholds and gating inline, spec and context-file digests, a best-effort `runner` claim (`agent` / `ci` / `human`), timing, the CI verdict (computed even without `--ci`), and the converge context when run under rcl-converge. Every finding carries an `identity`, allocated uniquely across the report's consensus findings, including the below-threshold appendix. Keys use `report:<16-hex-key>` so report allocation cannot alias unrelated native ledger identities. Colliding location anchors are disambiguated before thresholding; native cross-round location matching still determines the unchanged canonical ledger identity. Every reviewer call records token `usage` where the provider reports it. Reports without a `run` header (pre-3.0) remain readable; ambiguous classifications are refused as described below.

**Examples:**

```bash
# Use explicit model:role pairs
rcl review owner/repo#7 \
  --reviewer claude-opus-4-6:security-auditor \
  --reviewer gpt-5.4:bug-hunter

# Spec compliance review with context
rcl review ./feature.patch --role spec-compliance --spec SPEC.md --context src/

# Output JSON for downstream processing
rcl review owner/repo#99 --json > findings.json

# Review your uncommitted work before committing
rcl review --staged
rcl review --working-tree --roles security-auditor,bug-hunter
```

---

### `rcl review-plan <file>`

Council-review an implementation plan document (PRD, BUILD_PLAN.md, design doc) **before any code exists** — the cheapest bugs to fix are the ones caught in the plan.

```bash
rcl review-plan docs/plan.md
rcl review-plan docs/plan.md --focus risks       # feasibility | completeness | risks | timeline
rcl review-plan docs/plan.md --spec PRD.md       # also check the plan against a spec
```

The plan flows through the normal pipeline — multi-model dispatch, dedup, consensus, agreement-tier report — with plan-adapted prompts. Finding line numbers refer to the plan document's own lines. Categories are reinterpreted for plans (`correctness` = infeasible/contradictory steps, `tests` = missing validation strategy, `best-practices` = process gaps like rollback/migration, …).

Default roles are a plan-suited subset (`general`, `architecture`, `edge-case-hunter`, plus `spec-compliance` when a spec is given); `--role`/`--roles`/`--reviewer` and config `roles` override as usual. Shares `--context`, `--models`, `--json`, `--json-file`, `--markdown`, and `--config` with `rcl review`. `--post` and `--ci` are not offered (no PR to post to; plan findings are judgment calls, not gates).

---

### `rcl discuss`

Ask the models that flagged a finding a follow-up question — one round, reconstructed from a saved report. Useful when triaging: "is this actually exploitable given the sanitizer at line 40?" goes to the reviewers who raised it (especially valuable for **disputed** findings, where the report shows each model's position).

```bash
rcl review --staged --json-file report.json
rcl discuss --report report.json --finding f003 "Is this exploitable given the sanitizer at line 40?"

# Attach code as context, or ask different models
rcl discuss --report report.json --finding f003 --context src/auth.ts "Does the middleware at line 12 not already cover this?"
rcl discuss --report report.json --finding f003 --models anthropic/claude-fable-5 "Summarize the strongest counterargument."
```

Model-generated finding ids can collide; when `--finding <id>` is ambiguous the error lists `<id>:<n>` disambiguators. Findings in the below-threshold appendix are addressable too. Answers come back in parallel, respecting the configured `timeout`, `maxRetries`, and `reasoningEffort`. There is no session state: each `discuss` is one independent round built from the report file.

---

### `rcl roles`

```bash
rcl roles list             # List all built-in roles
rcl roles show <name>      # Show system prompt and details for a role
```

---

### `rcl converge-attempt`

Machine-enforced safety guard used by the generated `rcl-converge` skill.
Each call atomically and durably consumes one per-target attempt under the
repository's common Git directory, so the budget survives sessions, linked
worktrees, and abrupt system restarts.
New targets default to twenty attempts, but an explicit invocation can set any
positive cap with `--max-attempts`. Omitting the flag on resume preserves the
persisted cap. At the boundary, RCL refuses before provider calls and directs
the workflow to ask the user; an approved continuation explicitly supplies a
higher cap.

At the skill level, `--max-attempts N` controls this machine launch budget.
The separate `--max-rounds N` flag caps evidence rounds and is machine-enforced
by `rcl converge-report` (default 15, valid range 2–99; rounds past 99 are
impossible under any flag). The default is a consent boundary, not a stop: at
15 rounds the workflow asks the user, and an approved continuation supplies a
higher `--max-rounds`.

Full-fleet reviewer completion is not required. For the generated
`rcl-converge` skill, let `N = stats.totalReviews`; a round is conclusive only
when `stats.successfulReviews >= max(2, ceil(2 × N / 3))`. Every timeout or
error must be disclosed, and a result below that threshold is inconclusive.

Exit code 2 means the configured cap was exhausted and explicit continuation
approval is required. Exit code 3 means attempt accounting itself failed
(state, lock, Git, filesystem, or another infrastructure error); increasing
the cap is not the remedy. With `--json`, failures are emitted as structured
JSON on stderr. If the attempt is durably recorded but final lock release
fails, the claim still succeeds with a warning so retrying cannot spend a
second slot for the same intended launch.

The short accounting mutex is fully written as a private owner file and then
published with an exclusive hard link, which cannot replace an existing file
or legacy directory. State contents and, where supported, their directory
entry are synced before a claim succeeds. A dead owner is isolated through a
token-scoped hard-link tombstone before another claimant can proceed; inode
checks make that tombstone safe to remove after reclamation. Invalid or legacy
ownerless locks fail closed, and timeout errors include the manual recovery
path. When upgrading,
an evidence ledger seeds only its highest recorded round: historical failed or
missing-report launches cannot be reconstructed, while every claim after the
machine state is created is counted exactly. The state remains a same-user
local safety mechanism, not a tamper-proof store: deliberately deleting
`.git/rcl-converge-attempts` is an explicit policy bypass.

```bash
rcl converge-attempt --target owner-repo-123                 # default/persisted cap
rcl converge-attempt --target owner-repo-123 --max-attempts 10  # explicit override
```

---

### `rcl converge-report` and `rcl converge-verdict`

The cross-round memory of a converge run, persisted in
`.git/rcl-converge-runs/<target>.json`.

`converge-report` dedupes one round's report JSON against every prior round of
the run using a location-anchored finding identity (hash of file + category +
line bucket, plus a line-overlap matcher — titles are deliberately ignored:
models rephrase ~98% of them between rounds). Each finding is classified
`new`, `repeat`, `suppressed` (previously dismissed — a dismissal is terminal
on its evidence and fresh corroboration alone never reopens it), or `regating`
(previously dismissed at non-critical severity, now sighted as critical —
genuinely new evidence). The same call enforces the evidence-round cap:
default 15, `--max-rounds` accepts 2–99, and rounds past 99 are impossible. Exit
code 2 is the cap consent boundary; exit 3 is a state failure.

A report key must identify one canonical identity, status and suppression reason.
`converge-report` refuses conflicting mappings with exit 3 before writing the
round state, even when telemetry is off. Reports without finding keys use the
canonical identity as a fallback and are subject to the same check. This leaves
ambiguous older reports readable but not classifiable by this command. Preserve
the original report and ledger for separately supported finding-ref recovery;
rewriting published evidence or rerunning an unchanged council is not recovery.
Identical mappings still deduplicate, and native ledger keys and verdicts do not
change when new namespaced report keys appear.

`converge-verdict` records triage outcomes per finding identity —
`--fixed <key>` and `--dismissed '<key>=<reason>'` (both repeatable) — which
drives later-round suppression and accrues the per-model precision history.
Once every gating identity of the current round is triaged, it also reports
the round's resolution: `converged-dismissal-only` (everything dismissed,
nothing fixed — the round converges on the spot, no confirmation round),
`fixes-pending-fresh-round`, or `unresolved` with the identities still open.

```bash
rcl converge-report --target rcl-30 --report report-r2.json --round 2 --json
rcl converge-verdict --target rcl-30 --round 2 \
  --fixed 9787c6ea72ae778c --dismissed 'd2baf9675eb450f0=guard already exists'
```

---

### `rcl telemetry status` and `rcl telemetry flush`

Evidence delivery to Harness (epic IO-12475). In a repository that carries
`.harness-cli/config.json` and with a `harness login` (or `HARNESS_API_TOKEN` +
`HARNESS_API_URL` in CI), every `rcl review` / `rcl review-plan` records the
run on Harness after the report is written: the self-describing `run` header,
one row per consensus finding (with its stable identity), one row per reviewer
call (status, latency, token usage), the report's `stats`, and — at the default
`full` level — the JSON and Markdown reports exactly as written, digest-checked
by the server. The converge commands report their events (attempt claims, cap
changes, processed rounds, verdicts, resolutions) the same way. Never sent:
provider API keys, `GITHUB_TOKEN`, the Harness credential, environment
variables, prompts or raw model answers; every free-text field is truncated
and scrubbed for key-shaped strings before it leaves the process.

The review never blocks on the network. A delivery Harness could not take is
spooled to `~/.rcl/outbox/<run id>/` and retried, with its original run id,
at the start of every rcl command (bounded to five seconds) or by
`rcl telemetry flush`. One dim status line says what happened:
`Evidence recorded: <url>`, `Evidence spooled (Harness unreachable); run rcl
telemetry flush`, or `Evidence not sent: <host> has not enabled review
evidence for this organization`. `--evidence-required` exits 4 when the
evidence is incomplete: the envelope was spooled or refused, the organization
has evidence off, or a declared artifact did not land (a patch file then needs
`--head-sha`, and the flag contradicts `--no-telemetry` / `RCL_TELEMETRY=off`).
Only a spooled delivery is worth `rcl telemetry flush --run <id>`; the status
line says which. Under `--ci` the gate verdict keeps its exit code and the
evidence failure is printed beside it. The first delivery from a machine
prints a one-time notice naming the host and what is sent
(`~/.rcl/telemetry-notice` records it).

```bash
rcl telemetry status                # level, credential source, what waits in the outbox
rcl telemetry flush                 # deliver everything spooled, to completion
rcl telemetry flush --run <run id>  # one run only
rcl review owner/repo#7 --no-telemetry   # keep this review on the machine
```

```yaml
# .review-council.yml
harness:
  telemetry: full        # off | envelope | findings | full (default)
  parseFailures: false   # send a parse-failed call's raw answer (scrubbed, 32 KB cap)
```

---

### `--attest`: attested reviews from the gate workflow

Only evidence recorded from the organization's own gate workflow on GitHub
Actions counts for the enforced gate (epic IO-12475, section 4.1). Inside
such a job — one that grants `id-token: write` — `rcl review owner/repo#N
--attest` asks the runner for the job's OIDC token with the Harness origin as
audience, exchanges it at `POST /api/v1/reviews/attest` for a **run-bound
credential** (`rbc_…`, thirty minutes, one rcl run id, valid while the
Actions run is in progress), and records the review under it: the envelope,
its artifacts, the model keys and the model stats all travel with that
credential and nothing else. Harness verifies the token, requires the
workflow file to be on the organization's gate allow-list at its default
branch, re-reads the pull request through its GitHub App and stores the run
only if the reviewed head is the pull request's current head and the PR is
not from a fork — the run is then `credential_kind: attested`.

`--attest` fails loudly, before any token is requested or any reviewer is
paid: outside Actions (no `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN`), without
`HARNESS_API_URL`, off a pull request target, with a telemetry level other
than `full` (from `RCL_TELEMETRY` or the project config — an attested run
carries its full report), or when Harness refuses the exchange (the refusal
names the reason: `workflow_not_allowed`, `reviews_disabled`,
`run_not_in_progress`, …). It never falls back to `HARNESS_API_TOKEN` or the
stored login, it implies `--evidence-required`, and nothing recorded under the
run-bound credential is ever spooled — the credential does not outlive the
workflow run. A review that outlasts most of the credential's thirty minutes
mints it again for the same run id before delivery. Pair it with
`--expect-head-sha` so a moved pull request fails fast instead of being
refused at ingest.

```yaml
# .github/workflows/review_gate.yml (dispatched by Harness for one pull request)
permissions:
  id-token: write
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    env:
      HARNESS_API_URL: https://harness.infra.one
    steps:
      - run: npm i -g review-council
      # Inputs reach the shell through the environment, never by expression
      # interpolation into the command line.
      - env:
          REPO: ${{ inputs.repo }}
          PR: ${{ inputs.pr }}
          HEAD_SHA: ${{ inputs.head_sha }}
        run: rcl review "$REPO#$PR" --attest --expect-head-sha "$HEAD_SHA" --ci
```

---

### `rcl evidence status` and `rcl evidence show`

What Harness holds — never the client's own claim. `rcl evidence status`
prints the gate status Harness computed for a pull request: its known head,
the advisory and enforced projections (status, the rounds behind them, the
actionable findings still open) and the merge decision once it merged. The
exit code is the contract the skills gate on:

| exit | meaning |
| --- | --- |
| 0 | the judged projection (advisory by default, `--enforced` on request) is `converged` |
| 1 | any other status: `none`, `stale`, `unverified`, `inconclusive`, `fixes_pending`, `unresolved` |
| 2 | the pull request could not be named |
| 3 | the read could not be answered: no credential, evidence off for the organization, unknown pull request, refused credential, unreachable host — never reported as "not converged" |

`rcl evidence show <run id>` prints one recorded run: header and verification,
credential tier and runner, reviewer health, artifact state, and every finding
with its identity, gating reason and triage verdict (`—` until the server
joins the verdict onto the finding).

The reads use the same credential rules as delivery — the stored `harness
login`, or `HARNESS_API_TOKEN` + `HARNESS_API_URL` in CI, the token sent to
its own host only — and need `reviews:read`. They do not depend on the
telemetry level: switching delivery off does not blind them.

```bash
rcl evidence status                   # error: name the pull request
rcl evidence status 8524              # against the current checkout's origin remote
rcl evidence status '#8524' --enforced
rcl evidence status allocator-one/rcl#42 --json
rcl evidence status https://github.com/allocator-one/rcl/pull/42
rcl evidence show 01a08032-0838-76db-ade3-1990f6e54072
```

### `--for-pr` on a patch-file review

A patch-file review (`rcl review changes.patch`) carries no repository or pull
request, so Harness records it as a `patch` run it cannot verify or count for
any gate. `--for-pr owner/repo#N` (or a pull request URL) names the pull
request the patch was taken from (`RCL_FOR_PR` in the environment does the
same for patch files): the run is bound to that pull request and its
`--head-sha` — required with the flag — is verified against the pull
request's head. Owner and repository are lower-cased, as GitHub reads them. Counting the round for that pull request's
gate is the server half (IO-12585); until it lands, `rcl evidence status`
still reads `stale`/`none` for patch-file loops. The flag is refused on PR and
git-mode targets, which name their own pull request or checkout. `rcl-converge` passes `--converge-target`, `--round`
and `--attempt` on every round and adds `--for-pr` when a pull request loop
reviews a patch file taken from the pull request (a pull request target names
its own). A converge
target of the `owner/repo#N` form attributes the run the same way; a slug such
as `rcl-7` does not.

```bash
rcl review round-3.patch --head-sha "$HEAD" --base-sha "$BASE" --for-pr allocator-one/rcl#42 \
  --converge-target allocator-one/rcl#42 --round 3 --attempt 3 --evidence-required
```

### `rcl models`

The tool's own memory of which reviewers earn their seat. Every reviewer call
and every `converge-verdict` outcome accrues in a cross-run store at `~/.rcl`
(`RCL_DATA_DIR` overrides; deliberately not under /tmp, so history survives
converge-state cleanup). `rcl models` prints, per model over a trailing 90-day
window: triage precision (share of its supported findings the converge loop
verified and fixed rather than dismissed), triage volume, call volume,
dead-call rate, p50 latency — and the consensus **weight** the model earns:
`0.5 + precision`, clamped to [0.5, 1.5], neutral (1) below 20 triaged
outcomes. Weights scale each model's consensus vote in report confidence and
in consensus gating, so persistently noisy models lose gating power
automatically; the applied weights are visible per finding
(`consensus.weightedScore` / `consensus.modelWeights`) and per run
(`stats.modelWeights`) in the report JSON.

```bash
rcl models                       # table over the trailing 90 days
rcl models show --window 30 --json
rcl models seed --from ~/recovered-rcl-artifacts   # backfill from reports + converge ledgers
```

---

Since 3.1 the table merges the organization's window from Harness
(`GET /api/v1/reviews/model-stats`, the server-side `rcl models` over every run
the org recorded, backfilled history included) with this machine's store: for a
model the server holds at least 20 outcomes for, the server's weight is used
(`source: server`); below that the local store decides (`local`); a model
neither knows enough about keeps the neutral weight (`neutral`). Reviews weight
consensus the same way, asking the server with a three-second bound and falling
back to the local store when it cannot answer. `--local` shows this machine's
view alone; `--json` carries `server` (host, window, rows) and `weights` with
their `source`.

```bash
rcl models                       # org-wide where Harness has enough history, local otherwise
rcl models show --local          # this machine's store only
rcl models show --window 30 --json
```

### `rcl telemetry backfill`

Recovered history becomes day-one evidence on Harness. `rcl telemetry backfill
--from <dir> --repo <owner/repo>` reads the pre-3.0 `rcl-report-*.json`
reports and `rcl-converge-*-ledger.md` ledgers in a directory (the same layout
`rcl models seed` reads) and posts each report as a run with `provenance:
backfill`: a synthesized header bound to the named repository (target `patch`,
the report bytes as the digest, a runner claim naming this command), the
report's findings with their stable identities, its reviewer calls, and the
report files as artifacts. Ledger bullets matched to a round's findings become
`verdicts_recorded` events. Run ids are UUIDv5 of `(host, repo, sha256 of the
report)` and event ids derive from them, so running the backfill twice reports
the second run as `0 new` — nothing is duplicated. Backfilled runs count for
model stats and analytics and never enter a gate decision.

```bash
rcl telemetry backfill --from ~/recovered-rcl-artifacts --repo allocator-one/allocator-one --dry-run
rcl telemetry backfill --from ~/recovered-rcl-artifacts --repo allocator-one/allocator-one
```

## Config File

Place `.review-council.yml` in your project root (or any parent directory). All fields are optional.

```yaml
# Blocking council (provider-prefixed names) — every round waits for these.
# Shown here: the actual defaults. Keep slow/aggregator-routed models out of
# this list; give them an async seat instead.
models:
  - anthropic/claude-fable-5
  - openai/gpt-5.6-sol
  - google/gemini-3.8-flash

# Async bonus reviewers — fired with each round, never awaited. Results that
# have arrived by the next round of the same target are merged into that
# round's dedup and marked `async` in the report JSON.
# Any model on https://openrouter.ai works — keep the vendor segment after the prefix.
asyncModels:
  - openrouter/moonshotai/kimi-k3

# Default roles to run
roles:
  - security-auditor
  - bug-hunter
  - test-coverage

# Or pin explicit model:role pairs
reviewers:
  - model: anthropic/claude-opus-4-6
    role: security-auditor
  - model: openai/gpt-5.4
    role: bug-hunter

# Custom role overrides (extends a built-in or creates new)
customRoles:
  - name: my-style-guide
    focus: [best-practices]
    systemPrompt: |
      Enforce our team style guide. Flag any deviation from snake_case
      variable names and require docstrings on all public functions.

# Consensus and deduplication thresholds
thresholds:
  minConsensusScore: 0.4   # 0–1; findings below this are demoted to the appendix
  minConfidence: 0.2
  dedupeLineWindow: 5      # lines within which findings are merged
  jaccardThreshold: 0.3    # weighted title+description similarity threshold for dedup

# Convergence gating: which findings block convergence / CI (RCL-23).
# A finding gates when multi-model, critical, or unrefuted by a cheap
# verification pass; refuted single-model claims stay in the report but
# stop blocking. Report JSON marks every finding with gating.reason
# (consensus | critical | verified | none).
gating:
  mode: verified-consensus        # or all-findings (legacy: severity alone decides)
  minModels: 2                    # distinct models for consensus gating
  verificationModel: google/gemini-3.8-flash  # direct-API only
  verificationTimeout: 60000      # ms for the single batched refutation call

# Output defaults
output:
  markdown: true
  markdownPath: review-report.md
  belowThresholdAppendix: true  # false drops below-threshold findings outright

# Concurrency and reliability
concurrency: 6
timeout: 540000       # ms per blocking model call (matches the current default)
asyncTimeout: 900000  # ms per async-lane call (slow reasoning models get headroom; nothing waits on them)
# quorumFraction: 0.75  # round closes once this share of calls has completed; stragglers
                        # are canceled and recorded (core `models` are never canceled).
                        # Default: exactly 2/3 — leave unset for that; 1 disables.
maxRetries: 3

# Reasoning budget for providers that support it (currently OpenRouter).
# low | medium | high — default medium. Unbounded reasoning makes these
# models spend the whole completion budget thinking before they answer;
# raise to 'high' for deeper review at the cost of latency and tokens.
reasoningEffort: medium

# Context files to attach to every review
context:
  - ARCHITECTURE.md
  - docs/api.md

# Spec file for spec-compliance role
spec: SPEC.md

# GitHub token (prefer GITHUB_TOKEN env var instead)
# githubToken: ghp_...
```

Supported config file names: `.review-council.yml`, `.review-council.yaml`, `.review-council.json`, `review-council.config.js`.

Before dispatch, RCL prints the expanded reviewer × chunk call count,
concurrency, wave count, timeout, and timeout-bound queue estimate. Interactive
runs update the spinner; redirected runs emit periodic heartbeat and bounded
completion lines with status counters, so a long queue is distinguishable from
a hung process.

---

## How Consensus Works

When multiple models and roles review the same diff, their findings are:

1. **Deduplicated** — findings on the same file and overlapping line range are grouped by weighted title+description token similarity; findings in different categories can still merge, but need stronger similarity (models disagree on category boundaries constantly). Findings whose line ranges strictly overlap and that name the same issue concept (sql injection, IDOR, hardcoded secret, …) merge regardless of wording — models phrase the same issue too differently for token overlap alone. Repeats within a single review are collapsed first. Findings that clearly reach opposite conclusions are kept as separate, disputed findings; subtler contradictions merge but are flagged as disputed.
2. **Scored** — each group receives a consensus score based on three dimensions: reviewer diversity (how many distinct models and roles flagged it, saturating at half the fleet so large configurations aren't penalized), role relevance (whether a role specialised in that finding type confirmed it), and isolation (what fraction of relevant reviewers flagged it).
3. **Classified** — groups are assigned a confidence band (Very High → Minimal) and a final severity. Severity is the most common rating across reviewers; when reviewers disagree, high-confidence agreement elevates it, but only to a severity at least two reviewers independently assigned — a lone outlier rating is surfaced as a dispute instead. Each group also gets an **agreement tier** measured over distinct models — `unanimous` (every successful model), `majority` (at least half), `minority` (2+, under half), `single` (one model) — because roles share a model's blind spots, so model count is the evidence axis.
4. **Filtered** — groups below `minConsensusScore` or `minConfidence` are demoted (blocking severities are never dropped). Demoted findings land in a collapsed "worth checking" appendix at the bottom of the report and in the JSON `belowThresholdFindings` field — never in severity totals or CI gating. Set `output.belowThresholdAppendix: false` to drop them outright instead.

The report is organized by agreement tier — unanimous first, then majority, minority, **disputed** (reviewers reached materially different conclusions; rendered as per-model positions so you can judge), and single-model last. Within each tier, findings sort by severity. The tier structure is the point of a multi-model council: it tells you which findings are independently confirmed and where to spend your own judgment.

For the full algorithm, see [CONSENSUS_V2_SPEC.md](./CONSENSUS_V2_SPEC.md).

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Claude models |
| `OPENAI_API_KEY` | API key for OpenAI models |
| `GEMINI_API_KEY` | API key for Google Gemini models |
| `OPENROUTER_API_KEY` | API key for [OpenRouter](https://openrouter.ai) models (`openrouter/…` prefix) |
| `GITHUB_TOKEN` | GitHub personal access token (PR fetch and post) |
| `RCL_DEBUG` | Set to any value to print full error stack traces |
| `RCL_NO_HARNESS_KEYS` | Set to any value to disable Harness key distribution (below) |
| `RCL_TELEMETRY` | `off` keeps every review on the machine (see `rcl telemetry`) |
| `HARNESS_API_TOKEN` | CI credential for evidence delivery; requires `HARNESS_API_URL` — never pairs with the stored login host |
| `HARNESS_API_URL` | The Harness host `HARNESS_API_TOKEN` was minted by; under `--attest` the host attested to (no token needed) |
| `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | Set by the GitHub Actions runner for jobs with `id-token: write`; `--attest` reads them and refuses to run without them |

The default blocking council is direct-API only (Anthropic, OpenAI, Google) —
no default review round ever waits on an OpenRouter-routed call. The default
async lane holds one OpenRouter-hosted bonus reviewer (`kimi-k3`); if
`OPENROUTER_API_KEY` is not set, it is dropped from the defaults with a warning
(models you configure explicitly still fail loudly instead). Note that when the
key is set, default reviews send diff and context content to OpenRouter — an
aggregator and an additional data processor beyond the direct model providers —
as well as to Anthropic, OpenAI, and Google. Configure `models:` and
`asyncModels:` explicitly if that matters for your repository.

### Key distribution via Harness

Repos that carry a committed `.harness-cli/config.json` (discovered git-style,
walking up from the working directory) can get their provider keys from a
[Harness](https://harness.infra.one) backend instead of every teammate managing
them by hand: run `harness login` once, and any provider key **missing from the
environment** is fetched from `GET /api/v1/model-keys` on the host that minted
the stored login token, and injected for the run.

- Environment variables always win — only missing keys are injected.
- The stored credential is only ever sent to the host it was minted for, never
  to a URL named by the repo's own config (untrusted input in a cloned repo).
- Any failure — not logged in, offline, older backend without the endpoint —
  falls back silently to the plain-environment behavior above. The fetch runs
  under a 3-second timeout and keys are never written to disk or logs.
- Which providers the backend serves is server configuration
  (`HARNESS_MODEL_KEYS` on the backend); `RCL_NO_HARNESS_KEYS` disables the
  whole mechanism client-side.

---

## License

MIT © 2026 Michael Ströck
