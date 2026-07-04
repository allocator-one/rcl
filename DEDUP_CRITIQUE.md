# Deduplication & Consensus Critique

A thorough review of `src/consensus/deduper.ts`, `src/consensus/voter.ts`, `src/consensus/types.ts`, and `src/config/defaults.ts`.

---

## 1. Deduper: Algorithmic Correctness & Edge Cases

### 1.1 Jaccard Similarity Is the Wrong Tool Here

The Jaccard similarity implementation has a fundamental flaw: it filters out all tokens with length ≤ 2.

```ts
.filter((t) => t.length > 2)
```

This silently drops security-critical terms like **"xss"**, **"sql"**, **"rce"**, **"dos"**, **"id"**, and common English signal words like **"no"**, **"if"**, **"is"**, **"or"**. Two findings titled `"No XSS sanitization on input"` and `"XSS sanitization missing on input"` would have the tokens `{sanitization, input}` and `{sanitization, missing, input}` respectively (after dropping "no", "xss", "on") — they'd probably still match, but only by accident. A finding about "SQL injection" would lose the "SQL" token entirely since `"sql".length === 3`... actually that one survives. But "ID" in "IDOR" contexts, "no" as a negation signal — those are gone.

**More importantly**, word-level Jaccard is order-insensitive. `"add validation before save"` and `"remove validation before save"` produce identical token bags except for "add" vs "remove" — still a high Jaccard score despite describing opposite actions. This is a dedup-merging-contradictions bug that the dispute detector won't catch because the findings are already merged into one group before dispute detection runs.

**Suggestion:** Use a 2-pass approach: (1) exact or near-exact title match + line overlap for confident merges, (2) a bigram or trigram Jaccard for fuzzy matching with a higher threshold. Alternatively, use Levenshtein or Sørensen-Dice on character n-grams which preserve ordering information.

### 1.2 Threshold of 0.3 Is Dangerously Aggressive

A Jaccard threshold of `0.3` means two findings only need 30% word overlap to be considered duplicates (after the line and category gates). Consider:

- Finding A: `"Missing input validation allows command injection via user-provided filename"`
- Finding B: `"Missing input validation for email field format"`

These share `{missing, input, validation}` out of maybe 8-9 unique tokens each. That's easily above 0.3. They'd be merged despite being completely different issues in the same file and category (`security`), potentially at overlapping line ranges if the file is small.

**Suggestion:** Raise the threshold to 0.5-0.6, or require BOTH title AND description similarity to exceed a threshold rather than using `Math.max()`. The current `Math.max(titleSim, descSim)` means a match on EITHER is enough — a short similar title can merge findings with completely different descriptions.

### 1.3 Category Gate Is Too Strict

`sameCategory()` requires exact category match. If one model categorizes a missing null check as `correctness` and another as `best-practices`, they'll never be considered duplicates — even if they point to the exact same line with nearly identical descriptions. In practice, LLMs disagree on category boundaries constantly, especially between `correctness` and `best-practices`, and between `security` and `correctness` (e.g., unchecked input — is it a correctness bug or a security hole?).

**Suggestion:** Either relax this to allow "adjacent" categories (define a category affinity matrix), or remove the category gate entirely and let Jaccard + line overlap do the filtering. The line overlap + text similarity should be sufficient to prevent false merges across unrelated categories.

### 1.4 Self-Duplicate Inflation

Nothing prevents a single model from returning the same finding multiple times in its output (LLMs do this). Each duplicate inflates `group.members.length`, which directly becomes `consensus.score` and affects all downstream confidence calculations. A model that stutters and emits the same finding 3 times looks like 3 independent confirmations.

**Suggestion:** Deduplicate within each `ModelReview` before cross-review deduplication, or at minimum deduplicate `(model, role)` pairs within each group.

### 1.5 Transitive Merging Creates Franken-Groups

Union-find enforces transitivity: if A≈B and B≈C, then A, B, and C are grouped together even if A and C are completely dissimilar. With a 0.3 Jaccard threshold and 5-line window, this creates merge chains:

