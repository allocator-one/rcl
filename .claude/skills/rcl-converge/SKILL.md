---
name: rcl-converge
description: Drive the current PR or branch diff to a clean Review Council verdict by looping review → triage → fix → push until no new actionable findings remain
argument-hint: "[PR#N] [--max-rounds N] [--max-attempts N] [--roles <roles>] [--spec <path>] [--post-final]"
allowed-tools:
  - Bash(gh pr view:*)
  - Bash(gh pr comment:*)
  - Bash(gh pr merge:*)  # disarming only — see hard rules; the command is `gh pr merge <PR> --disable-auto`
  - Bash(gh auth token:*)
  - Bash(gh repo view:*)
  - Bash(rcl review:*)
  - Bash(rcl converge-attempt:*)
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
  - Bash(npm install -g review-council@latest)
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

<!-- GENERATED FILE — do not edit. Source: skills/src/rcl-converge.md
     Edit the source, then run `npm run build:skills`. `npm test` enforces this. -->

# Review Council converge (rcl-converge)

Drive the current PR (or branch diff) to a clean Review Council verdict: loop review → triage → fix → push until a round produces no new actionable findings. This skill composes the `rcl` skill — each round runs the same review; this skill owns the loop, the triage ledger, and the safety interlocks.

Cost awareness: every attempt is a full multi-model council run. RCL prints a run-specific call/wave estimate; multi-chunk diffs can take much longer than one provider timeout. The machine-enforced cost cap defaults to 7 **attempts**, including failed, killed, no-report, and inconclusive runs. It is a consent boundary, not an absolute ceiling: an explicit `--max-attempts <N>` invocation may choose a different cap. The legacy `--max-rounds` flag remains a separate evidence-round limit.

Authorization: invoking this skill IS the explicit request for the loop's fix commits (and pushes, in PR mode) — no additional mid-loop approval is sought for those edits. Raising the configured attempt cap is a separate cost decision and always requires explicit user approval. This satisfies repository profiles that otherwise require asking before committing. A standing "do not commit" or "do not push" instruction still wins: do not start the loop while one is active.

## Flags

