---
name: rcl
description: Run Review Council (multi-model AI code review) on the current PR or branch diff
argument-hint: "[--post] [--inline] [--spec <path>] [--roles <roles>] [PR#N]"
allowed-tools:
  - Bash(gh pr view:*)
  - Bash(gh auth token:*)
  - Bash(gh repo view:*)
  - Bash(rcl review:*)
  - Bash(rcl roles:*)
  - Bash(git merge-base:*)
  - Bash(git status:*)
  - Bash(git rev-parse:*)
  - Bash(rcl --version)
  - Bash(git diff:*)
  - Bash(harness show:*)
  - Bash(harness list:*)
  - Bash(npm install -g review-council@1.7.0)
  - Bash(which rcl)
  - Bash(rm -f /tmp/rcl-*)
  - Write(/tmp/rcl-spec-*.md)
  - Read
  - Glob
  - Read(/tmp/rcl-*/**)
  - Write(/tmp/rcl-*/**)
  - Bash(mkdir -p /tmp/rcl-*)
  - Bash(chmod 0700 /tmp/rcl-*)
  - Read(/tmp/rcl-report-*.md)
  - Read(/tmp/rcl-report-*.json)
---

<!-- GENERATED FILE — do not edit. Source: skills/src/rcl.md
     Edit the source, then run `npm run build:skills`. `npm test` enforces this. -->

# Review Council (rcl)

Run a multi-model AI code review on the current branch's PR. By default, keep the review in-session and do not post to GitHub unless the caller explicitly asks for `--post` or `--inline`.

## Steps

### 0. Private artifact directory

All temporary artifacts below (patches, specs, reports, logs, PID files) live under `<RCL_TMP>` = `/tmp/rcl-<uid>` (your numeric `id -u`) — never directly in world-writable `/tmp`, where another local user could pre-create, symlink, or tamper with predictable filenames. Create and verify it once per session:

```bash
RCL_TMP=/tmp/rcl-$(id -u); mkdir -p "$RCL_TMP" && [ ! -L "$RCL_TMP" ] && [ -d "$RCL_TMP" ] && [ -O "$RCL_TMP" ] && chmod 0700 "$RCL_TMP"
```

Order matters: the symlink and ownership checks run **before** `chmod`, because a `chmod` on a pre-created symlink would follow it and re-permission someone else's directory before the check could reject it. If any check fails, stop — never write artifacts to a directory you do not exclusively own. `<RCL_TMP>` below is a **textual placeholder**: substitute the resolved path (e.g. `/tmp/rcl-501`) when writing each command, rather than relying on `$RCL_TMP` surviving into a detached or single-quoted shell. Shell-quote every dynamic value that enters a generated command.

### 1. Resolve the review target

If `$ARGUMENTS` contains a standalone positional PR token — `PR#N`, `#N`, or an all-digit token — use that as the PR number and proceed to step 1a. Consume named flags and their values first: the `2` in `--max-rounds 2` or in `--spec specs/v2.md` is a flag value, never a PR number.
Otherwise, detect the current branch's PR:

```bash
gh pr view --json number -q .number 2>/dev/null
```

If a PR exists, proceed to step 1a. If no PR exists, fall back to step 1b (local diff review).

#### 1a. PR-based review

Resolve the repository:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Use `<REPO>#<PR_NUMBER>` as the review target.

#### 1b. Local diff review (no PR)

Generate a patch from the current branch against its merge-base with the remote default branch (`origin/HEAD`, falling back to `origin/main`). Scope the patch path by branch so a parallel session in another repository or worktree can never overwrite this review's input between generation and the review run. Let `<REPO>` be the repository directory name and `<BRANCH>` the branch name, each with every character outside `[A-Za-z0-9._-]` replaced by `-` (git allows shell metacharacters like `$`, `;`, and quotes in branch names — never interpolate an unsanitized name into a path or command):