```
Finding A (line 10): "Missing null check on user input"
Finding B (line 13): "Missing null check before database query"  
Finding C (line 15): "Database query missing parameterized statement"
```

A≈B (both about null checks, overlapping lines), B≈C (both mention database query, overlapping lines), so A gets merged with C despite being about null checks vs SQL injection.

**Suggestion:** After union-find grouping, validate that every member of a group has similarity ≥ threshold with the representative. If not, split the group. Alternatively, use a stricter clustering algorithm like DBSCAN or single-pass greedy with a representative-similarity check.

---

## 2. Union-Find Implementation Quality

### 2.1 No Path Compression, No Union-by-Rank

The union-find implementation is the naive textbook version with neither optimization:

```ts
let rootI = i;
while (groupOf[rootI] !== -1) rootI = groupOf[rootI]!;
```

This is O(n) per `find` in the worst case (a degenerate chain). With the O(n²) pairwise comparison loop, the total complexity is O(n³) worst case. For a large review with, say, 200 findings across 6 models, that's 40,000 pair comparisons × potentially long chain traversals.

In practice this probably doesn't matter — finding counts are likely in the tens to low hundreds — but it's still sloppy. Path compression is a one-liner:

```ts
function find(i: number): number {
  if (groupOf[i] === -1) return i;
  groupOf[i] = find(groupOf[i]!);
  return groupOf[i]!;
}
```

### 2.2 Missing Path Compression in Collection Phase

The collection phase also walks chains without compressing:

```ts
for (let i = 0; i < all.length; i++) {
  let root = i;
  while (groupOf[root] !== -1) root = groupOf[root]!;
  ...
}
```

This is a second traversal of the same chains. If you add path compression in the merge phase, this phase also benefits automatically.

### 2.3 The `-1` Sentinel Is Fine But Brittle

Using `-1` as "self-root" works but makes the code harder to reason about. A more idiomatic approach initializes `groupOf[i] = i` for all `i`, making every element its own root. The `find` termination condition becomes `groupOf[i] === i`. This is a style nit, not a bug.

---

## 3. Confidence/Consensus Scoring Calibration

### 3.1 The Relevance Score Is Philosophically Inverted

```ts
return isExpected ? 0.5 : 1.0;
```

The idea: if a non-specialist finds a security bug, it must be obvious, so it's higher signal (1.0). If a security specialist finds it, that's just them doing their job (0.5).

This is backwards for a **confidence** score. Confidence should reflect "how likely is this a real issue?" A security finding reported only by the DX critic and the test-coverage reviewer — but missed by the security-auditor — should have LOWER confidence, not higher. The "surprise signal" intuition is only valid if the specialists ALSO found it. Finding something unexpected is only high-signal when combined with specialist confirmation.

As implemented, a group where only non-specialists flagged the issue gets a relevance boost, while a group where only the specialist flagged it gets penalized. This is exactly backwards for confidence calibration.

**Suggestion:** Flip the scoring: `isExpected ? 1.0 : 0.5` — or better yet, make relevance a function of whether specialists confirmed it, not whether reporters happen to have it in their focus area. If the specialist found it AND a non-specialist found it, that's the highest signal.

### 3.2 Isolation Score Conflicts with Relevance Score

Isolation measures "what fraction of relevant reviewers flagged this." If all security-focused reviewers flagged it, isolation = 1.0. If only one did, isolation is low. This makes sense in isolation (pun intended).

But combined with the relevance score, you get contradictory signals:

- Finding flagged by 1 security-auditor out of 3 security-focused reviewers:
  - Isolation = 1/3 ≈ 0.33 (low — most specialists missed it)
  - Relevance = 0.5 (expected from specialist)
  
- Finding flagged by 1 DX-critic (non-specialist):
  - Isolation = 0/0 → 0.5 (no relevant reviewers, neutral)
  - Relevance = 1.0 (unexpected, treated as high signal)

The non-specialist-only finding gets a HIGHER combined score (0.5 × 0.3 + 1.0 × 0.3 = 0.45) than the specialist finding (0.33 × 0.3 + 0.5 × 0.3 = 0.25) on these two dimensions. The non-specialist finding with no specialist confirmation outscores the specialist finding. That's a miscalibration.

