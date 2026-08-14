# Under-merge corpus (RCL-17)

Eight real council runs in which a group of findings that **should** have merged
did not, so the concept never reached the report. Each fixture is the verbatim
`reviews[]` array from a production run — the true input to
`deduplicateFindings` — plus an `expected` block describing the cluster that
ought to come out.

These exist to be developed against, not just to document a bug. See
`test/consensus/undermerge-corpus.test.ts`.

## The defect

`ISSUE_CONCEPTS` in `src/consensus/deduper.ts` enumerates ten concepts, all
security or performance. Any other recurring concept gets no boost from
`conceptSimilarity` and falls back to token similarity, which is precisely the
signal the RCL-9 docstring already records as too weak for cross-model
duplicates (0.29–0.55). When N models flag one defect in N phrasings, nothing
merges, each copy stays `tier: "single"` with `agreementRatio = 1/total`, and
`applyReportThresholds` drops all of them against `minConsensusScore: 0.4`.

The failure inverts the signal. Consensus feeds the reporting decision, so
splitting one N-model finding into N single-model findings pushes every copy
*below* the bar. The more models independently agree — as long as they disagree
on wording — the more certain the finding is to vanish.

Note the confidence floor is **not** involved: single-model findings score
`0.22857`, which passes `minConfidence: 0.2`. Agreement is the binding gate.

## Cases

| fixture | repo | concept | pairs/reviews | ratio if merged |
| --- | --- | --- | --- | --- |
| `ios-44-r1-di-test-detection` | infra-one-ios | test-env detection embedded in production DI | 8/16 | 0.500 |
| `harness-cli-9-r16-empty-body-guard` | harness-cli | empty-body check applies only to `--body-file`, not inline | 7/14 | 0.500 |
| `ao-7426-r3-source-grep-test` | allocator-one | handler-drift test greps source text instead of asserting behaviour | 7/15 | 0.467 |
| `harness-cli-9-r9-empty-body-guard` | harness-cli | same concept as r16, seven rounds earlier | 6/13 | 0.462 |
| `ao-7467-r1-nilable-decimal-spec` | allocator-one | mining proxy combined two nil-related concepts; negative guard | — | — |
| `ao-7354-r5-trigger-label-nil-name` | allocator-one | `trigger_label/1` raises on missing/non-atom `column.name` | 11/17 | 0.647 |
| `ao-7536-r1-icon-matcher-precision` | allocator-one | unclosed prefix in a test's string matcher | 8/17 | 0.471 |
| `ao-7484-r2-aria-checked-roles` | allocator-one | `menuitemcheckbox`/`menuitemradio` not required to carry `aria-checked` | 6/15 | 0.400 |

Seven verified concepts clear `minConsensusScore: 0.4` once merged, so
**fixing dedup alone is sufficient** — no threshold retuning required. The
`ao-7467-r1` proxy is a negative case: `standard_terms: nil` behavior and a
`Decimal.t() | nil` typespec require different fixes and must remain separate.

`ao-7536-r1` is the ground-truth case: hand-verified end to end, 8 findings from
8 distinct `model::role` pairs (`8/17 = 0.47`). The mining script recovered 7 of
those 8, so the table is mildly conservative rather than inflated.

`harness-cli-9` appears at both r9 and r16 of one converge loop. A loop ran at
least sixteen rounds and never surfaced a finding half its fleet reported —
recurrence detection cannot help, because the finding never entered the ledger.

## Working against these (TDD)

`undermerge-corpus.test.ts` has two layers:

1. **Regression target** — fourteen assertions require the seven verified
   concepts to collapse and clear `minConsensusScore`; two more lock the
   `ao-7467-r1` proxy as separate, below-threshold concepts. These were the
   sixteen `it.fails` TDD targets before RCL-17 was implemented.
2. **Over-merge guard** — `ao-7536-r1` carries a second,
   distinct concept at the same lines ("global log capture is brittle, prefer
   per-test `capture_log`") which is unactionable and correctly below threshold
   at 5/17. A fix that swallows it into the matcher-precision group is wrong.

The two-sided shape matters. Loosening thresholds until the positive cases
pass breaks the negative guards — the corpus is built to catch that.

## Caveats

- The proxy caveats were checked against the raw findings. The distinct
  `ao-7354-r5` "lacks `@spec`" row was removed from the expectation, while five
  additional missing-`:name` variants were added. `ao-7467-r1` was confirmed
  to combine two concepts and is retained as a negative guard.
- Drawn from 369 reports over 108 review targets. The eight are the survivors at
  the calibrated threshold; at a looser 0.15 there were 21, at 0.10 there were
  58. Nothing clustered at 0.25 or above across all 17,899 below-threshold
  findings — which is itself the measurement of how little vocabulary
  cross-model duplicates share.
- Only `ao-7536-r1` produced a "0 findings" headline. The other reports
  surfaced 7–17 findings each, so there the concept was silently omitted from an
  otherwise useful report. The inversion is real in the verified cases; the dramatic
  presentation is specific to small diffs.
