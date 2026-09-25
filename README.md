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

**Self-describing reports (3.0).** Every report carries a `run` header: a client run id (UUIDv7), the rcl version, the target with its exact `head_sha`/`base_sha` (from GitHub for PRs, from `git rev-parse HEAD` and the merge-base with the remote default branch for `--staged`/`--working-tree`, from `--head-sha`/`--base-sha` for patch files) and a `diff_sha256`, the roster with each seat's lane (`blocking`, `secondary`, `async`, `verification`), a config digest with thresholds and gating inline, spec and context-file digests, a best-effort `runner` claim (`agent` / `ci` / `human`), timing, the CI verdict (computed even without `--ci`), and the converge context when run under rcl-converge. Every finding carries an `identity`, allocated uniquely across the report's consensus findings, including the below-threshold appendix. Keys use `report:<run-id>:<16-hex-key>` so report allocation cannot alias unrelated native ledger identities or reuse another run's classification. Colliding location anchors are disambiguated before thresholding; native cross-round location matching still determines the unchanged canonical ledger identity. Every reviewer call records token `usage` where the provider reports it. Reports without a `run` header (pre-3.0) remain readable; ambiguous classifications are refused as described below.

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
change when new run-scoped report keys appear. Until the current run's
classification is delivered, older runs' aliases cannot resolve its new report
keys. A report without a current classification does not inherit prior native
verdicts, even when its findings look unchanged.

`converge-verdict` records triage outcomes per finding identity —
`--fixed <key>` and `--dismissed '<key>=<reason>'` (both repeatable) — which
drives later-round suppression and accrues the per-model precision history.
Add `--fixed-reason '<key>=<reason>'` to attach the current fix explanation to
an identity also passed to `--fixed`. A fixed verdict without this option clears
any prior explanation; it never reuses an earlier dismissal reason. Each identity
may appear once per command, and each fixed reason must be nonempty and unique.
Once every gating identity of the current round is triaged, it also reports
the round's resolution: `converged-dismissal-only` (everything dismissed,
nothing fixed — the round converges on the spot, no confirmation round),
`fixes-pending-fresh-round`, or `unresolved` with the identities still open.

```bash
rcl converge-report --target rcl-30 --report report-r2.json --round 2 --json
rcl converge-verdict --target rcl-30 --round 2 \
  --fixed 9787c6ea72ae778c \
  --fixed-reason '9787c6ea72ae778c=callback failures now have a distinct outcome' \
  --dismissed 'd2baf9675eb450f0=guard already exists'
```

### `rcl converge-gap`

A paid attempt and an admitted report round are separate counters. If an original
later report already carries round 3 while native history ends at round 1, preserve
that original. Do not relabel it, create an empty round 2, reset budgets, or launch
reviewers again for bookkeeping.

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

Preview reads bounded original files and the native/attempt ledgers; its only write
is the requested exclusive manifest. An optional `--evidence <json-path>` supplies
an array of additional `{ "path": "...", "sha256": "..." }` selections. Apply and
resume accept only that manifest and its exact byte digest. They share target
ownership with ordinary writers, retain exact original native, attempt and source
bytes, and append audit checkpoints before admission becomes available. They leave
rounds, findings, verdicts, severities, attempts used and caps unchanged. The
controller exit stays `unknown`; supplied files do not prove global absence.
Neither audit mode flushes the outbox or sends server events.

This version supports one missing ordinal immediately before the selected original
report, with an explicit spent record for both ordinals and every earlier ordinary
round present from round 1. Histories with earlier gaps, including audited gaps,
are unsupported. Migrated totals without those records, multiple gaps, altered
sources and unsupported storage refuse.
The later report keeps its original round, run and contents. Later discovery of
the missing report needs separate explicit evidence recovery; an ordinary empty
report cannot fill the reserved gap. Audit is local history, never reviewer health,
convergence or gate approval. Existing v1 clients preserve its additive metadata
and still refuse an unadmitted jump, but do not validate the new receipt protocol.
Use this version for gap admission and recovery; no new backend capability is claimed.

