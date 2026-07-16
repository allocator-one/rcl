# PRD: Council review fixes — rcl 1.4.0

| Field | Value |
|---|---|
| Owner | Michael Ströck |
| Created | 2026-07-16 |
| Status | In progress |
| Purpose | Fix all findings from the 2026-07-16 three-track code review of rcl @ 865b01c |
| Version | 1.0 |

## Background

A full-source review (consensus/roles, dispatch/config/CLI, prepare/output/prompts, plus dependency audit) of rcl 1.3.0 produced 1 critical, 11 major, and ~14 minor findings. This PRD groups them into six workstreams and defines acceptance criteria for each. Target release: **1.4.0**.

Guiding principles:

- Silent coverage loss is the worst failure mode for a review tool. Anything that skips code must warn loudly and fail `--ci`.
- Config errors must never widen the set of providers that receive code.
- Model output is untrusted end to end: parsing, scoring, and everything posted to GitHub.
- Every fix lands with a test that fails before and passes after (TDD), except docs-only items.

## WS1 — Coverage correctness (critical)

### 1.1 Multi-chunk review
`src/index.ts:256-257` reviews only `chunks[0]`; diffs beyond 2,000 lines / 20 files are silently dropped.
**Fix:** fan out assignments × chunks, merge findings before dedup. Progress totals reflect assignments × chunks.
**Accept:** a diff producing 2+ chunks yields findings from files in every chunk; runner receives `assignments.length × chunks.length` requests.

### 1.2 Paginate PR file listing
`src/resolver/github.ts:52-57` fetches one page (`per_page: 100`).
**Fix:** `octokit.paginate(octokit.pulls.listFiles, ...)`.
**Accept:** unit test with mocked octokit shows >100 files resolved.

### 1.3 CI gate on zero successful reviews
`src/index.ts:343-353` exits 0 when every review errors.
**Fix:** in `--ci`, exit non-zero when `successfulReviews === 0` with a distinct message.
**Accept:** test: all-error review set + `--ci` → non-zero exit path taken.

### 1.4 Oversized single-file chunks
`src/prepare/chunker.ts:28-36`: a file > MAX_CHUNK_LINES goes to models unsplit and uncapped.
**Fix:** truncate oversized single-file patches at a hard cap with an explicit `[truncated after N lines]` marker; log a warning naming the file.
**Accept:** chunker test: 5,000-line patch → chunk content capped, marker present.

## WS2 — Dispatch reliability (major)

### 2.1 Timeout classification
`err.name === 'AbortError'` never matches SDK abort errors (`APIUserAbortError` has name `Error`).
**Fix:** check `controller.signal.aborted` (uniform across anthropic/openai/openai-compat).
**Accept:** adapter test with aborted signal → `status: 'timeout'`.

### 2.2 Google adapter timer leak / no cancellation
`src/dispatch/google.ts:35-56`: uncleared `setTimeout` keeps the event loop alive ≤120s after success; request never aborted.
**Fix:** capture timer handle, `clearTimeout` in `finally`; pass `abortSignal` via `config`.
**Accept:** test: resolved review leaves no active timer (vi.useFakeTimers); timeout path returns `status: 'timeout'`.

### 2.3 `openai-compat/` prefix never stripped
**Fix:** add `openai-compat/` to `KNOWN_PROVIDER_PREFIXES`; call `stripKnownProviderPrefix` in the compat adapter.
**Accept:** utils test: `openai-compat/llama3.2` → `llama3.2`; adapter passes stripped id.

### 2.4 Retry ownership + retryable statuses
SDK-internal retries multiply the adapter loop (≤12 wire attempts); allowlist misses 529/502/504.
**Fix:** construct SDK clients with `maxRetries: 0`; adapter retry predicate covers 429/500/502/503/504/529.
**Accept:** adapter tests for the predicate; clients constructed with `maxRetries: 0`.

### 2.5 Truncation reported as success
No adapter checks `stop_reason`/`finish_reason`.
**Fix:** `stop_reason === 'max_tokens'` / `finish_reason === 'length'` → `status: 'error'` with explicit message. Raise compat `max_tokens` to 16384 to match the others.
**Accept:** adapter tests: truncated response → error status, not empty success.

