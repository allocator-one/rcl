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
| `--config <path>` | Path to a config file |

`--role`, `--roles`, and `--reviewer` are mutually exclusive. So are a positional target, `--staged`, and `--working-tree` — pick exactly one review source. Untracked files are invisible to `git diff` and therefore not reviewed.

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
New targets default to seven attempts, but an explicit invocation can set any
positive cap with `--max-attempts`. Omitting the flag on resume preserves the
persisted cap. At the boundary, RCL refuses before provider calls and directs
the workflow to ask the user; an approved continuation explicitly supplies a
higher cap.

At the skill level, `--max-attempts N` controls this machine launch budget.
The pre-existing `--max-rounds N` flag retains its original meaning as a
separate evidence-round limit (1–7), so existing invocations do not silently
change behavior.

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

## Config File

Place `.review-council.yml` in your project root (or any parent directory). All fields are optional.

```yaml
# Blocking council (provider-prefixed names) — every round waits for these.
# Shown here: the actual defaults. Keep slow/aggregator-routed models out of
# this list; give them an async seat instead.
models:
  - anthropic/claude-fable-5
  - openai/gpt-5.6-sol
  - google/gemini-3.6-flash

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

# Output defaults
output:
  markdown: true
  markdownPath: review-report.md
  belowThresholdAppendix: true  # false drops below-threshold findings outright

# Concurrency and reliability
concurrency: 6
timeout: 300000       # ms per blocking model call (every direct-API p90 is under 260s)
asyncTimeout: 900000  # ms per async-lane call (slow reasoning models get headroom; nothing waits on them)
quorumFraction: 0.667 # round closes once this share of calls has completed; stragglers are
                      # canceled and recorded (core `models` are never canceled). 1 disables.
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