### 3.3 Diversity Score Penalizes Small Configurations

If you run RCL with 2 models and 2 roles, maximum diversity is:
- 2/2 × 0.5 + 2/2 × 0.5 = 1.0 (if both models in both roles flag it)
- 1/2 × 0.5 + 1/2 × 0.5 = 0.5 (if one model in one role flags it)

But with 6 models and 8 roles:
- 3/6 × 0.5 + 3/8 × 0.5 = 0.4375 (3 models in 3 roles — substantial agreement!)

The 3-model, 3-role agreement gets a LOWER diversity score than the 2-model, 2-role case, despite being more impressive evidence. Diversity scales inversely with configuration size, which means confidence is systematically lower for users who run more reviewers — the opposite of what should happen.

**Suggestion:** Use a sigmoid or log-scaled function: `min(1, uniqueModels / ceil(allModels / 2))` — so hitting 50%+ of models gives full diversity credit. Or use absolute thresholds: 1 model = low, 2 models = medium, 3+ models = high.

### 3.4 The Confidence Thresholds Don't Match the Formula's Range

Given the formula `diversity * 0.4 + relevance * 0.3 + isolation * 0.3`:

- **Maximum possible:** 1.0 × 0.4 + 1.0 × 0.3 + 1.0 × 0.3 = 1.0
- **Minimum possible:** 0.0 × 0.4 + 0.5 × 0.3 + 0.0 × 0.3 = 0.15

The minimum is 0.15 (because relevance floors at 0.5 for expected findings) unless a group has 0 members (impossible — every group has at least 1). So the "Low" threshold at 0.2 and "Minimal" below 0.2 are nearly unreachable. In practice, almost nothing will ever be labeled "Minimal."

With realistic inputs (diversity ≥ 1/N for N models, relevance ≥ 0.5, isolation = 0.5 default when no specialists), the practical floor is around 0.3-0.4, meaning most solo findings land right at "Medium" confidence. The scale is compressed into the 0.3-0.8 range, making the labels less discriminating than they appear.

**Suggestion:** Recalibrate thresholds based on actual score distribution, or redesign the formula to use the full 0-1 range.

### 3.5 Severity Elevation Is Overaggressive

The elevation logic bumps severity for high-confidence findings:

```ts
if (label === 'Very High' && group.members.length >= 3) {
  bumps = 2; // nitpick → important, minor → critical
  return 'unanimous';
}
```

Three models unanimously agreeing something is a **nitpick** should result in "high confidence that this is a nitpick," not elevation to **important**. The number of reporters speaks to confidence, not severity. A trailing whitespace issue flagged by 4 models is still a trailing whitespace issue.

Elevation makes sense ONLY when the finding is underreported by the original model (e.g., a model calls something "minor" but 3 other models consider it "important"). The current system doesn't check whether the reporters disagree on severity — it just blindly bumps.

**Suggestion:** Only elevate when the group contains members with DIFFERENT severity levels, and use the median or mode severity rather than the representative's severity + blind bumps. Or require that at least one member already rates it at the target severity.

---

## 4. Dispute Detection Weaknesses

### 4.1 Hardcoded Word Pairs Are Laughably Brittle

```ts
const opposingPairs = [
  ['missing', 'present'],
  ['no ', 'has '],
  ['lacks', 'has'],
  ['not ', 'is '],
  ['should add', 'should remove'],
];
```

This catches maybe 5% of actual contradictions. Missing patterns include:

- "too complex" / "too simple"
- "over-engineered" / "under-engineered"
- "unnecessary" / "necessary"
- "remove" / "keep"
- "redundant" / "required"
- "unsafe" / "safe"
- "deprecated" / "recommended"
- "too permissive" / "too restrictive"
- "hardcoded" / "configurable" (one says hardcode it, another says make it configurable)

And it completely misses semantic contradictions that don't use antonyms:
- Model A: "This function should use async/await"
- Model B: "This function correctly uses callbacks for performance"