---

Structured findings include the recorded verifier model and explanation, when present,
at both `findings` and `full` telemetry levels. The JSON report and wire envelope
share normalization: blank values are absent, model identifiers are capped at 500
Unicode code points, and explanations at 2,000. Missing legacy explanations are
never generated. Unicode normalization forms and gate outcomes are unchanged.

Quoted credential assignments are redacted through their closing quote or end of
input, including multiline and unfinished values. Preliminary text truncation
keeps only through the last whitespace in its bounded prefix (or only an ellipsis
if there is none), preventing partial secrets from surviving redaction. The shared
fixture `test/fixtures/verification-normalization.json` comes from allocator-one
PR #8974 and pins the receiver contract. This corrects the quoted-value and
preliminary-truncation behavior of RCL 3.6.0. Existing source reports are not
rewritten to add explanations; legacy backfill retains its declared artifact
scrubbing and deterministic source identity rules.

### `rcl telemetry status`, `flush` and `rejected`

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

The review never blocks on the network. A retryable delivery outage is
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

Completed envelopes are validated locally before transmission. Two valid
reversed line numbers are ordered before finding identity is allocated, with
the original numeric pair retained as parser provenance. Missing, blank,
boolean, negative, fractional or non-finite coordinates remain parser errors;
valid sibling findings are preserved. Provenance delivery requires the server
to advertise evidence protocol version 2.

Local validation failures and terminal server refusals retain the exact JSON
and Markdown bytes in `~/.rcl/quarantine/<run id>/` (or under `RCL_DATA_DIR`).
The immutable manifest records original digests, delivery mode and diagnostics;
distinct later delivery observations are appended separately. Interrupted or
corrupted entries are reported as incomplete. Retention failure, including a
read-only filesystem or the 1 GiB storage cap, is reported explicitly.
`rcl telemetry rejected` inspects these files and verifies their digests without
contacting Harness, flushing the outbox, changing native review accounting or
applying recovery. Retained evidence is not server acknowledgment. Attested
evidence is never queued for replay with ordinary credentials. Recovery of an
already-completed historical run remains a separate operation.

```bash
rcl telemetry status                # level, credential source, what waits in the outbox
rcl telemetry flush                 # deliver everything spooled, to completion
rcl telemetry flush --run <run id>  # one run only
rcl telemetry rejected --run <run id> --json  # inspect one retained original
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

Operators recovering the gate's encrypted GitHub artifact must use the
[review evidence recovery runbook](https://github.com/allocator-one/rcl/blob/main/docs/review-evidence-recovery.md).
Recovery requires the separately held, version-mapped private key and does not
confer review or merge approval.

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
with its identity and gating reason. Each **Verification** block shows the
recorded result, actual model and complete stored explanation. Recovered notes
identify the original report digest and recovery time. Legacy results without
a note say `Explanation not recorded`; `unavailable` remains distinct from
`refuted`. A separate **Triage** block shows the recorded judgment, reason,
actor, round and recording time when available. Missing attribution stays
unknown, and a displayed judgment does not assert current gate resolution.

Text preserves multiline explanations while scrubbing credential-shaped text
and terminal controls. `--json` preserves the API object's semantic values with
safe control-character escaping. Older servers may omit the optional evidence
and attribution fields. Local Markdown reports also show verifier explanations
for kept findings and the rendered below-threshold appendix; the appendix still
shows at most 20 findings and points to JSON for omitted entries.

The reads use the same credential rules as delivery — the stored `harness
login`, or `HARNESS_API_TOKEN` + `HARNESS_API_URL` in CI, the token sent to
its own host only — and need `reviews:read`. They do not depend on the
telemetry level: switching delivery off does not blind them.
Both commands send only their normal GET requests. They neither fetch an
artifact per finding nor flush pending retry deliveries, run reviewers or
record verdicts. Use `rcl telemetry flush` explicitly to retry queued delivery.

```bash
rcl evidence status                   # error: name the pull request
rcl evidence status 8524              # against the current checkout's origin remote
rcl evidence status '#8524' --enforced
rcl evidence status allocator-one/rcl#42 --json
rcl evidence status https://github.com/allocator-one/rcl/pull/42
rcl evidence show 01a08032-0838-76db-ade3-1990f6e54072
```

### `rcl evidence recover-run`

Recover one original completed asserted run without rerunning review, changing its
UUID or rewriting its JSON/Markdown artifacts. This is delivery only: it does not
admit a native round, record verdicts, change attempts/precision, flush unrelated
outbox entries or confer gate approval. Semantic claim splits are not part of this
command.

First prepare an exclusive manifest using explicit original source pins:

```sh
rcl evidence recover-run --preview --manifest original-run.json \
  --run "$ORIGINAL_RUN_ID" --for-pr owner/repo#123 --head "$ORIGINAL_HEAD_SHA" \
  --report-json /absolute/original/report.json --report-sha256 "$JSON_SHA256" \
  --report-md /absolute/original/report.md --markdown-sha256 "$MARKDOWN_SHA256" \
  --original-mode asserted --json
