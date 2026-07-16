# Consensus Engine v2 — Design Spec

## Research Context

Three recent papers inform this design:

1. **Sully.ai MedCon-1** (Jun 2025) — Expert model ensemble for clinical AI. Uses weighted log opinion pools (WLOP) to merge probability distributions from specialist models. Outperforms every individual model by 8-17%.

2. **DiscoUQ** (Mar 2026, Temple University) — Shows that disagreement *structure* matters more than vote counts. A 3-to-2 split where the minority has weak evidence is very different from one where the minority found something the majority missed. Extracts features: evidence overlap, argument strength, divergence depth.

3. **"More Agents Is All You Need"** (Feb 2024, ICML) — Majority voting accuracy scales with agent count, but this is brute-force. Role diversity should be strictly better than N copies of the same prompt.

## Current Approach (v1)

```
Raw findings → Dedup (file + line + category + Jaccard >0.3) → Count votes → Rank
```

This is simple majority voting. Problems:
- Treats all agreements equally (security-auditor + general agreeing is worth more than general + general)
- Treats all disagreements equally (one reviewer finding something vs. actively contradicting another)
- Doesn't consider the *reasoning* behind findings, just surface text matching
- Denominator is total reviewers, not relevant reviewers

## New Approach (v2): Structured Consensus

### Layer 1: Dedup (unchanged, proven)

Group findings by location + semantic similarity. Same as v1:
- File path match
- Line range overlap (±5 lines)
- Category match (security, performance, etc.)
- Jaccard word similarity >0.3 on title + description

Output: clusters of related findings.

### Layer 2: Signal Scoring (new)

For each cluster, compute a **signal score** from three dimensions:

#### a) Diversity Score
How diverse are the reviewers who flagged this?

```
diversity = (unique_models / total_models) × 0.5 + (unique_roles / total_roles) × 0.5
```

- Same model, same role → 0.0 (duplicate, not signal)
- Same model, different roles → 0.5 (cross-role signal)
- Different models, same role → 0.5 (cross-model signal)
- Different models, different roles → 1.0 (maximum diversity)

#### b) Relevance Score
How relevant were the reviewers who flagged this to the finding's category?

Each role has declared `focus` areas. A security finding from a security-auditor is expected (weight 0.5). A security finding from a performance-engineer is surprising and more valuable (weight 1.0).

```
For each reviewer who flagged the finding:
  if finding.category in reviewer.role.focus → expected_weight (0.5)
  else → surprising_weight (1.0)

relevance = mean(weights)
```

Rationale: if a bug-hunter spots a security issue, that's a stronger signal than the security-auditor spotting it (the auditor was looking for it).

#### c) Isolation Score
Did any reviewer with a relevant role explicitly NOT flag this?

```
relevant_reviewers = reviewers whose role.focus includes finding.category
flagged = relevant_reviewers who found it
missed = relevant_reviewers who didn't

isolation = flagged / (flagged + missed)
```