```bash
DEFAULT_BRANCH=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)
git rev-parse --verify "$DEFAULT_BRANCH" >/dev/null || { echo "no default branch: $DEFAULT_BRANCH"; exit 1; }
BASE=$(git merge-base HEAD "$DEFAULT_BRANCH")
git diff "$BASE"..HEAD > <RCL_TMP>/rcl-branch-review-<REPO>-<BRANCH>.patch
```

If the diff is empty (no changes vs the default branch), tell the user and stop.

This reviews **committed work only** — `git diff <BASE>..HEAD` excludes staged, unstaged, and untracked changes. If `git status --porcelain` is non-empty, say which files are uncommitted and therefore unreviewed before running — and offer to review them instead: with rcl ≥ 1.6.0, `rcl review --staged` reviews staged changes and `rcl review --working-tree` reviews all uncommitted changes (staged + unstaged; untracked files are invisible to `git diff` in both modes). These flags replace the patch file as the review target — everything else (reports, spec, roles) works the same. Never mix them with a positional target, and never let an empty or partial diff be mistaken for a clean review of the current edits.

Use `<RCL_TMP>/rcl-branch-review-<REPO>-<BRANCH>.patch` as the review target.

Note: `--post` and `--inline` are ignored in local diff mode (there is no PR to post to). Inform the user if they passed those flags.

### 2. Resolve the spec (automatic)

The `spec-compliance` role reviews the diff against a specification. This step determines whether a spec is available and, if so, writes it to a target-scoped file for use with `--spec`. Let `<SPEC>` be `<RCL_TMP>/rcl-spec-<TARGET>.md` (`<TARGET>` as defined in step 5) — never a shared, unscoped path: concurrent sessions would overwrite each other's spec and review against the wrong requirements.

Check these sources **in order** and use the first one that produces content:

1. **Explicit `--spec <path>` flag in `$ARGUMENTS`** — use that file directly as `<SPEC>`, skip the rest of this step.

2. **Harness issue for the current work** — check for in-progress issues tied to this branch:
   ```bash
   harness list --status in_progress --assignee me
   ```
   If there is an in-progress issue (task or epic), dump its details:
   ```bash
   harness show <identifier>
   ```
   If the issue has a meaningful description and/or acceptance criteria, write them to `<SPEC>`:
   ```
   # Spec: <issue title>
   
   ## Description
   <description from the issue>
   
   ## Acceptance criteria
   <acceptance criteria from the issue>
   
   ## Design notes
   <design/notes fields if present>
   ```

3. **Spec file in the repo** — look for a spec or design doc related to the current branch:
   - Check for files matching the branch name or feature area in `docs/` or the repo root (e.g. `CONSENSUS_V2_SPEC.md` for a consensus-scoring branch).
   - Only use if the file clearly describes the feature being reviewed.

4. **No spec found** — proceed without `--spec`. The `spec-compliance` role will be skipped or run without a spec (it will note that no spec was provided).

If a spec was resolved (sources 1–3), inform the user which source was used.

### 3. Check rcl is available

```bash
which rcl && rcl --version
```

If not found — or the installed version is older than the pin below — install the pinned published version (bump this pin deliberately on each release — an unpinned `@latest` would hand whatever gets published next execution access to your source and GITHUB_TOKEN):
```bash
npm install -g review-council@1.7.0
```

Note: this repo is review-council's own source. Reviews default to the published package; to dogfood the working-tree version instead, run `npm run build && npm link` first — but never when the branch under review changes rcl's own review pipeline (a broken build must not review itself).

### 4. Parse flags

- `--post` → add `--post` to the rcl command and post a summary review to the PR (PR mode only)
- `--inline` → add `--post` to the rcl command (PR mode only). The rcl CLI has no separate inline flag: a posted review already anchors each finding as an inline line comment wherever it maps onto the diff (unmappable findings demote to the summary), so `--post` and `--inline` build the same command.
- `--spec <path>` → use the given file as the spec (overrides automatic detection from step 2)
- `--roles <list>` → pass through (e.g. `--roles security-auditor,bug-hunter`)
- default (no flags) → run the review locally and report the findings back in the session without posting to GitHub