```

Markdown is optional; its path and digest must be supplied together. The report
must retain its complete modern header, explicit finding identities, and an exact
PR or PR-bound patch target. Original run UUID bytes are preserved; only generated operation IDs are canonical lowercase. Recovery
refuses other spellings instead of rewriting identity. Headerless imports, CI/attested/backfill originals,
unknown mode fields, missing sources and ambiguous bindings refuse. The explicit
asserted mode is an **operator assertion**, checked against the retained non-CI
runner metadata; it is not cryptographic proof of the original invocation. A
run-bound credential is never converted to a normal login.

Preview validates all local inputs before HTTP and writes only the explicitly
named manifest. Its formatted UTF-8 representation, including the final newline,
must fit within 8 MiB so apply and resume can read it. Oversized prepared evidence
refuses before HTTP; the complete manifest is checked again before publication.
It makes scoped authenticated GET requests, requires
`meta.original_report_recovery_version: 1` and evidence protocol 2, and binds the
host and server organization. An older or disabled server remains unsupported.
Inspect the manifest's exact envelope, source digests, transformations and retained
content limitations, then use the digest printed by preview:

```sh
rcl evidence recover-run --apply --manifest original-run.json \
  --manifest-sha256 "$MANIFEST_SHA256" --json

# After interruption or an uncertain acknowledgment, reuse that same operation.
rcl evidence recover-run --resume --manifest original-run.json \
  --manifest-sha256 "$MANIFEST_SHA256" --json