### 2.6 Runner: worker pool, progress, dead options
Fixed sequential batches head-of-line block; `AdapterOptions.apiKey`/`baseUrl` are dead; constructor throws skip `onReviewComplete`.
**Fix:** index-stealing worker pool honoring `concurrency`; call `onReviewComplete` on the rejected path; delete dead options (keys stay env-only, documented).
**Accept:** runner tests: slow first item does not block others beyond pool width; progress counter reaches total when a constructor throws.

### 2.7 Delete dead divergent adapter helpers
`adapter.ts` `withTimeout`/`parseProviderFromModel`/`stripProviderPrefix` have zero call sites and diverge from the real logic.
**Fix:** delete; `detectProvider` + `stripKnownProviderPrefix` are the single source of truth.
**Accept:** grep-clean; typecheck passes.

## WS3 — Security (major)

### 3.1 No executable config
cosmiconfig `searchPlaces` includes `.js`/`.cjs` files and walks parent dirs; running rcl in a cloned repo can execute attacker JS with API keys in env.
**Fix:** restrict `searchPlaces` to `.json`/`.yaml`/`.yml` (+ `package.json` key); limit search to cwd (`stopDir: cwd`).
**Accept:** loader test: `.review-council.cjs` present in cwd is ignored.

### 3.2 Config validation failure is fatal
Invalid config currently falls back to cloud defaults, shipping code to providers the user excluded.
**Fix:** `safeParse` failure → print issues, `process.exit(1)` (throw a typed error handled once in index.ts).
**Accept:** loader test: invalid config throws; no default-model fallback.

### 3.3 Prompt-injection delimiters
Static `<<<DIFF_START>>>` delimiters, never sanitized out of diff content.
**Fix:** strip/mangle delimiter substrings from untrusted content; keep instructions naming the exact delimiters.
**Accept:** hardening test: diff containing `<<<DIFF_END>>>` is neutralized inside the wrapped block.