- All relevant reviewers flagged it → isolation = 1.0 (strong)
- Only 1 of 3 relevant reviewers flagged it → isolation = 0.33 (weak — others looked and didn't see it)
- No relevant reviewers (only unexpected ones found it) → isolation = N/A, use diversity score only

### Layer 3: Confidence Rating

Combine the three scores into a confidence level:

```
raw_confidence = (diversity × 0.4) + (relevance × 0.3) + (isolation × 0.3)
```

Map to human-readable levels:

| Raw Score | Confidence | Label |
|---|---|---|
| ≥ 0.8 | 🔴 Very High | "Unanimous / cross-role consensus" |
| ≥ 0.6 | 🟠 High | "Strong agreement across reviewers" |
| ≥ 0.4 | 🟡 Medium | "Multiple reviewers flagged this" |
| ≥ 0.2 | 🔵 Low | "Single reviewer finding" |
| < 0.2 | ⚪ Minimal | "Isolated observation" |

### Layer 4: Severity Elevation

Confidence modifies severity:

- Finding severity stays as-is if confidence ≤ Medium
- Severity bumps UP one level if confidence ≥ High (important → critical)
- Severity bumps UP two levels if confidence = Very High AND ≥3 reviewers (minor → critical)
- Severity NEVER bumps down (a critical stays critical even with low confidence)

### Layer 5: Disagreement Detection (new, inspired by DiscoUQ)

When two reviewers produce **contradictory** findings about the same location:

- Reviewer A says "this is a bug"
- Reviewer B says "this pattern is correct / intentional"

Flag as **disputed** and show both perspectives. Don't auto-resolve — let the human decide.

Detection: if two findings on the same file+line range have opposing sentiment (one is a "problem" finding, another is an "acceptable pattern" / "looks correct" annotation), mark as disputed.

This requires the review prompt to allow reviewers to emit "no issue" annotations for locations they specifically reviewed and found acceptable. Today, reviewers only emit problems. Adding optional "reviewed and approved" markers lets us detect when one reviewer actively disagrees.

## Output Changes

```
┌─ CRITICAL  ■■■■■ Very High Confidence ─────────────────────
│ IDOR in folder download
│ lib/controllers/download_controller.ex:42-55
│
│ 🔒 security-auditor (claude)  — "folder_id not validated..."
│ 📋 general (gpt)              — "authorization check missing..."  
│ 📋 general (gemini)           — "no ownership verification..."
│
│ Diversity: 1.0 (3 models, 2 roles)
│ Relevance: 0.83 (unexpected from general reviewers)
│ Isolation: 1.0 (all relevant reviewers agree)
└────────────────────────────────────────────────────────────

┌─ IMPORTANT  ■■■ Medium Confidence ──────────────────────────
│ N+1 query in portfolio listing
│ lib/explorer/queries.ex:89
│
│ ⚡ performance-engineer (gpt)  — "each fund loads in a loop..."
│
│ Diversity: 0.0 (single reviewer)
│ Relevance: 0.5 (expected from perf role)
│ Isolation: 0.5 (1 of 2 relevant reviewers flagged it)
└────────────────────────────────────────────────────────────

┌─ ⚠️ DISPUTED ──────────────────────────────────────────────
│ Use of `String.to_atom/1` on user input
│ lib/parser.ex:23
│
│ 🔒 security-auditor (claude)  — "atom exhaustion attack vector"
│ 🐛 bug-hunter (gemini)        — "input is from internal enum, safe"
│
│ Reviewers disagree. Human review recommended.
└────────────────────────────────────────────────────────────
```

## Why This Is Better Than Simple Voting

| Scenario | v1 (vote counting) | v2 (structured consensus) |
|---|---|---|
| Security + general both flag IDOR | 2/3 = 67% | Very High (cross-role, unexpected from general) |
| Only perf-engineer flags N+1 | 1/3 = 33% | Medium (expected, but 1 of 2 relevant) |
| All 3 generals find a typo | 3/12 = 25% | Low (no role diversity, expected) |
| Bug-hunter finds auth issue | 1/12 = 8% | Medium (surprising from non-security role) |
| Security + bug-hunter disagree | 2/12 = 17% | DISPUTED (flagged for human review) |

The v1 denominator problem (dividing by total reviewers) made specialist findings look weak. v2 scores by diversity + relevance + isolation, which naturally handles the N-reviewer scaling problem.

---

## As-built addendum (v1.4.0)

The shipped implementation diverges from the design above on several
load-bearing points. Where the two disagree, the code is authoritative;
this section records the deviations (rationale in `DEDUP_CRITIQUE.md`).

**Line range overlap.** Findings merge when the *gap* between their line
ranges is at most `dedupeLineWindow` (default 5). The window is applied
once, not to both ranges — an earlier build expanded both sides, so a
configured window of 5 behaved as 10.

**Diversity.** Each dimension saturates at half the fleet with a floor of 2:
`min(1, unique / max(2, ceil(total/2)))`, averaged over models and roles.
Agreement from half the fleet earns full credit (3-of-6 models scores like
2-of-2), and a single successful reviewer can never score full diversity.
This replaces the plain `unique/total` formula.

**Relevance.** Specialist confirmation is gated on `role.isSpecialized`,
not on focus membership alone: the builtin `general` role lists every
category in its focus, so focus-only matching made every group score 1.0.
A group confirmed by a specialist focused on its category scores 1.0;
otherwise 0.5.

**Isolation.** "Relevant reviewers" are specialist reviewers focused on the
category (same `isSpecialized` gate), so all-focus general reviewers no
longer dilute the signal on every finding.

**Severity elevation.** Elevation only *resolves an existing disagreement*
upward — it never invents severity. Base severity is the mode of member
severities (ties to the more severe); elevation raises it at most to the
most severe level that ≥2 *distinct (model, role) reviewers* assigned, and
only at High/Very High confidence. A lone outlier rating never drives the
final severity — it surfaces as a severity-dispersion dispute. Contrary to
the original "severity NEVER bumps down", the mode can sit below a single
member's higher rating (that member's rating becomes the dispute, not the
result).

**Vote uniqueness.** Consensus score, severity counts, and the elevation
support guard all count unique `(model, role)` reviewers. The deduper
collapses same-reviewer variants that a bridge finding pulls into one group,
so a single model's repeats can't masquerade as independent confirmation.

**Layer 5 disputes.** "Reviewed and approved" annotations were not
implemented; disputes are inferred from severity dispersion (≥2 levels) and
opposing-sentiment heuristics (intra-group, and across same-location groups
gated on same category + text similarity).

**Report thresholds.** `minConfidence` and `minConsensusScore` filter the
reported findings (findings below the confidence floor or agreement ratio
are dropped; the count is surfaced in stats and the terminal summary).