```

Apply starts an adjacent `original-run.json.journal` directory with append-only,
fsynced checkpoints before every remote write. Each checkpoint has an
8 MiB + 1 KiB read/write bound, retaining the manifest's full prose audit and
reserving space for the checkpoint wrapper.
Oversized checkpoints refuse before publication. Apply and resume require the
journal to be effective-user-owned mode 0700, on the supported local storage
listed below, with protected ancestors and no harmful or unknown ACL grants.
Apply checks the selected parent before creating the journal exclusively; resume
never creates missing state or repairs permissions. Each append checks the
selected journal's device/inode identity before writing. This detects replacement
between checkpoints; it does not claim protection against concurrent privileged
or same-user path manipulation. Resume requires that directory;
it never generates a replacement operation. A dedicated
`RCL_DATA_DIR/original-run-recovery-locks` directory serializes applies for the same
host/organization/run, including different manifest paths. Native accounting
locks and stores are not used. Locks with incomplete or unverifiable ownership
fail closed and require inspection; never delete a live lock.

The lock uses a unique registration per acquisition and automatically removes a
dead participant only when its PID is absent in the same kernel boot and PID
namespace. A reboot, foreign scope, PID reuse or uncertain liveness requires
inspection or a bounded retry; age alone never permits deletion. Legacy private
`.lock`/`.reclaim` state is refused, not migrated or bypassed. Empty `.bakery`
registries remain in place, and an interrupted unpublished `.tmp` is harmless.
Concurrent older private recovery clients are unsupported.

This protocol requires coherent ordinary local storage: local APFS/HFS with
ownership enabled on macOS, or ext2/3/4, tmpfs, XFS or Btrfs on Linux. Network,
FUSE, overlay and unknown filesystems are unsupported. macOS refuses an ambiguous
system mount listing, including an ambiguous entry for an unrelated mount. It
uses the existing directory's filesystem name and mountpoint from bounded
`df --libxo json` output, matched to one exact mount-table entry; firmlink or case
aliases never select an ancestor's flags. Unavailable structured inspection or
unmatched/ambiguous attribution refuses without a fallback. It
rejects ACL allow grants or unrecognized ACL output; restrictive deny-only ACLs
are allowed. The root must already be private (effective-user-owned
mode 0700), and ancestors must be protected against other users' writes, apart
from root-owned sticky temporary directories. Missing private directories are
created; existing permissions are never silently repaired. These checks do not
certify arbitrary filesystem implementations or protect against hostile code
running as the same user or a privileged administrator.

Every invocation rechecks source bytes and the reviewed manifest. Before retrying,
it reads and compares all immutable run header/settings/findings/calls/artifact
declarations, then fetches exact raw artifact bytes and verifies their digest and
size. A POST duplicate receipt or a stored-artifact flag alone is insufficient.
Lost POST/PUT acknowledgment can finish through exact reads; otherwise the same
journal remains incomplete. Changed bytes, organization, header, findings or calls
refuse. A torn last checkpoint is retained and bound into the next append; it is
never treated as acknowledgment. Preserve the manifest, journal and sources until
independent reconciliation is complete.

Only unpaired UTF-16 units in actual finding `title`, `description` or
`suggestedFix` prose receive a derived wire spelling: visible ASCII `\uD800`,
using uppercase hex. Valid surrogate pairs and existing literal backslash-u text
remain unchanged. Each transformation records the original JSON path, code-unit
index and byte offset. Keys, identifiers, descriptors and structural fields cannot
receive that transformation. Existing producer `[redacted]` literals in finding
prose stay unchanged and are listed as retained-content limitations; markers in
protected bindings, or any newly required secret redaction, refuse. Markdown
requiring redaction is unsupported. No fresh-report normalizer or backfill UUID
is applied to the original.

An original that contains an escaped C0 control or literal DEL in that same
finding prose is unsupported by default. When the retained report must be
represented, select the explicit, versioned mode during preview:

```sh
rcl evidence recover-run --preview --manifest original-run.json \
  --run "$ORIGINAL_RUN_ID" --for-pr owner/repo#123 --head "$ORIGINAL_HEAD_SHA" \
  --report-json /absolute/original/report.json --report-sha256 "$JSON_SHA256" \
  --original-mode asserted --original-prose control-code-units-v1 --json