### 4.2 Disputes Run AFTER Dedup, Missing Intra-Group Contradictions

The worst kind of dispute — two models that found the SAME location but reached OPPOSITE conclusions — gets silently merged by the deduper before dispute detection ever runs. If their titles share enough words (both mention "validation on line 42"), they're grouped together. The dispute detector only compares BETWEEN groups, never within a group.

**Suggestion:** Run contradiction checks BEFORE or DURING deduplication. If two findings at the same location have opposing sentiment, they should be kept as separate groups with a dispute flag, not merged.

### 4.3 Only Titles Are Checked

Dispute detection only examines `rep.title.toLowerCase()`. Descriptions often contain the actual contradictory recommendation:

- Title: "Input validation on user email" (both findings)
- Description A: "Should use regex validation to restrict format"
- Description B: "Should accept any string and validate server-side, client validation is a false sense of security"

Same title, opposing descriptions. Not caught.

### 4.4 Line Proximity Uses Only startLine

```ts
const lineDiff = Math.abs(other.representative.startLine - rep.startLine);
if (lineDiff > 5) continue;
```

This ignores `endLine`. A finding spanning lines 10-50 and another at line 48 have a `startLine` diff of 38, so they're not checked for disputes — despite clearly overlapping. Should use the same `linesOverlap` function from the deduper.

### 4.5 Severity Disagreements Are Not Disputes

If Model A says "critical: SQL injection on line 20" and Model B says "nitpick: consider parameterized query on line 20," they get merged (same location, similar words) and the representative is picked by highest severity. The 3-severity-level gap is invisible in the output. A genuine disagreement about severity is signal that should be surfaced.

**Suggestion:** Add severity dispersion detection within groups. If a group contains both "critical" and "nitpick" members, flag it as severity-disputed and include the spread in `disputeDetails`.

---

## 5. Structural & Architectural Issues

### 5.1 Representative Selection Loses Information

`chooseRepresentative` picks the highest-severity, longest-description finding. All other descriptions are discarded from the final output. If Model A writes a terse but precise description and Model B writes a verbose but vague one, the verbose one wins. Worse, Model B's suggested fix replaces Model A's potentially better fix.

**Suggestion:** Either include all member descriptions in the output (as `alternativeDescriptions`), or merge the best elements: highest severity, best description (by some quality metric beyond length), and aggregate suggested fixes.

### 5.2 No Handling of Partial Failures

If 4 of 6 models timeout, the 2 successful reviews get processed normally. But the confidence scores are now meaningless — diversity can never exceed 2/6 = 0.33 model diversity, so no finding can reach "High" confidence regardless of how strongly the surviving models agree. The user gets a review that looks low-confidence across the board with no indication that it's an artifact of failures.

`stats.successfulReviews` exists in `ReviewResult` but is never used in scoring or display (as far as this code shows).

**Suggestion:** Either normalize diversity against successful reviews only (the denominator should be `successfulModels.length`, not `allModels.length`), or add an explicit warning when >50% of reviews failed.

Wait — re-reading the voter code:

```ts
const allModels = [...new Set(reviews.filter((r) => r.status === 'success').map((r) => r.model))];
const allRoles = [...new Set(reviews.filter((r) => r.status === 'success').map((r) => r.role))];
```

It DOES filter to successful reviews. Good. But this means if only 1 model succeeds, diversity = 1/1 = 1.0 — perfect diversity from a single model. That's the opposite problem: single-model reviews get artificially inflated confidence. A solo review should not have maximum diversity.

**Suggestion:** Apply a minimum denominator: `Math.max(allModels.length, 2)` so a single model can't score 1.0 diversity.

### 5.3 `allModels` vs `allRoles` Double-Count

