# Changelog

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