```

This selection never rewrites the retained artifact or its digest. It projects
only allowed finding-prose controls to visible uppercase `\uXXXX` transport text
and records a version-1 `control_code_unit` transformation with the source path,
code-unit offset and original UTF-8 byte offset. Short JSON escapes
(`\b`, `\f`), `\uXXXX` escapes and literal DEL are covered. Literal tab, LF
and CR are valid JSON prose and remain literal; they are not transformed. Raw
unescaped C0 is invalid JSON; controls in keys, descriptors, identifiers,
locations or other structural fields refuse. Existing surrogate records keep
their prior shape.

The mode is intentionally unavailable against older servers. Preview requires
the usual recovery/evidence metadata **and**
`meta.original_prose_representation_version: 1`; without it, it makes the scoped
capability GET but writes no manifest and sends no delivery request. Apply and
resume use the selected, manifest-pinned representation and repeat that check.
Inspect the visible projection and transformation records before applying. A
successful delivery still does not repair native accounting or establish a fresh
review gate.

Existing transport scrubbing, limits, call summaries and duration rounding remain
explicitly recorded derivations. Two valid reversed integer coordinates may use
`report_projection` provenance bound to the original coordinates and JSON digest;
original finding identities are never recomputed from the normalized interval.
Unsupported coordinate types refuse rather than being guessed.

Exit codes: `0` means preview prepared or delivery independently verified; `2`
means invalid/unavailable local selection; `3` means remote capability/read/delivery
unanswered; `4` means conflicting destination, evidence or journal bindings; `5` means local durable
journal/lock persistence failed. JSON diagnostics include the stage and next step.
Even successful delivery does not establish current-head review freshness,
convergence, attestation or historical accounting repair.

### `rcl evidence recover-finding`

Recover one recorded finding whose report identity collided, using its retained
native convergence identity. Preview is the default; `--submit` explicitly
posts one attributed `finding_identity_corrected` event. This unpaid command
never calls reviewers, claims an attempt, changes a round or verdict, updates
precision accounting, flushes/spools an outbox, or rewrites native history.

```bash
rcl evidence recover-finding --target "$TARGET" --run "$RUN_ID" \
  --report-sha256 "$ORIGINAL_REPORT_SHA256" --finding-ref f002 \
  --identity "$NATIVE_IDENTITY" --for-pr example/project#42
# Inspect the preview, then repeat with --submit if authorized.
```

Run it in the checkout holding the retained `.git/rcl-converge-runs` state.
All selectors are mandatory. The command reads the server run and checks its
ID, original report digest, repository/PR, convergence target and round. The
explicit native identity must match the selected ref's exact file, category
and line span. Its latest sighting, verdict and native round-to-run binding
must belong to that same recorded round. Missing or ambiguous evidence is an
error, never a reason to reconstruct state, reset counters or rerun review.

The event includes the digest of the exact retained state bytes and the minimal
native identity/verdict assertion, not private verdict reasons. Harness must
already hold the corresponding canonical verdict on that same run and round;
the command does not create one. Harness validates the bindings, but trusts the
authenticated actor's native mapping assertion. Neither the command nor the
server claims to have retrieved or verified the original report bytes. Normal
transport scrubbing applies; if redaction or truncation would change an exact
binding, both preview and submission refuse it rather than print the raw value
or silently rebind the evidence.

Uses the normal Harness credential rules, requiring `reviews:read` for preview
and also `reviews:write` for submission. Requires backend support for the new
event; an older backend rejects it without changing history. Conflicts and
network errors fail visibly, without automatic retries or spooling. An
acknowledgment (exit 0) is not a convergence verdict; separately inspect
`rcl evidence status` when authorized. Originals and sibling sightings remain
unchanged, and the correction is not inherited by another run. A correction can
reopen a previously suppressed critical finding if its canonical verdict is not
critical. A `fixed` correction is audit-only for that run and does not clear
`fixes_pending`.

### `rcl evidence retriage-finding`

Record a **new explicit dismissal** for one existing finding at its actual
recorded severity. This repairs a historical grouped-severity dismissal without
replaying the report or guessing a native identity after spans have drifted.
It is not an automatic upgrade of the old verdict or a gate waiver.

```bash
rcl evidence retriage-finding --target "$TARGET" --run "$RUN_ID" \
  --report-sha256 "$ORIGINAL_REPORT_SHA256" --finding-ref f002 \
  --for-pr example/project#42 --reason-file ./retriage-reason.txt