- `PR#N` / `#N` / `N` — converge a specific PR (default: current branch's PR, else local diff mode)
- `--max-rounds <N>` — legacy evidence-round limit, counted from the ledger (default 7, valid range 1–7); failed/no-report attempts do not advance it
- `--max-attempts <N>` — explicitly set the target's total launch-attempt cap to any positive integer (default 7 for a new target); it may lower or raise a persisted cap, while omitting it on resume preserves the existing cap
- `--roles <list>`, `--spec <path>` — passed through to every round's review
- `--post-final` — after convergence, post a summary comment to the PR (never posts mid-loop)

Set `<ATTEMPT_CAP_ARG>` to `--max-attempts <N>` only when the user explicitly supplied that same `--max-attempts <N>` flag for this invocation; otherwise leave it empty. The CLI defaults a new target to 7 and preserves that target's persisted cap on later invocations that omit the flag. `--max-rounds` never changes the machine attempt cap. Never invent a higher value on the user's behalf.

## Steps

### 0. Private artifact directory

All temporary artifacts below (patches, specs, reports, logs, PID files) live under `<RCL_TMP>` = `/tmp/rcl-<uid>` (your numeric `id -u`) — never directly in world-writable `/tmp`, where another local user could pre-create, symlink, or tamper with predictable filenames. Create and verify it once per session:

```bash
RCL_TMP=/tmp/rcl-$(id -u); mkdir -p "$RCL_TMP" && [ ! -L "$RCL_TMP" ] && [ -d "$RCL_TMP" ] && [ -O "$RCL_TMP" ] && chmod 0700 "$RCL_TMP"
```

Order matters: the symlink and ownership checks run **before** `chmod`, because a `chmod` on a pre-created symlink would follow it and re-permission someone else's directory before the check could reject it. If any check fails, stop — never write artifacts to a directory you do not exclusively own. `<RCL_TMP>` below is a **textual placeholder**: substitute the resolved path (e.g. `/tmp/rcl-501`) when writing each command, rather than relying on `$RCL_TMP` surviving into a detached or single-quoted shell. Shell-quote every dynamic value that enters a generated command. A tampered report would steer real commits in this loop, so the directory check is load-bearing. The converge ledger is the exception: it lives in the repository's git dir (step 1.5) for durability across sessions.

### 1. Preconditions

1. The working tree must be clean (`git status --porcelain`) — the loop makes commits. If dirty, stop and ask the user to commit or stash first.
2. Resolve the review target, spec, and `rcl` availability exactly as the `rcl` skill does — read `.claude/skills/rcl/SKILL.md` and follow its steps 1–3. Conventions that differ here:
   - `<TARGET>` is `<repo>-<PR number>` (e.g. `rcl-7`), or `<repo>-<branch>` in local diff mode, with every character outside `[A-Za-z0-9._-]` in either component replaced by `-` — git allows shell metacharacters in branch names, so an unsanitized name interpolated into paths, `rm`, or the detached launch command is an injection vector, and the repo component keeps identical PR numbers or branch names in different repositories from colliding.
   - Report files are round-scoped: `<RCL_TMP>/rcl-report-<TARGET>-r<R>.md` / `.json` for round `<R>`, so rounds never clobber each other.
3. **Verify the checkout matches the PR** (PR mode): the loop commits to the current branch, so the PR's head branch (`gh pr view <PR> --json headRefName -q .headRefName`) must equal `git rev-parse --abbrev-ref HEAD`. On mismatch — typical when an explicit `PR#N` was passed — stop and ask the user to check out the PR's branch first; never fix a PR from a different checkout. The PR must also live in this repository: `gh pr view <PR> --json isCrossRepository` must be false — converge does not drive fork PRs. (A detached HEAD reads as `HEAD` and simply fails the match; that stop is correct.) Also verify local HEAD equals the PR head commit (`gh pr view <PR> --json headRefOid -q .headRefOid` vs `git rev-parse HEAD`): a clean tree can still be ahead of the PR by unpushed commits, and the council would then review — and possibly converge on — code the PR does not contain. If local is ahead, push first; if the histories diverge, stop and ask. The PR must also be OPEN (`gh pr view <PR> --json state -q .state`) — never converge a merged or closed PR.
4. **Disarm auto-merge** (PR mode): check `gh pr view <PR> --json autoMergeRequest`. If armed, run `gh pr merge <PR> --disable-auto` and tell the user why: CI can go green mid-loop, merge a partial squash, auto-delete the branch, and strand later fix pushes on an already-merged PR. Do not re-arm during the loop.
5. **Take the target lock** — after `<TARGET>` is resolved in step 2, never before it. Two converge runs on one target would interleave edits, commits, and ledger writes. Claim `<GIT_DIR>/rcl-converge-<TARGET>.lock` atomically (`mkdir` succeeds only if the directory does not already exist — do not use `-p`, which succeeds unconditionally and defeats the lock). If the claim fails, read the holder's PID from the lock's `owner` file: if that process is gone the lock is stale from a crashed run — remove it, say so, and re-claim. Otherwise report that a live run holds the target and stop. Release the lock (`rmdir`) on every exit path: convergence, cap, precondition failure, review failure, or user interrupt.
6. Open the ledger `<GIT_DIR>/rcl-converge-<TARGET>-ledger.md`, where `<GIT_DIR>` is `$(git rev-parse --git-common-dir)` — the *common* dir, because `--git-dir` resolves to `.git/worktrees/<name>` inside a linked worktree, which would give every worktree its own private ledger and lock when they must share one per repository. The git dir is durable (the cumulative attempt accounting survives reboots and /tmp cleanup), repo-scoped, and not world-writable — a /tmp ledger could be pre-seeded by another local user to mark real findings as already-dismissed. If a ledger exists from an earlier session, first verify it belongs to this history: every round records the reviewed HEAD SHA, and the last recorded SHA must be an ancestor of or equal to the current HEAD (`git merge-base --is-ancestor <sha> HEAD`). If it is, resume — prior evidence rounds still count toward `--max-rounds`. If not (force-push, branch reuse), rename the evidence ledger aside and start a fresh one, but never delete or reset `.git/rcl-converge-attempts`: launch attempts remain cumulative for the stable target, and an exhausted cap still requires explicit user approval plus a higher `--max-attempts`. Otherwise create the ledger — format below.

### 2. Round loop

For each evidence round `<R>` (numbering continues from a resumed ledger), first consume one machine-accounted attempt. A failed or inconclusive attempt may leave `<R>` unchanged, but it still advances the attempt counter. Stop when either the legacy `--max-rounds` evidence limit (default 7, maximum 7) or the configured attempt cap is exhausted. The attempt cap defaults to 7, while an explicit `--max-attempts` invocation may configure another value:

1. **Refresh the target.** PR mode: re-check that the PR head still equals local HEAD and that the PR is still OPEN (an external push mid-loop means someone else is driving the branch, and a merged or closed PR must not be converged — stop and report). Otherwise nothing to do — the PR already contains last round's pushed fixes. Local diff mode: regenerate the patch so the round reviews the fixed code:
   ```bash
   DEFAULT_BRANCH=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)
git rev-parse --verify "$DEFAULT_BRANCH" >/dev/null || { echo "no default branch: $DEFAULT_BRANCH"; exit 1; }
   BASE=$(git merge-base HEAD "$DEFAULT_BRANCH")
   git diff "$BASE"..HEAD > <RCL_TMP>/rcl-branch-review-<TARGET>.patch
   ```
2. **Claim in the foreground, then run the review detached.** Run the first block below exactly once as a foreground Bash call. Its quoted `<TARGET>` is the exact resolved accounting key (the quotes are shell syntax, not part of the value). Never set `run_in_background` on this claim and never call it separately again. Any non-zero exit stops before the review: exit 2 is the configured consent boundary, so release the target lock and ask the user whether to stop for human review or continue with a specific higher cap; continue only after explicit approval by resuming with `--max-attempts <N>`. Exit 3 is an accounting/infrastructure failure: release the lock, report it, and do not suggest raising the cap. A successful claim is spent even if the later launch fails, is killed, produces no report, or is inconclusive.

   ```bash
   rm -f <RCL_TMP>/rcl-report-<TARGET>-r<R>.md <RCL_TMP>/rcl-report-<TARGET>-r<R>.json
   rcl converge-attempt --target '<TARGET>' <ATTEMPT_CAP_ARG>
   ```

   Only after that foreground call succeeds, launch this second block as a separate Bash call with `run_in_background: true`; never run the review as a plain foreground call. RCL prints the run-specific runtime plan, so never assume a fixed duration. Continue when the task-completion notification arrives — never block on it with a foreground wait or sleep loop.

   ```bash
   GITHUB_TOKEN=$(gh auth token) rcl review <target> \
     --markdown <RCL_TMP>/rcl-report-<TARGET>-r<R>.md \
     --json-file <RCL_TMP>/rcl-report-<TARGET>-r<R>.json \
     [--spec <SPEC>] [--roles <roles>]
   ```

   Never pass `--post` or `--inline` mid-loop. If the run exits non-zero or the JSON report is missing or empty, read the run output, report the failure, and stop. It does not count as an evidence round, but its foreground claim remains spent.
3. **Check reviewer health first, then parse findings from the JSON file**, never from console scrollback. `stats.successfulReviews` / `stats.totalReviews` gates the whole round: a report is produced even when most model calls time out or error, so a near-empty finding list can mean 'nothing found' or 'nobody looked'. If fewer than two of the reviewers succeeded, or fewer than two thirds of them did, the round is **inconclusive** — never counted as converged. Report the failure pattern (which models, timeout vs error), fix the cause if it is under your control (timeouts, missing keys, reasoning budget), and re-run only if the machine attempt budget permits it. Re-runs are budgeted: at most two per evidence-round number, while every review attempt counts toward the configured cap. Raising that cap requires a new, explicit, user-approved `--max-attempts` invocation, so a permanently broken fleet cannot spin unattended. Split by severity: critical/important findings gate convergence; minor findings are opportunistic.
4. **Dedup against the ledger.** Models rephrase across rounds — match by file plus the substance of the issue, not exact wording. Findings already dismissed get a quick re-check that the dismissal reason still holds against the current code — a later fix can invalidate it (for example by removing the guard that made the issue harmless). If the reason holds, mark them `[recurring]` without full re-triage; if not, treat them as new. A recurring finding previously marked **fixed** gets a quick re-verification that the fix actually landed and addresses it — if it does, mark it `[recurring]`; if not, treat it as new.
5. **Triage every new finding against the actual code before touching anything.** Council findings skew heavily false-positive (historically roughly 1 in 10 is actionable). Classify each as `fix` (real, worth fixing) or `dismiss` (false positive, not actionable, or out of scope) — every dismissal gets a one-line reason in the ledger.
6. **Apply the fixes.** After edits: `npm run lint` (type-check) and `npm test` (vitest suite). Do not commit until these are green; if a fix cannot be made green, drop it, record that in the ledger, and report it.
7. **Record the round in the ledger** (format below — the round header records the reviewed HEAD SHA). Write the findings and verdicts now, but leave each fixed entry's commit hash blank: the commit does not exist until the next step. Fill the hashes in immediately after committing, so the ledger never cites a hash that was never created.
8. **Commit and push** (PR mode) if anything was fixed: one commit per round, e.g. `Address RCL round 2 findings: <short summary>`. Local diff mode: commit only; there is nothing to push. Immediately before `git push`, re-check the PR is still OPEN — if it merged or closed mid-loop, keep the commit local, stop, and report.
   - **Push alarm:** if `git push` prints `* [new branch]` for a branch that should already exist remotely, STOP the loop immediately — the remote branch was deleted (the PR merged and auto-deleted mid-loop) and the push just re-created an orphan attached to a merged PR. Check `gh pr view --json state`; unpushed fixes need a fresh PR.
9. **Check convergence** (next section). Converged or capped → exit the loop; otherwise start the next round.

### 3. Convergence

A round can only converge if it was **conclusive** (at least two thirds of reviewers succeeded — see step 3). A conclusive round **converges** when it produced **zero new actionable critical/important findings** — every critical/important finding in its report was either already in the ledger or was dismissed this round with a reason, and nothing required a fix. A round that fixed a critical/important finding is by definition not converged, even though the finding is handled. Minor findings never block convergence; fix them opportunistically when cheap.

Consequences:

- A round that fixed any critical/important finding did **not** converge — at least one more round must confirm those fixes and catch regressions they may have introduced. A round whose only fixes were minor findings can still converge.
- If the attempt cap is hit while the last evidence round still fixed things, report **"capped, not converged"**: the last round's fixes are unreviewed. Stop before another launch and ask the user whether to use human review or explicitly resume with a higher `--max-attempts` value. No answer means no additional attempt.
- If the legacy evidence-round limit is hit, stop under its original semantics; `--max-attempts` does not silently raise or reinterpret `--max-rounds`.

### 4. After the loop

1. If `--post-final` (PR mode, converged only): post a convergence summary as a PR comment (`gh pr comment`) built from the ledger — rounds run, fixed/dismissed counts with reasons, final verdict. This is a summary comment, not another council run.
2. Report to the user:
   - Converged or capped, with evidence rounds, attempts used, and the configured cap
   - Per round: new findings, fixed vs dismissed (with the load-bearing dismissal reasons)
   - Commits pushed
   - Reminder: auto-merge was disarmed / left unarmed — it is now safe to arm it.

## Ledger format

`<GIT_DIR>/rcl-converge-<TARGET>-ledger.md` (`<GIT_DIR>` = `$(git rev-parse --git-common-dir)`):

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
- Every council launch must be preceded by a successful `rcl converge-attempt` claim. Never bypass or reset its persisted state, and never exceed the configured cap. The count is cumulative across sessions, force-pushes, and resumes. Seven is only the default; a higher cap is valid when the user explicitly supplied `--max-attempts` at invocation or explicitly approved it after a refusal.
- Preserve `--max-rounds` as the evidence-round limit it has always represented; never use it as an alias for the machine attempt cap.
- Execute the host variant's claim exactly once: Claude runs its claim block in the foreground and its review block separately; Codex runs its combined claim-and-launch block once. Never repeat `rcl converge-attempt`, because each successful call spends another attempt.
- Never terminate a live council merely because its log contains one model/parser warning. Let RCL finish and assess reviewer health from the completed JSON report; killing the process destroys the evidence needed for that decision.
- Read reports from files, never console scrollback; every round gets its own report files.

## Examples

- `/rcl-converge` — converge the current branch's PR with the default 7-attempt cap
- `/rcl-converge #7 --max-rounds 2` — preserve the legacy behavior: stop after two evidence rounds
- `/rcl-converge #7 --max-attempts 10` — explicitly authorize up to 10 launch attempts at invocation, or resume with 10 after approving continuation at a lower cap
- `/rcl-converge --roles security-auditor,bug-hunter --post-final` — converge on two roles, post the summary once clean
