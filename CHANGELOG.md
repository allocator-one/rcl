# Changelog

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
