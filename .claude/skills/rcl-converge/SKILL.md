---
name: rcl-converge
description: Drive the current PR or branch diff to a clean Review Council verdict by looping review → triage → fix → push until no new actionable findings remain
argument-hint: "[PR#N] [--max-rounds N] [--roles <roles>] [--spec <path>] [--post-final]"
allowed-tools:
  - Bash(gh pr view:*)
  - Bash(gh pr comment:*)
  - Bash(gh pr merge --disable-auto:*)
  - Bash(gh auth token:*)
  - Bash(gh repo view:*)
  - Bash(rcl review:*)
  - Bash(rcl roles:*)
  - Bash(git status:*)
  - Bash(git merge-base:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git rev-parse:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(harness show:*)
  - Bash(harness list:*)
  - Bash(npm install -g review-council@1.5.0)
  - Bash(npm test:*)
  - Bash(npm run lint:*)
  - Bash(which rcl)
  - Bash(rm -f /tmp/rcl-*)
  - Write(/tmp/rcl-spec-*.md)
  - Read
  - Edit
  - Write
  - Glob
  - Read(/tmp/rcl-*/**)
  - Write(/tmp/rcl-*/**)
  - Bash(mkdir -p /tmp/rcl-*)
  - Bash(mkdir *rcl-converge-*.lock)
  - Bash(rmdir *rcl-converge-*.lock)
  - Bash(chmod 0700 /tmp/rcl-*)
  - Read(/tmp/rcl-report-*.md)
  - Read(/tmp/rcl-report-*.json)
  - Read(/tmp/rcl-converge-*.md)
  - Write(/tmp/rcl-converge-*.md)
---

# Review Council converge (rcl-converge)

Drive the current PR (or branch diff) to a clean Review Council verdict: loop review → triage → fix → push until a round produces no new actionable findings. This skill composes the `rcl` skill — each round runs the same review; this skill owns the loop, the triage ledger, and the safety interlocks.

Cost awareness: every round is a full multi-model council run (10–15 minutes of model spend). The cap is 7 rounds; never exceed it silently.

Authorization: invoking this skill IS the explicit request for the loop's fix commits (and pushes, in PR mode) — no additional mid-loop approval is sought, and this satisfies repository profiles that otherwise require asking before committing. A standing "do not commit" or "do not push" instruction still wins: do not start the loop while one is active.

## Flags

- `PR#N` / `#N` / `N` — converge a specific PR (default: current branch's PR, else local diff mode)
- `--max-rounds <N>` — total-round cap for the target, counted from the ledger (default and absolute maximum 7); resuming never resets the count
- `--roles <list>`, `--spec <path>` — passed through to every round's review
- `--post-final` — after convergence, post a summary comment to the PR (never posts mid-loop)

## Steps

### 0. Private artifact directory

All temporary artifacts below (patches, specs, reports, logs, PID files) live under `<RCL_TMP>` = `/tmp/rcl-<uid>` (your numeric `id -u`) — never directly in world-writable `/tmp`, where another local user could pre-create, symlink, or tamper with predictable filenames. Create and verify it once per session:

```bash
RCL_TMP=/tmp/rcl-$(id -u); mkdir -p "$RCL_TMP" && [ ! -L "$RCL_TMP" ] && [ -d "$RCL_TMP" ] && [ -O "$RCL_TMP" ] && chmod 0700 "$RCL_TMP"
```

Order matters: the symlink and ownership checks run **before** `chmod`, because a `chmod` on a pre-created symlink would follow it and re-permission someone else's directory before the check could reject it. If any check fails, stop — never write artifacts to a directory you do not exclusively own. `<RCL_TMP>` below is a **textual placeholder**: substitute the resolved path (e.g. `/tmp/rcl-501`) when writing each command, rather than relying on `$RCL_TMP` surviving into a detached or single-quoted shell. Shell-quote every dynamic value that enters a generated command. A tampered report would steer real commits in this loop, so the directory check is load-bearing. The converge ledger is the exception: it lives in the repository's git dir (step 1.5) for durability across sessions.

### 1. Preconditions

1. The working tree must be clean (`git status --porcelain`) — the loop makes commits. If dirty, stop and ask the user to commit or stash first.
1.5. **Take the target lock.** Two converge runs on one target would interleave edits, commits, and ledger writes. Claim `<GIT_DIR>/rcl-converge-<TARGET>.lock` atomically (`mkdir` succeeds only if it does not exist); on failure, report that a run already holds the target and stop. Release it when the loop exits, including on early stops.
2. Resolve the review target, spec, and `rcl` availability exactly as the `rcl` skill does — read `.claude/skills/rcl/SKILL.md` and follow its steps 1–3. Conventions that differ here:
   - `<TARGET>` is `<repo>-<PR number>` (e.g. `rcl-7`), or `<repo>-<branch>` in local diff mode, with every character outside `[A-Za-z0-9._-]` in either component replaced by `-` — git allows shell metacharacters in branch names, so an unsanitized name interpolated into paths, `rm`, or the detached launch command is an injection vector, and the repo component keeps identical PR numbers or branch names in different repositories from colliding.
   - Report files are round-scoped: `<RCL_TMP>/rcl-report-<TARGET>-r<R>.md` / `.json` for round `<R>`, so rounds never clobber each other.
3. **Verify the checkout matches the PR** (PR mode): the loop commits to the current branch, so the PR's head branch (`gh pr view <PR> --json headRefName -q .headRefName`) must equal `git rev-parse --abbrev-ref HEAD`. On mismatch — typical when an explicit `PR#N` was passed — stop and ask the user to check out the PR's branch first; never fix a PR from a different checkout. The PR must also live in this repository: `gh pr view <PR> --json isCrossRepository` must be false — converge does not drive fork PRs. (A detached HEAD reads as `HEAD` and simply fails the match; that stop is correct.) Also verify local HEAD equals the PR head commit (`gh pr view <PR> --json headRefOid -q .headRefOid` vs `git rev-parse HEAD`): a clean tree can still be ahead of the PR by unpushed commits, and the council would then review — and possibly converge on — code the PR does not contain. If local is ahead, push first; if the histories diverge, stop and ask. The PR must also be OPEN (`gh pr view <PR> --json state -q .state`) — never converge a merged or closed PR.
4. **Disarm auto-merge** (PR mode): check `gh pr view <PR> --json autoMergeRequest`. If armed, run `gh pr merge <PR> --disable-auto` and tell the user why: CI can go green mid-loop, merge a partial squash, auto-delete the branch, and strand later fix pushes on an already-merged PR. Do not re-arm during the loop.
5. Open the ledger `<GIT_DIR>/rcl-converge-<TARGET>-ledger.md`, where `<GIT_DIR>` is `$(git rev-parse --git-dir)`. The git dir is durable (the cumulative round cap survives reboots and /tmp cleanup), repo-scoped, and not world-writable — a /tmp ledger could be pre-seeded by another local user to mark real findings as already-dismissed. If a ledger exists from an earlier session, first verify it belongs to this history: every round records the reviewed HEAD SHA, and the last recorded SHA must be an ancestor of or equal to the current HEAD (`git merge-base --is-ancestor <sha> HEAD`). If it is, resume — prior rounds still count toward the cap. If not (force-push, branch reuse), rename it aside and start fresh. Otherwise create it — format below.

### 2. Round loop

For each round `<R>` (numbering continues from a resumed ledger) until the ledger holds `--max-rounds` rounds — and never more than 7 rounds for a target, regardless of flags or resumes:

1. **Refresh the target.** PR mode: re-check that the PR head still equals local HEAD and that the PR is still OPEN (an external push mid-loop means someone else is driving the branch, and a merged or closed PR must not be converged — stop and report). Otherwise nothing to do — the PR already contains last round's pushed fixes. Local diff mode: regenerate the patch so the round reviews the fixed code:
   ```bash
   DEFAULT_BRANCH=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)
git rev-parse --verify "$DEFAULT_BRANCH" >/dev/null || { echo "no default branch: $DEFAULT_BRANCH"; exit 1; }
   BASE=$(git merge-base HEAD "$DEFAULT_BRANCH")
   git diff "$BASE"..HEAD > <RCL_TMP>/rcl-branch-review-<TARGET>.patch
   ```
2. **Run the review detached.** The run takes 10–15 minutes — never run it as a plain foreground Bash call (the 600-second tool cap kills it with no report written and the model spend wasted). First delete any leftover report files for this round (`rm -f <RCL_TMP>/rcl-report-<TARGET>-r<R>.md <RCL_TMP>/rcl-report-<TARGET>-r<R>.json`) so a stale file from an earlier session is never mistaken for this round's result. Then launch with `run_in_background: true` and continue when the task-completion notification arrives — never block on it with a foreground wait or sleep loop. Confirm the JSON report exists and is non-empty before parsing.
   ```bash
   GITHUB_TOKEN=$(gh auth token) rcl review <target> \
     --markdown <RCL_TMP>/rcl-report-<TARGET>-r<R>.md \
     --json-file <RCL_TMP>/rcl-report-<TARGET>-r<R>.json \
     [--spec <SPEC>] [--roles <roles>]
   ```
   Never pass `--post` or `--inline` mid-loop. If the run exits non-zero or the JSON report is missing or empty, read the run output, report the failure, and stop — a failed run does not count as a round.
3. **Check reviewer health first, then parse findings from the JSON file**, never from console scrollback. `stats.successfulReviews` / `stats.totalReviews` gates the whole round: a report is produced even when most model calls time out or error, so a near-empty finding list can mean 'nothing found' or 'nobody looked'. If fewer than two thirds of reviewers succeeded, the round is **inconclusive** — never counted as converged. Report the failure pattern (which models, timeout vs error), fix the cause if it is under your control (timeouts, missing keys, reasoning budget), and re-run the round. Split by severity: critical/important findings gate convergence; minor findings are opportunistic.
4. **Dedup against the ledger.** Models rephrase across rounds — match by file plus the substance of the issue, not exact wording. Findings already dismissed get a quick re-check that the dismissal reason still holds against the current code — a later fix can invalidate it (for example by removing the guard that made the issue harmless). If the reason holds, mark them `[recurring]` without full re-triage; if not, treat them as new. A recurring finding previously marked **fixed** gets a quick re-verification that the fix actually landed and addresses it — if it does, mark it `[recurring]`; if not, treat it as new.
5. **Triage every new finding against the actual code before touching anything.** Council findings skew heavily false-positive (historically roughly 1 in 10 is actionable). Classify each as `fix` (real, worth fixing) or `dismiss` (false positive, not actionable, or out of scope) — every dismissal gets a one-line reason in the ledger.
6. **Apply the fixes.** After edits: `npm run lint` (type-check) and `npm test` (vitest suite). Do not commit until these are green; if a fix cannot be made green, drop it, record that in the ledger, and report it.
7. **Record the round in the ledger** (format below — the round header records the reviewed HEAD SHA).
8. **Commit and push** (PR mode) if anything was fixed: one commit per round, e.g. `Address RCL round 2 findings: <short summary>`. Local diff mode: commit only; there is nothing to push. Immediately before `git push`, re-check the PR is still OPEN — if it merged or closed mid-loop, keep the commit local, stop, and report.
   - **Push alarm:** if `git push` prints `* [new branch]` for a branch that should already exist remotely, STOP the loop immediately — the remote branch was deleted (the PR merged and auto-deleted mid-loop) and the push just re-created an orphan attached to a merged PR. Check `gh pr view --json state`; unpushed fixes need a fresh PR.
9. **Check convergence** (next section). Converged or capped → exit the loop; otherwise start the next round.

### 3. Convergence

A round can only converge if it was **conclusive** (at least two thirds of reviewers succeeded — see step 3). A conclusive round **converges** when it produced **zero new actionable critical/important findings** — every critical/important finding in its report was either already in the ledger or was dismissed this round with a reason, and nothing required a fix. A round that fixed a critical/important finding is by definition not converged, even though the finding is handled. Minor findings never block convergence; fix them opportunistically when cheap.

Consequences:

- A round that fixed any critical/important finding did **not** converge — at least one more round must confirm those fixes and catch regressions they may have introduced. A round whose only fixes were minor findings can still converge.
- If the cap is hit while the last round still fixed things, report **"capped, not converged"**: the last round's fixes are unreviewed. Ask the user whether to run more rounds — never beyond the absolute cap of 7.

### 4. After the loop

1. If `--post-final` (PR mode, converged only): post a convergence summary as a PR comment (`gh pr comment`) built from the ledger — rounds run, fixed/dismissed counts with reasons, final verdict. This is a summary comment, not another council run.
2. Report to the user:
   - Converged or capped, and in how many rounds
   - Per round: new findings, fixed vs dismissed (with the load-bearing dismissal reasons)
   - Commits pushed
   - Reminder: auto-merge was disarmed / left unarmed — it is now safe to arm it.

## Ledger format

`<GIT_DIR>/rcl-converge-<TARGET>-ledger.md` (`<GIT_DIR>` = `$(git rev-parse --git-dir)`):

```markdown
# RCL converge ledger — <TARGET>

## Round 1 — HEAD abc1234 — report <RCL_TMP>/rcl-report-<TARGET>-r1.json — 12 findings (2 critical / 4 important / 6 minor)
- [fixed] src/consensus/deduper.ts — line-overlap window applied twice — commit abc1234
- [dismissed] src/output/github.ts — "prompt injection via diff content" — delimiters already neutralized in sanitize.ts
- [minor/fixed] src/config/defaults.ts — typo in comment — commit abc1234
```

## Hard rules

- Never `--post`/`--inline` mid-loop; the only posting is the `--post-final` summary comment after convergence.
- Never arm auto-merge; disarm it at the start if armed. Never run `gh pr merge` in any form other than `--disable-auto` — that allowlist entry exists solely for disarming; merging is out of scope for this skill.
- Never amend or force-push — fixes are always new commits.
- Never exceed `--max-rounds` silently, and never run more than 7 total rounds for a target — the count is cumulative across sessions and resumes. Past 7, the answer is human review, not more council runs.
- Read reports from files, never console scrollback; every round gets its own report files.

## Examples

- `/rcl-converge` — converge the current branch's PR, up to 7 rounds
- `/rcl-converge #7 --max-rounds 2` — converge a specific PR with a tighter cap
- `/rcl-converge --roles security-auditor,bug-hunter --post-final` — converge on two roles, post the summary once clean
