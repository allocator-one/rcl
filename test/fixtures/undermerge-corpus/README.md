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
| `ao-7467-r1-nilable-decimal-spec` | allocator-one | `@spec Decimal.t()` with a reachable `nil` | 8/18 | 0.444 |
| `ao-7354-r5-trigger-label-nil-name` | allocator-one | `trigger_label/1` raises on missing/non-atom `column.name` | 7/17 | 0.412 |
| `ao-7536-r1-icon-matcher-precision` | allocator-one | unclosed prefix in a test's string matcher | 7/17 | 0.412 |
| `ao-7484-r2-aria-checked-roles` | allocator-one | `menuitemcheckbox`/`menuitemradio` not required to carry `aria-checked` | 6/15 | 0.400 |

All eight clear `minConsensusScore: 0.4` once merged, so **fixing dedup alone
is sufficient** — no threshold retuning required.

`ao-7536-r1` is the ground-truth case: hand-verified end to end, 8 findings from
8 distinct `model::role` pairs (`8/17 = 0.47`). The mining script recovered 7 of
those 8, so the table is mildly conservative rather than inflated.

`harness-cli-9` appears at both r9 and r16 of one converge loop. A loop ran at
least sixteen rounds and never surfaced a finding half its fleet reported —
recurrence detection cannot help, because the finding never entered the ledger.

## Working against these (TDD)

`undermerge-corpus.test.ts` has three layers:

1. **Characterization** — asserts today's behaviour (members split across
   groups). Passes on the buggy build; it is the baseline the fix must move.
2. **TDD target** — `it.fails` blocks asserting the members collapse into one
   group that clears `minConsensusScore`. `it.fails` passes while the body
   throws, so CI is green today and **turns red the moment dedup is fixed**.
   That is the signal to delete `.fails` and lock the behaviour in.
3. **Over-merge guard** — a plain passing test. `ao-7536-r1` carries a second,
   distinct concept at the same lines ("global log capture is brittle, prefer
   per-test `capture_log`") which is unactionable and correctly below threshold
   at 5/17. A fix that swallows it into the matcher-precision group is wrong.

So: make layer 2 fail, keep layers 1 and 3 honest, then flip the `.fails`.

The two-sided shape matters. Loosening thresholds until layer 2 passes will
break layer 3 — the corpus is built to catch that.

## Caveats

- Clusters were identified by a token-similarity proxy calibrated against the
  one hand-verified case. `ao-7354-r5` includes "lacks `@spec` typespec" and
  `ao-7467-r1` mixes nil-handling with typespec accuracy; both are plausibly two
  concepts. The four cleanest are the two `harness-cli-9` cases,
  `ao-7426-r3`, and `ao-7484-r2`.
- Drawn from 369 reports over 108 review targets. The eight are the survivors at
  the calibrated threshold; at a looser 0.15 there were 21, at 0.10 there were
  58. Nothing clustered at 0.25 or above across all 17,899 below-threshold
  findings — which is itself the measurement of how little vocabulary
  cross-model duplicates share.
- Only `ao-7536-r1` produced a "0 findings" headline. The other seven reports
  surfaced 7–17 findings each, so there the concept was silently omitted from an
  otherwise useful report. The inversion is real in all eight; the dramatic
  presentation is specific to small diffs.