### 3.4 Sanitize model output posted to GitHub
`title`/`description`/`suggestedFix`/provider `error` interpolated verbatim into PR comments.
**Fix:** shared sanitizer: neutralize `@mentions` (wrap in backticks), strip HTML comments/tags, cap field lengths, fence `suggestedFix` with a longest-run-aware backtick fence.
**Accept:** github output tests: `@org/team` neutralized, `<script>` stripped, fix containing ``` does not escape its fence (also applied in markdown.ts — fixes the fence-escape minor).

### 3.5 Validate comment anchors; never lose the whole post
Model-supplied file/line pairs are unvalidated; one bad anchor 422s the entire review.
**Fix:** parse `@@ -a,b +c,d @@` hunk headers per file into commentable RIGHT-side line sets; snap near-misses (≤3 lines); demote unmappable findings into the summary body; on residual 422 retry once with `comments: []`.
**Accept:** tests: valid line kept; near-miss snapped; unmappable demoted to summary; 422 fallback posts summary-only review.

## WS4 — Consensus correctness (major)

### 4.1 Specialist gating in relevance/isolation
`general` declares all five focus categories, so every group scores relevance 1.0 and isolation counts generals as specialists.
**Fix:** gate both on `role.isSpecialized && role.focus.includes(category)`. Update voter tests to use the real builtin `general`.
**Accept:** finding flagged only by generals scores relevance 0.5; isolation ignores generals; tests use builtin role.

### 4.2 Missing `id` must not drop findings
Required `id` fails whole-response and salvage parsing; "assign stable IDs" path unreachable.
**Fix:** `id: z.string().optional().default('')`; ID assignment/dedup applies on both paths.
**Accept:** parser test: findings without ids all survive with generated ids.

### 4.3 `extractJson` candidates + bare arrays
Early return on `{`-prefixed output blocks fallbacks; bare `[...]` always yields zero findings.
**Fix:** candidate list (direct trim → each fence → brace slice → bracket slice), first that parses wins; wrap top-level arrays as `{ findings }`.
**Accept:** parser tests: `{...}` + trailing prose recovered; bare array parsed.

### 4.4 Line window doubling
Both ranges expand by `window`, so configured ±5 behaves as ±10.
**Fix:** gap-based check: ranges merge when the gap between them ≤ window. Update tests to encode single-window semantics.
**Accept:** findings 6 lines apart do not merge at window 5; 5 apart do.

### 4.5 Unique (model, role) voting
Bridge findings let one reviewer count twice in `consensus.score`, `severityCounts`, and the 2-supporter elevation guard.
**Fix:** collapse same-`(model, role)` group members post-split via `chooseRepresentative`; count unique pairs in severity/elevation.
**Accept:** voter test: group with duplicate (model, role) members counts them once; elevation requires two distinct reviewers.

### 4.6 Dead config: wire or delete
`minConsensusScore`/`minConfidence` validated but never read; `severityBias` threaded everywhere but only console.logged.
**Fix:** wire `minConfidence`/`minConsensusScore` as report filters (drop findings below either, note count in stats); fold `severityBias` into role prompt text ("Bias severity toward X when uncertain").
**Accept:** filter test; severityBias string present in built prompt for roles that declare it.

## WS5 — Roles & dispatch semantics

### 5.1 Skip content-dependent roles without content
`project-rules` / `spec-compliance` dispatch even when no rules/spec exists (2 wasted calls + hallucination bait).
**Fix:** drop from default/`all` expansion when content is absent; warn if explicitly requested without content.
**Accept:** loader test: no AGENTS.md/spec → roles absent from default resolution, present when explicitly requested (with warning).

### 5.2 Zero-assignment runs must fail
All-typo `--reviewer` pairs → "Running 0 reviews" and an empty report.
**Fix:** hard error when explicit reviewers resolve to zero assignments.
**Accept:** dispatcher/index test: unknown-role-only input exits with error.

### 5.3 Custom-role inheritance
`buildCustomRole` forces `isSpecialized: true` even when overriding a builtin.
**Fix:** inherit `isSpecialized` (and `description` when omitted) from the base role.
**Accept:** loader test: overriding `general` keeps `isSpecialized: false`.

### 5.4 Case-insensitive role lookup
`all` matches case-insensitively; role names don't.
**Fix:** normalize lookups to lowercase.
**Accept:** `--roles Security-Auditor` resolves.

### 5.5 Don't send the spec twice
Spec embedded in the spec-compliance role prompt AND appended as a context doc for every assignment.
**Fix:** stop passing `specFile` as a context doc; the role prompt embed is the single carrier.
**Accept:** built prompt for spec-compliance contains spec once; other roles' prompts don't contain it.

## WS6 — Packaging, deps, docs

### 6.1 Dependency hygiene
Remove unused `simple-git` (high RCE advisory, zero imports). `npm audit fix` for `protobufjs` (critical, via @google/genai) and `ws` (high).
**Accept:** `npm audit --omit=dev` reports 0 high/critical; typecheck + tests pass.

### 6.2 Spec as-built updates
CONSENSUS_V2_SPEC.md misdescribes relevance/diversity/elevation; ROLES_SPEC.md claims "default = general only" and "silently skipped" roles.
**Fix:** as-built addendum to CONSENSUS_V2_SPEC (relevance gating, diversity floor, elevation redesign, single-window dedup); align ROLES_SPEC with all-roles default + 5.1 skipping.
**Accept:** specs match shipped behavior for every WS4/WS5 change.

### 6.3 Release 1.4.0
Bump version, CHANGELOG entry summarizing this PRD, tag `v1.4.0`, GitHub release. npm publish if auth allows (2FA reset in flight — may be deferred).

## Out of scope

- O(n²) tokenization memoization (perf-only, current scale fine) — tracked as follow-up.
- Worker-pool cross-run adapter memoization.
- Multi-line GitHub comments (`start_line`) — follow-up.

## Test plan

Every WS lands with unit tests colocated under `test/` mirroring existing layout. Full gate: `npm run lint && npm test` green; `npm audit --omit=dev` free of high/critical.