### 5. Run the review

**Always write the full report to files** with `--markdown` and `--json-file`. The console output is long and the critical/important findings print at the top, so reading it off stdout — especially piped through `head`/`tail` — silently drops the most important findings. The files are the source of truth; the console is throwaway.

Scope the report filenames to the review target so parallel runs (multiple worktrees or parallel agent sessions reviewing different PRs at once) never clobber each other's report. Let `<TARGET>` be `<REPO>-<PR number>` in PR mode, or `<REPO>-<BRANCH>` in local diff mode (components sanitized as in step 1b — identical PR numbers or branch names in different repositories must not collide) — e.g. `<RCL_TMP>/rcl-report-rcl-7.md` or `<RCL_TMP>/rcl-report-rcl-feat-openrouter-kimi-k3.md`.

For PR-based review:
```bash
GITHUB_TOKEN=$(gh auth token) rcl review <REPO>#<PR_NUMBER> \
  --markdown <RCL_TMP>/rcl-report-<TARGET>.md --json-file <RCL_TMP>/rcl-report-<TARGET>.json \
  [--post] [--spec <SPEC>] [--roles <roles>]
```

For local diff review:
```bash
GITHUB_TOKEN=$(gh auth token) rcl review <RCL_TMP>/rcl-branch-review-<REPO>-<BRANCH>.patch \
  --markdown <RCL_TMP>/rcl-report-<TARGET>.md --json-file <RCL_TMP>/rcl-report-<TARGET>.json \
  [--spec <SPEC>] [--roles <roles>]
```

Only include `--spec` if a spec was resolved in step 2 (`<SPEC>` is the exact path resolved there — the explicit flag value, or the target-scoped generated file).

**Never** pipe the `rcl review` command through `head`, `tail`, `| head -n`, or similar — the report is captured in the files above no matter what scrolls past in the console.

**Always launch the run in the background** (`run_in_background: true`) after deleting any leftover `<RCL_TMP>/rcl-report-<TARGET>.*` files from earlier runs, and continue when the task-completion notification arrives — never block on a foreground wait or sleep loop. Then confirm the JSON report file exists and is non-empty before parsing it. The full council takes 10–15 minutes; a plain foreground Bash call is killed at the 600-second tool cap with no report files written and the whole model spend wasted.

### 6. Report back

Read the full report **from the files**, never from console scrollback:
- `<RCL_TMP>/rcl-report-<TARGET>.md` — the findings, via the Read tool (it paginates, so nothing is lost to truncation).
- `<RCL_TMP>/rcl-report-<TARGET>.json` — the exact severity counts; parse these rather than eyeballing the markdown.

Then tell the user:
- Whether this was a PR review or a local diff review
- Which PR was reviewed (if PR mode), or which branch and merge-base range (if diff mode)
- Which spec was used (if any) and where it came from (Harness issue, file, explicit flag)
- Which models ran and how many findings each returned
- Link to the posted review comment (from rcl output) only if `--post` or `--inline` was used in PR mode
- Brief summary: N critical, N important, N minor

## Examples

- `/rcl` — review current PR locally, or fall back to branch diff if no PR exists; auto-detect spec from Harness
- `/rcl --post` — review current PR and post a summary comment to GitHub
- `/rcl --inline` — post with inline line comments where anchoring is possible
- `/rcl --spec CONSENSUS_V2_SPEC.md` — review with a specific spec file
- `/rcl #7` — review a specific PR by number
- `/rcl --roles security-auditor,bug-hunter` — run only specific reviewer roles

For a review → fix → re-review loop that drives the PR or branch to a clean council verdict, use `/rcl-converge` instead (separate skill; it composes this one per round).