# Inspect the preview and source-backed reason; repeat with --submit if authorized.
```

All selectors and the UTF-8 reason file are required. The nonblank reason is
limited to 2000 characters; malformed UTF-8 is refused. The command reads the
run, checks its PR, head and stored report metadata, and requires one exact
finding ref with a unique `report:<run-id>:<key>` identity (RCL 3.3+). A native
convergence run must match the selected target and carry a positive round. A
standalone gate run without convergence metadata is accepted only when Harness
records it as an attested, current-head, same-repository CI review. Its PR, run,
report digest and finding ref provide the server binding; the selected target
remains the event's informational label. The required event round is `1` as a
wire-protocol value only, not a claim that the attested review participated in
native convergence. Legacy unqualified or
colliding keys are refused, because a verdict on those keys could affect an
unrelated sighting. The digest is compared with the stored artifact metadata;
the command does not retrieve or claim to verify the original report bytes.
It does not need or read native convergence state. `recover-finding` retains
its separate exact-span/native-verdict checks unchanged.

Preview performs only the run read and labels the standalone-attested transport
round when applicable. `--submit` appends one fresh, authenticated
`verdicts_recorded` event under the original report key, on the selected run,
with the reason and recorded severity. No existing report, verdict,
mapping, attempt count, model statistics or native file is rewritten. No
reviewers run, and no outbox is flushed or spooled. Scrubbing that would alter
the selected evidence or reason causes refusal before submission. The existing
Harness API and its critical-dismissal check remain unchanged.

Uses the normal Harness credential rules (`reviews:read`, plus `reviews:write`
to submit). A refusal or uncertain response fails visibly, without automatic
retry. Each submission is a fresh attributed judgment, not an idempotent replay
of an old event; inspect server evidence before retrying an uncertain write.
Exit 0 means preview succeeded or exactly one new insertion was acknowledged, **not** that the
gate converged. Independently run `rcl evidence status` for the exact PR.

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

### `rcl telemetry recover-refutations`

Recover the original verifier model and explanation from retained modern and
pre-header reports. The default command only reads files and makes authenticated
GET requests. It writes a private manifest for review; `--apply` is a separate,
explicit step. No reviewer is rerun, no triage events are invented, and retry
queues and source reports remain untouched.

```bash
# Offline discovery, also usable before the compatible Harness backend is deployed.
rcl telemetry recover-refutations --inventory-only --manifest inventory.json

# Plan against the authenticated organization. Repeated roots replace defaults.
rcl telemetry recover-refutations --root ~/Development --root /tmp --manifest recovery.json