If the same model runs two different roles (e.g., `claude-fable-5` as both `general` and `security-auditor`), `allModels` will contain `claude-fable-5` once, but `allRoles` will contain both roles. A finding flagged by this model in both roles gets:
- modelDiversity = 1/1 = 1.0 (same model, but it's the only one — wait, if other models also ran, this is fine)

Actually, the issue is subtler: `allModels` deduplicates model names, `allRoles` deduplicates role names. If 3 models each run 3 roles (9 assignments), `allModels.length = 3` and `allRoles.length = 3`. If the same model flags the same finding in all 3 of its roles, uniqueModels = 1, uniqueRoles = 3, giving diversity = 1/3 × 0.5 + 3/3 × 0.5 = 0.67. That's arguably correct — high role diversity, low model diversity. But it treats 3 runs of the same model with different prompts as genuinely independent observations, which is questionable. Same weights, same architecture, same biases — the "diversity" is just prompt variation.

### 5.4 The `focus.includes()` Substring Trap

In `computeRelevance` and `computeIsolation`:

```ts
role.focus.some((f) => f.includes(category) || category.includes(f))
```

This is substring matching on category names. Today's categories are `security`, `correctness`, `best-practices`, `tests`, `api-design` — none are substrings of each other, so it works by accident. But if someone adds a category like `test-integration` or `api`, the substring match creates false positives. `"tests".includes("test")` would match, and `"api".includes("api")` trivially matches `api-design`'s focus of `["api-design"]` only if you check the other direction: `"api-design".includes("api")` → true. So a role focused on `api` would match any category containing "api."

**Suggestion:** Use exact match only (`role.focus.includes(category)`). The builtin roles already use exact category strings. The fuzzy matching adds fragility for zero benefit.

---

## 6. Concrete Improvement Suggestions

### Priority 1: Fix the Confidence Model

1. **Flip relevance scoring** — specialist confirmation should INCREASE confidence, not decrease it.
2. **Cap single-model diversity** — `Math.max(denominator, 2)` for both models and roles.
3. **Recalibrate thresholds** by running the formula against a test corpus and checking the actual distribution of scores.

### Priority 2: Fix Deduplication Accuracy

4. **Raise Jaccard threshold to 0.5** and require BOTH title AND description to exceed it (weighted average, not max).
5. **Add intra-model dedup** as a pre-pass to prevent self-duplicate inflation.
6. **Validate group coherence** post-union-find — check that all members are similar to the representative.
7. **Preserve category disagreements** — if two findings at the same line have different categories, flag it rather than refusing to merge.

### Priority 3: Fix Dispute Detection

8. **Run dispute detection BEFORE dedup** or integrate it into the dedup pass.
9. **Add severity dispersion detection** within groups.
10. **Replace hardcoded word pairs** with a severity-aware embedding similarity check, or at minimum, expand the list 10×.
11. **Use `linesOverlap()` instead of raw `startLine` diff** for consistency with the deduper.

### Priority 4: Improve Representative Selection

12. **Don't discard non-representative descriptions** — include `alternativeDescriptions: string[]` or `memberSummaries` in the output for rich findings.
13. **Consider severity consensus** for representative severity — use the mode severity across members rather than blindly taking the highest + elevation bumps.

### Priority 5: Performance & Code Quality

14. **Add path compression** to union-find. It's one line and prevents worst-case behavior.
15. **Fix the `> 2` token filter** — lower to `> 1` or use a proper stopword list.
16. **Replace substring-based focus matching** with exact equality.

---

## Summary

The dedup + consensus system has a solid high-level architecture — union-find grouping, multi-signal confidence scoring, severity elevation, dispute detection — but nearly every component has calibration issues that undermine the results:

- **The deduper is too aggressive** (low threshold, max-not-both similarity, transitive merging) and will merge distinct findings.
- **The confidence model is miscalibrated** — its relevance score is inverted, diversity penalizes larger configurations, and the score range is compressed so labels lose discriminating power.
- **Severity elevation conflates agreement with severity** — unanimous nitpicks become important findings for no good reason.
- **Dispute detection is a sketch, not a feature** — 5 hardcoded word pairs, title-only, post-dedup-only, startLine-only. It will catch almost nothing in practice.

The most impactful fix is #1 (flip relevance) + #3 (raise Jaccard threshold) + #8 (pre-dedup dispute detection). These three changes would meaningfully improve both precision and recall of the consensus system.
