# rcl — Review Council

Multi-model AI code review in your terminal. Several models review the same
change in different roles; `rcl` merges their findings into one consensus
report and marks which findings block.

![npm](https://img.shields.io/npm/v/@allocator-one/rcl) ![license](https://img.shields.io/npm/l/@allocator-one/rcl) ![node](https://img.shields.io/node/v/@allocator-one/rcl)

- [Install](#install)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [How consensus and gating work](#how-consensus-and-gating-work)
- [Harness evidence and gate](#harness-evidence-and-gate)
- [Agent skills: `/rcl` and `/rcl-converge`](#agent-skills-rcl-and-rcl-converge)
- [Changelog](#changelog)

---

## Install

```bash
npm install -g @allocator-one/rcl
```

Requires Node.js 20 or later. The command is `rcl`.

### Migrating from `review-council`

Earlier releases were published as `review-council`. Both packages install the
same `rcl` command, and npm refuses to overwrite a command that belongs to
another package (`EEXIST`), so remove the old package first:

```bash
npm uninstall -g review-council
npm install -g @allocator-one/rcl
```

Nothing else changes. Config files keep their names (`.review-council.yml`,
`.review-council.yaml`, `.review-council.json`) and keep working, and the
per-machine state in `~/.rcl` and the convergence state under `.git/` are read
as before.

---

## Prerequisites

### Provider API keys

The default council calls three providers directly. Set their keys before your
first review:

| Seat | Default model | Key |
| --- | --- | --- |
| General and specialist reviewers (blocking lane) | `anthropic/claude-opus-5-5`, `openai/gpt-6-sol` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| Specialist reviewer (secondary lane) | `google/gemini-3.8-flash` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| Verifier for single-model findings | `openai/gpt-6-astra` | `OPENAI_API_KEY` |
| Async bonus reviewer (optional) | `openrouter/moonshotai/kimi-k3` | `OPENROUTER_API_KEY` |

A seat whose key is missing fails; failed blocking-lane seats lower the
report's reviewer health. If `OPENROUTER_API_KEY` is not set, the default async
reviewer is dropped with a warning; models you configure explicitly fail loudly
instead. Guarded convergence launches keep the default roster intact and refuse
before claiming an attempt when any roster provider's key is missing.

When the key is set, default reviews also send diff and context content to
OpenRouter, an aggregator and an additional data processor beyond the direct
model providers. Configure `models` and `asyncModels` explicitly if that
matters for your repository. An explicit `models` list (in the config or via
`--models`) also clears the default secondary and async lists unless you set
those too.

Reviewing a GitHub pull request reads it through the GitHub API. For PR
fetches and `--post`, rcl uses a nonempty `githubToken` config value, then
`GITHUB_TOKEN`, then your existing `gh auth token --hostname github.com` login.
The fallback is noninteractive and bounded; without any credential, public
repositories still work anonymously, and a PR 404 explains how to check
private-repository access without exposing credentials. Local patch and
git-mode reviews read no GitHub credentials.

### Providers and model names

Name models with a provider prefix:

| Prefix | Provider | Credentials |
| --- | --- | --- |
| `anthropic/` | Anthropic API | `ANTHROPIC_API_KEY` |
| `openai/` | OpenAI API | `OPENAI_API_KEY` |
| `google/` | Google Gemini API | `GOOGLE_API_KEY`, else `GEMINI_API_KEY` (blank values fall through) |
| `openrouter/` | [OpenRouter](https://openrouter.ai); keep the vendor segment, e.g. `openrouter/moonshotai/kimi-k3` | `OPENROUTER_API_KEY` (required; never falls back to `OPENAI_API_KEY`) |
| `openai-compat/` | Any OpenAI-compatible chat completions endpoint (Ollama, LM Studio, a self-hosted gateway) | `OPENAI_COMPAT_BASE_URL` (default `http://localhost:11434/v1`), `OPENAI_COMPAT_API_KEY` (default: the placeholder `local`) |

Unprefixed names are routed by how they start: `claude…` to Anthropic;
`gpt…`, `o1…`, `o3…` and `o4…` to OpenAI; `gemini…` to Google. **Every other
unprefixed name is routed to `openai-compat`** without a warning, which means
`http://localhost:11434/v1` unless `OPENAI_COMPAT_BASE_URL` is set. A typo such
as `opus-5-5` therefore targets a local endpoint, and with no local server that
seat fails with a connection error. Use provider prefixes.

### Keys from Harness (optional)

Repositories that carry a committed `.harness-cli/config.json` (discovered
git-style, walking up from the working directory) can get their provider keys
from a [Harness](https://harness.infra.one) backend instead of every teammate
managing them by hand: run `harness login` once, and any provider key
**missing from the environment** is fetched from `GET /api/v1/model-keys` on
the host that minted the stored login token, and injected for the run.

- Environment variables always win; only missing keys are injected.
- The stored credential is only ever sent to the host it was minted for, never
  to a URL named by the repository's own config (untrusted input in a cloned
  repository).
- If the fetch is not possible — not logged in, offline, an older backend
  without the endpoint — rcl prints a one-line note and continues with the
  environment as it is. The fetch runs under a 3-second timeout, and keys are
  never written to disk or logs.
- Which providers the backend serves is server configuration;
  `RCL_NO_HARNESS_KEYS` disables the mechanism client-side.

---

## Quick start

```bash
export ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GEMINI_API_KEY=…

# Review your staged changes before committing
rcl review --staged

# Review a GitHub pull request and keep the full report
rcl review owner/repo#42 --json-file report.json --markdown report.md

# Fail a CI job when the council reports a blocking finding
rcl review owner/repo#42 --ci
```

Without `--json-file` or `--markdown`, rcl writes no report files; the terminal
summary is the only output.

---

## Commands

| Command | Purpose |
| --- | --- |
| [`rcl review [target]`](#rcl-review-target) | Review a pull request, a patch file, or uncommitted work |
| [`rcl review-plan <file>`](#rcl-review-plan-file) | Review an implementation plan before code exists |
| [`rcl discuss <question>`](#rcl-discuss-question) | Ask the models that raised a finding a follow-up question |
| [`rcl roles`](#rcl-roles) | List and inspect reviewer roles |
| [`rcl models`](#rcl-models) | Per-model precision, volume, latency and consensus weight |
| [`rcl evidence …`, `rcl telemetry …`](#rcl-evidence-and-rcl-telemetry) | Read and deliver review evidence on Harness |
| [`rcl converge-…`](#convergence-commands) | Convergence-loop accounting and recovery |

`rcl <command> --help` lists every option.

### `rcl review [target]`

Review a PR, a local diff, or uncommitted work. Pick exactly one source:

- `owner/repo#N` or a GitHub PR URL — a pull request
- a path to a `.patch` or `.diff` file — a local patch
- `--staged` — staged changes (`git diff --cached`)
- `--working-tree` — all uncommitted changes (`git diff HEAD`, staged and
  unstaged)

Untracked files are invisible to `git diff` and therefore not reviewed.

| Flag | Description |
| --- | --- |
| `--staged` / `--working-tree` | Review uncommitted changes instead of a target |
| `--role <name>` | Use a single named role |
| `--roles <names>` | Comma-separated list of roles (`all` runs every role) |
| `--reviewer <model:role>` | Explicit model:role pair (repeatable); runs exactly these pairs, with no async seats |
| `--models <models>` | Comma-separated primary (blocking) models; clears the default secondary and async lists unless those flags are also given |
| `--secondary-models <models>` | Comma-separated secondary models, used for specialist roles only |
| `--async-models <models>` | Comma-separated async bonus reviewers, fired with the round and never awaited |
| `--context <path>` | Context file or directory (repeatable) |
| `--spec <path>` | Specification file; enables the `spec-compliance` role |
| `--spec-source <source>` | Where `--spec` came from: `flag`, `repo_file`, or `harness_issue:<ID>` (recorded in the report) |
| `--post` | Post the review to the pull request; findings that map onto the diff become inline comments |
| `--json` | Print the JSON report to stdout |
| `--json-file <path>` | Write the JSON report to a file |
| `--markdown <path>` | Write the Markdown report to a file |
| `--ci` | Exit 1 when the review is a CI failure (see [`--ci`](#--ci)) |
| `--head-sha <sha>` / `--base-sha <sha>` | Exact head/base commit a patch file was taken from (patch files only) |
| `--expect-head-sha <sha>` | Fail fast unless the resolved head commit equals this SHA |
| `--expect-pr-head-sha <sha>` / `--pending-preview-sha256 <digest>` | Cycle finalize-only recovery: bind the live PR's current head separately from the historical `--head-sha`, then require apply to present the exact digest returned by preview |
| `--for-pr <owner/repo#N>` | Bind a patch-file review to the pull request it was taken from (needs `--head-sha`) |
| `--no-telemetry` | Do not deliver this review as evidence to Harness |
| `--evidence-required` | Exit 4 unless Harness acknowledged the evidence |
| `--attest` | GitHub Actions gate workflow only: record the review as attested (see [The gate workflow](#the-gate-workflow)) |
| `--config <path>` | Path to a config file |

`--role`, `--roles`, and `--reviewer` are mutually exclusive.

`--focus <areas>` is accepted by `rcl review` but has no effect: it is not
passed to reviewers. (`rcl review-plan --focus` does work.)

**Convergence and recovery flags.** These serve the convergence loop and its
recovery operations, documented in
[Convergence and recovery](https://github.com/allocator-one/rcl/blob/main/docs/convergence.md):

| Flag | Purpose |
| --- | --- |
| `--guarded-converge` | Validate and claim one attempt inside this process; recovered-v3 can instead consume the exact `converge-attempt` claim named by `--attempt` |
| `--converge-target <key>` | Convergence target this round belongs to (or `RCL_CONVERGE_TARGET`) |
| `--round <n>` / `--attempt <n>` | Converge context recorded in the report (or `RCL_CONVERGE_ROUND` / `RCL_CONVERGE_ATTEMPT`); guarded launches derive these except the explicit recovered-v3 handoff |
| `--start-over` | Start an explicitly requested fresh review cycle with a new normal budget; preserves prior spending and evidence |
| `--max-attempts <n>` / `--max-rounds <n>` | Guarded launch only: explicitly authorized caps; omission preserves native caps |
| `--retry-reason <reason>` | Explicit bounded recovery decision for a failed, unknown or inconclusive launch; preserves spent attempts |
| `--retry-report <path>` | Bind an original legacy (4.1.10–4.1.12) report to an inconclusive retry; requires `--retry-reason` |
| `--launch-intent <intent>` | `review` (default), `stop-upstream`, `stop-review`, or `retry-delivery` |
| `--bound-fix-recovery <run-id>` | Allow one more review of unchanged inputs after verifying a native dismissal-only run against live Harness evidence |
| `--export-pending-package <path>` | Export the authenticated inputs of a pending launch whose coordinator died to an exclusive private file, without provider calls or native writes |
| `--expect-base-sha <sha>` | With `--export-pending-package` only: require the resolved current base to equal this SHA |
| `--preview-pending` | Authenticate a pending recovery or preview a package export without writes or provider calls |
| `--ordinary-pending-package <path>` | Immutable pending-launch package for `--resume-pending` or `--finalize-pending-only`; cycle packages are finalize-only |
| `--resume-pending` / `--resume-async-sha256 <hashes>` | Finalize a dead pending launch and claim one checkpointed retry, retaining the exact async results; cycle recovery accepts `none` for no completed async artifacts |
| `--finalize-pending-only` / `--pending-native-sha256 <digest>` / `--pending-attempt-sha256 <digest>` | Finalize the previewed pending attempt as failed/unknown without claiming a successor; cycle recovery after PR movement also requires `--for-pr`, `--expect-pr-head-sha`, and the returned `--pending-preview-sha256` |

**Reports.** Every report carries a `run` header: a client run id (UUIDv7),
the rcl version, the target with its exact `head_sha`/`base_sha` (from GitHub
for PRs, from `git rev-parse HEAD` and the merge-base with the remote default
branch for `--staged`/`--working-tree`, from `--head-sha`/`--base-sha` for
patch files) and a `diff_sha256`, the roster with each seat's lane
(`blocking`, `secondary`, `async`, `verification`), a config digest with
thresholds and gating inline, spec and context-file digests, a best-effort
`runner` claim (`agent` / `ci` / `human`), timing, the CI verdict (computed
even without `--ci`), and the converge context when run in a convergence loop.
Every finding carries an `identity`, allocated uniquely across the report's
consensus findings, including the below-threshold appendix. Keys use
`report:<run-id>:<16-hex-key>` so report allocation cannot alias unrelated
native ledger identities or reuse another run's classification. Colliding
location anchors are disambiguated before thresholding; native cross-round
location matching still determines the unchanged canonical ledger identity.
Every reviewer call records token `usage` where the provider reports it.
Reports without a `run` header (before 3.0) remain readable; ambiguous
classifications are refused by `rcl converge-report`.

Before dispatch, rcl prints the expanded reviewer × chunk call count,
concurrency, wave count, timeout, and timeout-bound queue estimate. Interactive
runs update the spinner; redirected runs emit periodic heartbeat and bounded
completion lines, so a long queue is distinguishable from a hung process.

#### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | The review completed (or there was nothing to review); with `--ci`, nothing failed the gate; with `--evidence-required`, Harness acknowledged the evidence |
| 1 | An error (invalid flags or target, refused launch, configuration or provider setup failure), a `--ci` gate failure, or a requested report file that could not be written |
| 2 | Guarded convergence only: the attempt or round cap is exhausted; continuing needs an explicitly approved higher cap |
| 3 | Guarded convergence only: native attempt or round state could not be read or written |
| 4 | `--evidence-required` (implied by `--attest`): the review completed but Harness did not acknowledge the evidence |

When `--ci` fails and evidence delivery also failed, the exit code is 1 and the
evidence failure is printed beside the gate verdict. A run that starts or
continues a fresh review cycle (`--start-over`, or a later ordinary review of
that pull request from the same repository) is a guarded convergence launch
with evidence required.

#### `--ci`

`--ci` exits 1 when no reviewer succeeded (an empty finding list then means
"nobody looked", not "clean") or when the report contains at least one
**gating** finding. In the default `verified-consensus` gating mode, a
critical or important finding gates when at least two distinct models raised it
(`gating.minModels`), when it is critical, or when the verifier confirmed it
with source evidence; its `gating.reason` is then `consensus`, `critical` or
`verified`. A refuted or unverifiable single-model claim (`gating.reason:
none`) is reported but does not fail CI. In `all-findings` mode every critical
or important finding fails CI. Findings in the below-threshold appendix never
count. See [How consensus and gating work](#how-consensus-and-gating-work).

Examples:

```bash
# Explicit model:role pairs
rcl review owner/repo#7 \
  --reviewer anthropic/claude-opus-5-5:security-auditor \
  --reviewer openai/gpt-6-sol:bug-hunter

# Spec compliance review with context
rcl review ./feature.patch --role spec-compliance --spec SPEC.md --context src/

# JSON for downstream processing
rcl review owner/repo#99 --json > findings.json

# Review uncommitted work with two roles
rcl review --working-tree --roles security-auditor,bug-hunter
```

### `rcl review-plan <file>`

Council-review an implementation plan document (PRD, build plan, design doc)
before any code exists.

```bash
rcl review-plan docs/plan.md
rcl review-plan docs/plan.md --focus risks       # feasibility | completeness | risks | timeline
rcl review-plan docs/plan.md --spec PRD.md       # also check the plan against a spec
```

The plan flows through the normal pipeline — multi-model dispatch, dedup,
consensus, agreement-tier report — with plan-adapted prompts. Finding line
numbers refer to the plan document's own lines. Categories are reinterpreted
for plans (`correctness` = infeasible or contradictory steps, `tests` = missing
validation strategy, `best-practices` = process gaps like rollback or
migration, …).

Default roles are a plan-suited subset (`general`, `architecture`,
`edge-case-hunter`, plus `spec-compliance` when a spec is given);
`--role`/`--roles`/`--reviewer` and config `roles` override as usual. It shares
the model, context, output, telemetry and config flags of `rcl review`. `--post`
and `--ci` are not offered: there is no PR to post to, and plan findings are
judgment calls, not gates.

### `rcl discuss <question>`

Ask the models that flagged a finding a follow-up question — one round,
reconstructed from a saved report. Useful when triaging, especially for
**disputed** findings, where the report shows each model's position.

```bash
rcl review --staged --json-file report.json
rcl discuss --report report.json --finding f003 "Is this exploitable given the sanitizer at line 40?"

# Attach code as context, or ask different models
rcl discuss --report report.json --finding f003 --context src/auth.ts "Does the middleware at line 12 not already cover this?"
rcl discuss --report report.json --finding f003 --models anthropic/claude-opus-5-5 "Summarize the strongest counterargument."
```

Model-generated finding ids can collide; when `--finding <id>` is ambiguous the
error lists `<id>:<n>` disambiguators. Findings in the below-threshold appendix
are addressable too. Answers come back in parallel, respecting the configured
`timeout`, `maxRetries`, and `reasoningEffort`. There is no session state: each
`discuss` is one independent round built from the report file.

### `rcl roles`

```bash
rcl roles list             # all built-in roles
rcl roles show <name>      # system prompt and details for a role
```

| Role | Focus |
| --- | --- |
| `general` | Comprehensive review covering all dimensions |
| `security-auditor` | Auth, injection, XSS, CSRF, IDOR, and sensitive data exposure |
| `performance-engineer` | N+1 queries, caching, algorithmic complexity, and memory efficiency |
| `api-design` | API contracts, breaking changes, REST/gRPC conventions |
| `test-coverage` | Missing tests, edge cases, flawed test logic |
| `dx-critic` | Readability, naming, documentation, and developer ergonomics |
| `architecture` | Module boundaries, coupling, and architectural patterns |
| `bug-hunter` | Logic errors, null paths, race conditions, off-by-one |
| `accessibility-auditor` | WCAG compliance, ARIA roles, keyboard navigation |
| `spec-compliance` | Checks the implementation against a spec or plan file |
| `regression-hunter` | Changed defaults, weakened guards, and lost behavior |
| `dependency-hygiene` | Unnecessary dependencies, external requests, and privacy leaks |
| `edge-case-hunter` | Boundary values, unusual inputs, and failure paths |

By default every role runs except `spec-compliance`, which runs only when a
spec is supplied. `general` runs on each primary model; specialist roles are
spread round-robin across primary and secondary models. The default council
therefore schedules 13 reviewer seats, or 14 when a spec enables
`spec-compliance`. Seats on the primary models (Opus 5.5 and Sol) form the
blocking lane that reviewer health and quorum count; Gemini receives specialist
seats only, in the secondary lane, whose results keep their findings but do not
count toward quorum. The async reviewer and the verifier are separate lanes.

The first repository rules file found in the working directory — `AGENTS.md`,
`CLAUDE.md`, `CONTRIBUTING.md`, `.github/CONTRIBUTING.md`, `DEVELOPMENT.md` or
`docs/CONTRIBUTING.md`, in that order — is supplied to every reviewer as shared
context.
`project-rules` and `dead-code` are no longer built-in roles; remove them from
explicit role lists (unknown roles are skipped with a warning) unless you define
a custom role with that name.

### `rcl models`

The tool's own memory of which reviewers earn their seat. Every reviewer call
and every `converge-verdict` outcome accrues in a cross-run store at `~/.rcl`
(`RCL_DATA_DIR` overrides). `rcl models` prints, per model over a trailing
90-day window: triage precision (the share of its supported findings the
convergence loop verified and fixed rather than dismissed), triage volume, call
volume, dead-call rate, p50 latency — and the consensus **weight** the model
earns: `0.5 + precision`, clamped to [0.5, 1.5], neutral (1) below 20 triaged
outcomes. Weights scale each model's consensus vote in report confidence and in
consensus gating, so persistently noisy models lose gating power
automatically; the applied weights are visible per finding
(`consensus.weightedScore` / `consensus.modelWeights`) and per run
(`stats.modelWeights`) in the report JSON.

With Harness evidence configured, the table merges the organization's window
from Harness (`GET /api/v1/reviews/model-stats`, computed over every run the
organization recorded) with this machine's store: for a model the server holds
at least 20 outcomes for, the server's weight is used (`source: server`); below
that the local store decides (`local`); a model neither knows enough about
keeps the neutral weight (`neutral`). Reviews weight consensus the same way,
asking the server with a three-second bound and falling back to the local store
when it cannot answer.

```bash
rcl models                          # org-wide where Harness has enough history, local otherwise
rcl models show --window 30 --json  # `server` (host, window, rows) and `weights` with their `source`
rcl models show --local             # this machine's store only
rcl models seed --from ~/recovered-rcl-artifacts   # backfill the local store from reports and converge ledgers
```

### `rcl evidence` and `rcl telemetry`

These commands read and deliver review evidence on Harness. Details, exit codes
and the recovery runbooks are in
[Telemetry and evidence](https://github.com/allocator-one/rcl/blob/main/docs/telemetry-and-evidence.md).

| Command | Purpose |
| --- | --- |
| `rcl evidence status <pr> [--enforced]` | Gate status Harness computed for a pull request; exit 0 only when the judged projection is `converged` |
| `rcl evidence show <run-id>` | One recorded run: header, reviewer health, artifacts, findings with identity, gating reason and verdict |
| `rcl evidence recover-run` | Preview, apply or resume delivery of one original asserted run |
| `rcl evidence recover-claim` | Preview, apply, resume, adopt or refresh one selected semantic claim on its existing native target |
| `rcl evidence recover-finding` | Preview or submit a correction of one recorded finding identity |
| `rcl evidence retriage-finding` | Preview or submit a fresh dismissal of one finding at its recorded severity |
| `rcl telemetry status` | Telemetry level, credential source and spooled deliveries |
| `rcl telemetry flush [--run <id>]` | Deliver spooled evidence |
| `rcl telemetry rejected` | Inspect retained rejected evidence without delivering it |
| `rcl telemetry recover-reviewer --target <t> --run <id>` | Redeliver one exact retained terminal reviewer report without restarting reviewers or verification |
| `rcl telemetry backfill` | Post recovered pre-3.0 reports and ledgers as backfill evidence |
| `rcl telemetry recover-refutations` | Discover original verifier explanations and write a reviewed recovery manifest |

### Convergence commands

Convergence-loop state lives under the repository's common Git directory. The
commands are documented in
[Convergence and recovery](https://github.com/allocator-one/rcl/blob/main/docs/convergence.md).

| Command | Purpose |
| --- | --- |
| `rcl converge-report` | Dedupe a round report against earlier rounds, enforce the round cap, classify findings (`new` / `repeat` / `suppressed` / `regating`); refuses inconclusive reviewer health |
| `rcl converge-verdict` | Record fixed/dismissed verdicts and report the round's resolution |
| `rcl converge-reconcile-history` | Authenticate and append a reconciliation receipt for an exact historical guarded launch after `lastLaunch` advanced |
| `rcl converge-stale` | Audited disposition of a healthy or reconciled delivered-hard-failure report that became stale before admission |
| `rcl converge-gap` | Audited record of one evidenced missing terminal report |
| `rcl converge-rejected` | Audited disposition of a report rejected locally before delivery |
| `rcl converge-attempt` | Claim one durable attempt; recovered-v3 continuation hands the exact claim to its guarded producer with `--attempt` |

Delivered hard-failure continuation requires RCL 4.5.3 or later. Re-run
`rcl telemetry flush --run <run-id>` to authenticate or upgrade the durable
reconciliation marker before previewing `converge-stale`. The strong marker is
bound to the exact run, report, head, input digest, attempt, round, claim PID,
cycle, reconciliation time and live repository/pull-request authority. New
stale dispositions are version 3; published 4.5.2 version 2 receipts remain
verifiable and can be
followed by a changed-input version 3 disposition only after that exact marker
upgrade.

If a published version 1 marker belongs to a retained version 2 stale receipt
but a later launch has already replaced `lastLaunch`, use
`converge-reconcile-history`. Preview prints one reviewed manifest to stdout and
its SHA-256 to stderr. Apply accepts only those pinned bytes, re-reads every
local source and the complete live server projection under the target lock,
and appends a historical audit receipt. It never admits findings, claims an
attempt or calls a reviewer.

---

## Configuration

Place `.review-council.yml` (or `.review-council.yaml` / `.review-council.json`)
in the directory you run `rcl` from. rcl looks only in the current working
directory, not in parent directories; use `--config <path>` for a file
elsewhere. Executable JavaScript config is never discovered: rcl often runs in
untrusted checkouts with provider keys in the environment. All fields are
optional, and a config file that fails validation stops the review instead of
falling back to defaults.

```yaml
# Blocking council (provider-prefixed names); every round waits for these.
# Shown here: the defaults. Keep slow or aggregator-routed models out of this
# list; give them an async seat instead.
models:
  - anthropic/claude-opus-5-5
  - openai/gpt-6-sol

# Specialist assignments only; no additional general reviewer.
secondaryModels:
  - google/gemini-3.8-flash

# Async bonus reviewers, fired with each round and never awaited. Results that
# have arrived by the next round of the same target are merged into that
# round's dedup and marked `async` in the report JSON.
asyncModels:
  - openrouter/moonshotai/kimi-k3

# Roles to run (default: all built-in and custom roles; spec-compliance only with a spec)
roles:
  - general
  - security-auditor
  - bug-hunter

# Custom roles: a new role, or an override of a built-in with the same name
customRoles:
  - name: my-style-guide
    focus: [best-practices]       # categories this role specializes in
    severityBias:
      best-practices: 1.2         # >1: lean more severe; <1: lean less severe
    systemPrompt: |
      Enforce our team style guide. Flag any deviation from snake_case
      variable names and require docstrings on all public functions.

# Consensus and deduplication thresholds
thresholds:
  minConsensusScore: 0.4   # 0–1; findings below this are demoted to the appendix
  minConfidence: 0.2
  dedupeLineWindow: 5      # lines within which findings are merged
  jaccardThreshold: 0.3    # weighted title+description similarity threshold for dedup

# Which findings block convergence and CI
gating:
  mode: verified-consensus        # or all-findings (severity alone decides)
  minModels: 2                    # distinct models for consensus gating
  verificationModel: openai/gpt-6-astra  # direct-API models only
  verificationReasoningEffort: high      # OpenAI verifier only; separate from reviewer effort
  verificationPassTimeout: 600000        # ms for the complete verification queue

output:
  belowThresholdAppendix: true  # false drops below-threshold findings outright

# Concurrency and reliability
concurrency: 9        # maximum simultaneous blocking reviewer calls per process
providerConcurrency:  # provider admission caps, applied in addition to concurrency
  anthropic: 2        # default
timeout: 540000       # ms per blocking model call
asyncTimeout: 900000  # ms per async-lane call
# quorumFraction: 0.75  # see below; default exactly 2/3
maxRetries: 3

# Reasoning effort for OpenRouter reviewers: low | medium | high (default low)
reasoningEffort: low

# Context files attached to every review, and the spec for spec-compliance
context:
  - ARCHITECTURE.md
  - docs/api.md
spec: SPEC.md

# Harness evidence delivery
harness:
  telemetry: full        # off | envelope | findings | full (default)
  parseFailures: false   # send a parse-failed call's raw answer (scrubbed, 32 KB cap)

# GitHub token (prefer the GITHUB_TOKEN environment variable)
# githubToken: ghp_...
```

**Accepted but ignored.** These keys pass validation but have no effect, so
older config files keep loading: `reviewers` (use `--reviewer` for explicit
model:role pairs; the key is read only when reconstructing a legacy 4.1.x
retry roster), top-level `focus`, and `output.terminal`, `output.json`,
`output.jsonPath`, `output.markdown`, `output.markdownPath` and
`output.github`. rcl writes report files only when `--json-file` or
`--markdown` is given. `output.belowThresholdAppendix` is the only `output`
key in use.

**Custom roles.** A custom role whose name matches a built-in (case-insensitive)
overrides it and inherits the fields you omit; any other name creates a new
specialist role. `focus` lists the categories the role specializes in
(`security`, `correctness`, `best-practices`, `tests`, `api-design`); it feeds
the role-relevance part of the consensus score and defaults to
`[best-practices]` for new roles. `severityBias` maps a category to a factor:
above 1 tells the reviewer to pick the more severe of two adjacent severity
levels for that category, below 1 the less severe one, and 1 has no effect.
The bias becomes calibration guidance in the reviewer's prompt; consensus
scoring itself is bias-free. Built-in examples: `security-auditor` uses
`{ security: 1.2 }`, `bug-hunter` uses `{ correctness: 1.3 }`.

**Quorum.** `quorumFraction` closes a round once that share of blocking seats
has succeeded on every chunk; stragglers, including core models, can be
canceled. Secondary successes never count, and secondary calls still running at
closure are canceled. It also raises the report's blocking-health requirement.
The default is exactly 2/3 (leave it unset for that); the minimum is 2/3, and
1 disables early closure and waits for every call.

**Concurrency.** `concurrency` limits all blocking reviewer calls within one
rcl process. `providerConcurrency` adds stricter per-provider admission caps;
raising the global limit never bypasses them. The scheduler scans past a
saturated provider so calls for other providers continue without changing the
original result order. Anthropic defaults to two concurrent calls; providers
with no default or explicit entry use only the global limit. Separate rcl
processes do not share these limits; async reviewers and verification use their
own scheduling.

**Retries.** `maxRetries` limits additional adapter SDK invocations after the
first attempt; all attempts share the call's `timeout` and parent cancellation
signal. Supported transient connection failures and HTTP status errors may
retry; cancellation, expired deadlines, permanent TLS/configuration errors and
unusable output do not. Report reviews and `discuss` answers expose
`adapterAttempts` when observed; chunked reviews sum it only when every part
has a known count. It is neither a wire-request count nor a billing total:
lower-level activity and charges after ambiguous transport failures can be
unknown, and token usage is what the SDK response exposes, not proof of total
charges across retries.

**Reasoning effort.** The top-level `reasoningEffort` applies only to OpenRouter
reviewers (default `low`, a supported level for the default Kimi K3, which
advertises `low`, `high` and `max` — avoid `medium` for it). Check the
selected model's supported levels before overriding: unbounded reasoning makes
these models spend the whole completion budget thinking before they answer.
Direct Sol and Gemini reviewers use their provider defaults. Opus 5.5 reviews
explicitly use `high` effort, streaming, and a 65,536-token output ceiling so
thinking and findings share adequate headroom. Opus 5.5's API default is
`medium`; rcl sets `high` because a review gate is intelligence-sensitive work
([Anthropic's effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort)).
The same profile applies when Fable 5.1 is configured explicitly. Effort labels
are provider-specific and do not imply equal compute or quality across models.

**Verifier.** The verifier uses three verdicts: `confirmed`, `refuted`, and
`insufficient_evidence`. Confirmation requires a reachable failure mechanism
and exact code excerpts from the supplied change; citations are checked against
that source before a claim can be promoted to `verified`. Missing context or
inability to refute a claim is not confirmation. This checks citation
provenance, not semantic truth: the verifier still has to reason correctly.
Infrastructure failures are recorded as `unavailable`, and an unavailable
verdict never promotes a finding. Historical `unrefuted` verdicts retain their
original meaning. The default
verifier `openai/gpt-6-astra` is used only when OpenAI is already in the
roster; otherwise rcl picks the first direct-API roster model, so the default
never sends the diff to a provider you configured away from. OpenRouter models
cannot verify. Astra defaults to `high` effort;
`gating.verificationReasoningEffort` accepts `low`, `medium`, `high`, `xhigh`
or `max` for an OpenAI verifier only (other verifiers keep their provider
defaults and reject the setting), and is recorded in the report header and
retained verification plan. The whole verification pass has a 10-minute
default deadline (`gating.verificationPassTimeout`) across all queued verifier
batches; verifier calls default to the remaining pass budget, and the optional
`gating.verificationTimeout` (milliseconds) imposes a shorter per-call limit,
still capped by the remaining pass deadline.

---

## Environment variables

| Variable | Description |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic models |
| `OPENAI_API_KEY` | OpenAI models and the default verifier |
| `GOOGLE_API_KEY` | Google Gemini; empty or whitespace-only values fall through |
| `GEMINI_API_KEY` | Google Gemini when `GOOGLE_API_KEY` is absent or blank; also used for Harness-injected keys |
| `OPENROUTER_API_KEY` | `openrouter/…` models |
| `OPENAI_COMPAT_BASE_URL` | Base URL for `openai-compat` models and unrecognized unprefixed names (default `http://localhost:11434/v1`) |
| `OPENAI_COMPAT_API_KEY` | API key for that endpoint (default: the placeholder `local`) |
| `GITHUB_TOKEN` | GitHub token for PR fetch and `--post` |
| `XDG_CONFIG_HOME` | Where the `harness login` credential is read from (`$XDG_CONFIG_HOME/harness/credentials.json`; default `~/.config/harness/credentials.json`) |
| `RCL_DATA_DIR` | Per-machine state directory (model stats, evidence outbox and quarantine); default `~/.rcl` |
| `RCL_TELEMETRY` | `off` keeps every review on the machine |
| `RCL_NO_HARNESS_KEYS` | Any value disables provider-key distribution via Harness |
| `RCL_FOR_PR` | Same as `--for-pr`, for patch-file reviews |
| `RCL_CONVERGE_TARGET` / `RCL_CONVERGE_ROUND` / `RCL_CONVERGE_ATTEMPT` | Same as `--converge-target` / `--round` / `--attempt` |
| `RCL_DEBUG` | Any value prints full error stack traces |
| `HARNESS_API_TOKEN` | CI credential for evidence delivery; requires `HARNESS_API_URL` and never pairs with the stored login host |
| `HARNESS_API_URL` | The Harness host `HARNESS_API_TOKEN` was minted by; under `--attest`, the host attested to (no token needed) |
| `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | Set by the GitHub Actions runner for jobs with `id-token: write`; `--attest` requires them |

---

## How consensus and gating work

When multiple models and roles review the same diff, their findings are:

1. **Deduplicated** — findings on the same file and overlapping line range are
   grouped by weighted title+description token similarity; findings in
   different categories can still merge, but need stronger similarity. Findings
   whose line ranges strictly overlap and that name the same issue concept (SQL
   injection, IDOR, hardcoded secret, …) merge regardless of wording. Repeats
   within a single review are collapsed first. Findings that clearly reach
   opposite conclusions are kept as separate, disputed findings; subtler
   contradictions merge but are flagged as disputed.
2. **Scored** — each group receives a consensus score from three dimensions:
   reviewer diversity (how many distinct models and roles flagged it, saturating
   at half the fleet), role relevance (whether a role specialized in that
   finding type confirmed it), and isolation (what fraction of relevant
   reviewers flagged it).
3. **Classified** — groups get a confidence band (Very High → Minimal) and a
   final severity. Severity is the most common rating across reviewers; when
   reviewers disagree, high-confidence agreement elevates it, but only to a
   severity at least two reviewers independently assigned — a lone outlier
   rating is surfaced as a dispute instead. Each group also gets an
   **agreement tier** measured over distinct models — `unanimous` (every
   successful model), `majority` (at least half), `minority` (2+, under half),
   `single` (one model) — because roles share a model's blind spots.
4. **Filtered** — groups below `minConsensusScore` or `minConfidence` are
   demoted (blocking severities are never dropped). Demoted findings land in a
   collapsed "worth checking" appendix at the bottom of the report and in the
   JSON `belowThresholdFindings` field — never in severity totals or CI gating.
   Set `output.belowThresholdAppendix: false` to drop them outright.

The report is organized by agreement tier — unanimous first, then majority,
minority, **disputed** (rendered as per-model positions so you can judge), and
single-model last. Within each tier, findings sort by severity. The tiers tell
you which findings are independently confirmed and where to spend your own
judgment.

**Gating** decides which findings block convergence and CI. In the default
`verified-consensus` mode only critical and important findings can gate, and
each gets a `gating.reason`:

| `gating.reason` | When |
| --- | --- |
| `consensus` | Raised by at least `gating.minModels` (default 2) distinct models; model weights can demote consensus but never replace distinct models |
| `critical` | Critical severity |
| `verified` | A single-model important finding the verifier confirmed with source evidence |
| `none` | Everything else, including refuted, insufficient-evidence and unverified (`unavailable`) claims; still reported, never blocking |

`gating.mode: all-findings` restores the legacy rule where every critical or
important finding gates. For the full scoring algorithm, see
[CONSENSUS_V2_SPEC.md](https://github.com/allocator-one/rcl/blob/main/CONSENSUS_V2_SPEC.md).

---

## Harness evidence and gate

In a repository that carries `.harness-cli/config.json`, with a
`harness login` (or `HARNESS_API_TOKEN` + `HARNESS_API_URL` in CI), every
review is recorded on [Harness](https://harness.infra.one) after the report is
written: the run header, findings, reviewer calls, stats and — at the default
`full` level — both report files, scrubbed for key-shaped strings. Provider
keys, tokens, environment variables and prompts are never sent, and raw model
answers only when `harness.parseFailures: true` opts in for parse-failed calls.
The review never blocks on the
network: an outage spools the evidence to `~/.rcl/outbox/` for
`rcl telemetry flush`. One status line reports the outcome, and
`--evidence-required` turns a missing acknowledgment into exit 4. Opt out with
`--no-telemetry`, `RCL_TELEMETRY=off` or `harness.telemetry: off`.

Harness computes two projections per pull request head from that evidence:

- **advisory** — counts rounds recorded with any credential, such as a
  developer's `harness login` or a CI token;
- **enforced** — counts only **attested** rounds, recorded by the
  organization's gate workflow; attested rounds also drive the
  `Review Council` check run.

A round counts only when it names the pull request, comes from the same
repository and reviewed the pull request's current head.

`rcl evidence status owner/repo#N` prints both and exits 0 only when the judged
projection (advisory, or enforced with `--enforced`) is `converged`.

- [Telemetry and evidence](https://github.com/allocator-one/rcl/blob/main/docs/telemetry-and-evidence.md)
  — delivery, attestation, evidence reads and the evidence recovery commands
- [Convergence and recovery](https://github.com/allocator-one/rcl/blob/main/docs/convergence.md)
  — the convergence loop, budgets, reviewer health and recovery operations
- [Review evidence recovery](https://github.com/allocator-one/rcl/blob/main/docs/review-evidence-recovery.md)
  — operator runbook for the gate's encrypted evidence artifact

### The gate workflow

Once a pull request head's advisory status has converged, Harness dispatches
the organization's gate workflow for that head. Inside the job,
`rcl review owner/repo#N --attest` exchanges the job's OIDC token for a
run-bound Harness credential, so the round it records is attested. Harness
accepts it only if the workflow file is on the organization's gate allow-list
at its default branch, the reviewed head is the pull request's current head,
and the pull request is not from a fork. `--attest` never falls back to another
credential and implies `--evidence-required`.

The workflow contract, as in this repository's
[`review_gate.yml`](https://github.com/allocator-one/rcl/blob/main/.github/workflows/review_gate.yml):

- `workflow_dispatch` inputs `pr_number` and `head_sha` (required) and
  `attempt_id` (optional: the Harness dispatch attempt UUID, omitted only for
  an unregistered manual run);
- a `# harness-review-lifecycle: 1` comment, which promises the optional
  `attempt_id` input and the exact run-name
  `Review Council gate · ${{ inputs.attempt_id || 'unregistered' }}`;
- `id-token: write` for the review job, no provider secrets, and the pull
  request never checked out;
- the latest release installed by the verified installer, which checks the
  package against the registry's SHA-512 integrity before installing.

Abridged:

```yaml
# harness-review-lifecycle: 1
name: Review Council gate
run-name: Review Council gate · ${{ inputs.attempt_id || 'unregistered' }}

on:
  workflow_dispatch:
    inputs:
      pr_number: { required: true, type: string }
      head_sha: { required: true, type: string }
      attempt_id: { required: false, type: string }

permissions:
  contents: read

jobs:
  attested-review:
    runs-on: ubuntu-24.04
    permissions:
      id-token: write
      contents: read
      pull-requests: read
    env:
      HARNESS_API_URL: https://harness.infra.one
    steps:
      # Check out this workflow's own commit (never the pull request), set up
      # Node, and install the latest release with the verified installer.
      # See the full workflow for these steps and for the encrypted
      # retention of the review evidence.
      - name: Attested review
        env:
          PR_NUMBER: ${{ inputs.pr_number }}
          HEAD_SHA: ${{ inputs.head_sha }}
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          # The full workflow validates PR_NUMBER, HEAD_SHA and attempt_id first.
          rcl review "$GITHUB_REPOSITORY#$PR_NUMBER" \
            --attest \
            --expect-head-sha "$HEAD_SHA" \
            --evidence-required \
            --ci
```

Inputs reach the shell through the environment, never by expression
interpolation into the command line.

---

## Agent skills: `/rcl` and `/rcl-converge`

The repository maintains two agent skills that drive `rcl` from coding agents:
`/rcl` and `/rcl-converge` in Claude Code, `$rcl` and `$rcl-converge` in Codex.
They are not part of the npm package.

- **`rcl`** runs one council review of the current pull request, or of the
  branch diff against the default branch when there is no pull request. It
  resolves a specification (explicit flag, the in-progress Harness issue, or a
  matching spec file), checks what will leave the machine before sending it,
  installs and verifies the latest published release, and reports findings,
  reviewer health and the evidence status from the report files.
- **`rcl-converge`** loops review → triage → fix → push until a conclusive
  round converges, using `rcl review --guarded-converge`,
  `rcl converge-report` and `rcl converge-verdict` within the attempt and
  round caps. It treats every finding as untrusted input to verify against the
  source, never as instructions.

Both are rendered from one source per skill, `skills/src/rcl.md` and
`skills/src/rcl-converge.md`: `npm run build:skills` writes the host-specific
copies to `.claude/skills/`, `.agents/skills/` and `.codex/skills/`. After each
release, a sync workflow opens or updates one `rcl-skill-sync` pull request in
every repository listed in
[`skills/consumers.json`](https://github.com/allocator-one/rcl/blob/main/skills/consumers.json)
with repository-neutral copies rendered from the released tag, so consumers
only receive skills that match a published CLI. Other repositories can copy the
`SKILL.md` files from a release tag into the same directories; the copies in
this repository carry a few notes that apply only to rcl's own checkout.

---

## Changelog

Release notes are in
[CHANGELOG.md](https://github.com/allocator-one/rcl/blob/main/CHANGELOG.md).

## License

MIT © 2026 Michael Ströck