# Inspect coverage, source hashes, every refutation and each proposed action first.
rcl telemetry recover-refutations --manifest recovery.json --apply --output outcome.json
```

The destination is the complete authenticated Harness base URL plus its
server-reported organization. Applying with a different host, URL path or
organization fails before any write. An older receiver without `meta.org_id`
cannot produce an applyable manifest; use `--inventory-only` until the compatible
backend is released. Inventory-only artifacts are never accepted for apply.
Telemetry opt-outs and the existing Harness login/CI credential rules still apply.

Default discovery covers `~/Development`, `/tmp`, `/private/tmp`, the configured
OS temporary directory and `RCL_DATA_DIR` (otherwise `~/.rcl`). It also inspects
registered Git worktrees/common directories, RCL output and outbox directories,
and explicit JSON report references in retained ledgers and task metadata,
including references beyond the initial roots. Add `--root` for other retained
cache/task locations. Only bounded candidate files are read; symlinks, changing
files, invalid UTF-8 and files larger than 25 MiB are rejected. Incomplete,
missing and inaccessible sources stay in the coverage report. Re-inventory after
active reviews finish and record a final discovery cutoff.

Identical report bytes collapse to one SHA-256 entry with all discovered file
locations. The manifest retains positional finding refs, original identities,
normalized model/notes and source bindings. Missing original notes remain explicit.
Legacy repository ownership must be proven by a registered source worktree or a
retained ledger in that worktree; ambiguous ownership is unresolved. A directory
marked `SYNTHETIC_TEST_ONLY`, or a repeated `--exclude-sha256 <digest>`, explicitly
excludes synthetic evidence and all copies with that digest. Missing reference
paths are counted separately from missing reports; a basename match is not proof.

| Planned action | Application |
| --- | --- |
| `upload_and_recover` | Upload only the absent original artifact matching the recorded run's declaration, then select that run for server recovery. |
| `recover` | Select an existing run for the server's validated, append-only recovery operation. RCL does not patch findings. |
| `import_history` | Import missing evidence once under a deterministic historical ID; preserve original timing/target and explicit original-run/digest binding for modern reports. |
| `already_present` | Read and confirm the recorded evidence; no write. |
| `skip`, `conflict`, `unavailable` | Preserve the disposition for resolution; no write. |

Apply rechecks source bytes and server bindings. It can use a retained,
digest-verified copy if another location disappeared. It never replaces an
existing run or escalates an existing-run selection into a new historical import.
For legacy reports, the established UUID derives from lowercase host (including
port), repository and **original** report digest. Its scrubbed upload may have a
different digest, recorded in the artifact declaration. Modern originals needing
redaction are never uploaded under their original digest. When that exact
artifact is already stored in Harness, it can still supply server recovery without
another upload. Unsafe, unsupported or conflicting sources require resolution.

An apply outcome includes `server_recovery_run_ids`. An authorized operator passes
those IDs to the released, bounded Harness recovery operation documented in
[`harness_review_verification.md`](https://github.com/allocator-one/allocator-one/blob/main/docs/ops/harness_review_verification.md),
previews the selection, applies it with explicit operator/operation attribution,
and retains its results. Rerun the reviewed manifest to verify the common API
projection afterwards. Repeat application is resumable and idempotent, including
when a delivery receipt is lost; the source, queues and manifest are never deleted.
Outcome `writes` counts acknowledged creations, so a lost receipt can leave a
confirmed stored result without a creation count. The report dispositions and
readback determine completion.

Manifest/output paths must be new and are published atomically with mode `0600`.
Without `--output`, apply uses a unique outcome filename beside the manifest.
Exit `0` means a plan/inventory was written, or apply reconciled its selected
reports; `1` means apply still needs server recovery or source/conflict resolution;
`2` means the command could not validate or perform the operation. Discovery
issues and absent original notes still need explicit reconciliation even with
exit `0`. Stopping and keeping the manifest is the rollback for an interrupted
operation: do not delete historical records, rewrite original evidence, or flush
queued live reviews as a recovery shortcut.

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
# stop blocking, and so does a claim the pass could not check (verdict
# unavailable): verification promotes nothing it did not check. Report
# JSON marks every finding with gating.reason
# (consensus | critical | verified | none).
gating:
  mode: verified-consensus        # or all-findings (legacy: severity alone decides)
  minModels: 2                    # distinct models for consensus gating
  verificationModel: google/gemini-3.8-flash  # direct-API only
  verificationTimeout: 60000      # ms per refutation call (8 candidates per batch, 3 in flight)
  verificationPassTimeout: 180000 # ms for the complete verification queue

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

For converging patch reviews, async collection uses `--converge-target` (or
`RCL_CONVERGE_TARGET`), not the patch pathname. Each round can keep a distinct,
immutable capture while sharing results across linked worktrees of the same
repository and target. Other review modes retain their existing keys; previously
spooled path-keyed results are not migrated. Async findings can come from an
earlier capture and still need checking against the current code. This does not
make detached-worker completion part of the blocking round. `run.roster` records
this round's planned seats; collected async reviews retain their model and role
in `reviews` and can come from seats absent from the current roster.

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

Explicit GitHub PR fetches and review posting use a nonempty `githubToken`
configuration value first, then `GITHUB_TOKEN`, then the existing
`gh auth token --hostname github.com` login. The fallback is noninteractive
and bounded; if unavailable, public anonymous reads still work. A PR 404
explains how to check private-repository access without exposing credentials.
Local patch reviews do not read GitHub credentials.

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
