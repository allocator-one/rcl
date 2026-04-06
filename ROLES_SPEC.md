# Reviewer Roles — Design Spec

## The Insight

Running the same diff through 3 different models catches different blind spots. But running the same diff through the same model with **different personas/roles** catches even more — because the framing changes what the reviewer prioritizes.

A security auditor reading code sees different things than a performance engineer reading the same code. This is true for humans AND for LLMs.

## What Changes

Today, rcl dispatches the same prompt to N models. With roles, each reviewer slot becomes a **(model, role)** pair. You can:

1. Run 3 different models with the same role (current behavior — pure cross-provider consensus)
2. Run 1 model with 3 different roles (pure persona diversity — cheap, fast)
3. Run 3 models × 2 roles = 6 reviewers (maximum coverage)
4. Mix and match: security auditor on Claude, perf engineer on GPT, Elixir expert on Gemini

## CLI Interface

```bash
# Current (unchanged) — default role is "general"
rcl review owner/repo#123

# Single role applied to all models
rcl review owner/repo#123 --role security-auditor

# Per-model roles
rcl review owner/repo#123 \
  --reviewer claude-opus:security-auditor \
  --reviewer gpt-5.4:performance-engineer \
  --reviewer gemini-3-pro:elixir-expert

# Same model, multiple roles (cheap persona diversity)
rcl review owner/repo#123 \
  --reviewer claude-sonnet:security-auditor \
  --reviewer claude-sonnet:api-design \
  --reviewer claude-sonnet:test-coverage

# Shorthand: spread roles across configured models (round-robin, shuffled)
rcl review owner/repo#123 --roles security-auditor,dx-critic
# 2 roles, 3 models → 2 runs (each role assigned to a random model)

# All built-in roles, spread across models
rcl review owner/repo#123 --roles all
# 9 roles, 3 models → 9 runs (3 roles per model, randomly assigned)

# List available built-in roles
rcl roles list

# Show role details
rcl roles show security-auditor
```

## Config

```yaml
# .review-council.yml
reviewers:
  # Explicit reviewer list (model + role pairs)
  - model: anthropic/claude-opus-4-6
    role: security-auditor
  - model: openai/gpt-5.4
    role: performance-engineer
  - model: google/gemini-3-pro
    role: general

  # Or shorthand: expand roles × models
  # models: [claude-opus, gpt-5.4]
  # roles: [security-auditor, dx-critic]
  # → 4 reviewers: claude×security, claude×dx, gpt×security, gpt×dx

roles:
  # Custom role (project-specific)
  elixir-otp-expert:
    name: "Elixir/OTP Expert"
    system: |
      You are a senior Elixir/OTP engineer with deep expertise in:
      - GenServer, Supervisor, and process architecture
      - Ecto queries, changesets, and schema design
      - Phoenix LiveView lifecycle and socket assigns
      - Oban job design and error handling
      Focus on OTP patterns, process isolation, supervision trees,
      and Elixir-specific anti-patterns. Ignore cosmetic issues.
    focus: [correctness, architecture, performance]
    severity_bias: important  # tend to rate things as important, not minor

  # Override a built-in role
  security-auditor:
    focus: [security, auth, injection, xss, csrf, idor]
    severity_bias: critical
```

## Built-in Roles

### `general` (default)
Standard code review. Looks at everything: correctness, style, security, performance, tests. No particular lens.

### `security-auditor`
Focuses exclusively on security vulnerabilities. Auth bypass, injection, XSS, CSRF, IDOR, secrets in code, unsafe deserialization. Rates security issues as critical by default. Ignores style and minor performance issues.

**System prompt addition:**
> You are a security-focused code reviewer. Your job is to find vulnerabilities, not style issues. Focus on: authentication/authorization bypass, injection attacks (SQL, XSS, command), insecure data handling, secrets/credentials in code, CSRF/IDOR, unsafe deserialization, missing input validation. Rate everything through a security lens. If it's not a security concern, skip it.

### `performance-engineer`
Focuses on runtime performance, memory allocation, N+1 queries, unnecessary computation, caching opportunities. Thinks in terms of latency, throughput, and resource usage.

**System prompt addition:**
> You are a performance-focused code reviewer. Look for: N+1 queries, unnecessary database calls, missing indexes, inefficient algorithms, excessive memory allocation, missing caching opportunities, blocking operations in hot paths, unnecessary serialization/deserialization. Ignore cosmetic issues.

### `api-design`
Reviews API contracts, backwards compatibility, error responses, pagination, naming conventions. Thinks in terms of API consumers.

**System prompt addition:**
> You are an API design reviewer. Focus on: backwards compatibility, consistent error responses, proper HTTP status codes, pagination patterns, naming conventions, request/response schema design, versioning, documentation accuracy. Consider the API consumer's perspective.

### `test-coverage`
Looks for missing test cases, untested edge cases, brittle test patterns, test isolation issues. Doesn't review the production code itself.

**System prompt addition:**
> You are a test coverage reviewer. Focus on: missing test cases for new code paths, untested edge cases (nil, empty, boundary values), test isolation issues, brittle assertions, missing error case tests, integration test gaps. Suggest specific test cases that should exist.

### `dx-critic`
Developer experience lens. Readability, naming, documentation, error messages, cognitive complexity. The "would I understand this at 2am?" reviewer.

**System prompt addition:**
> You are a developer experience critic. Focus on: confusing naming, missing documentation on non-obvious behavior, misleading error messages, high cognitive complexity, inconsistent patterns within the codebase, magic values, unclear control flow. Ask: "Would a new team member understand this?"

### `architecture`
High-level structural review. Module boundaries, coupling, dependency direction, separation of concerns. Ignores implementation details.

**System prompt addition:**
> You are an architecture reviewer. Focus on: module boundaries and coupling, dependency direction (do dependencies point the right way?), separation of concerns, abstraction leaks, God objects/modules, circular dependencies, layering violations. Ignore implementation details and style — focus on structure.

### `bug-hunter`
Looks for logic errors, edge cases, off-by-one mistakes, null/undefined paths, race conditions, and error handling gaps. The "will this crash at 3am?" reviewer.

**System prompt addition:**
> You are a bug hunter. Your job is to find logic errors that will cause runtime failures. Focus on: off-by-one errors, null/undefined dereferences, unhandled error paths, race conditions, incorrect boolean logic, missing boundary checks, type coercion bugs, integer overflow, empty collection handling. Assume every input will eventually be adversarial or unexpected.

### `accessibility-auditor`
Focuses on WCAG compliance, ARIA usage, keyboard navigation, screen reader compatibility, and color contrast. Only relevant for UI/frontend code.

**System prompt addition:**
> You are an accessibility auditor. Focus on: WCAG 2.1 AA compliance, correct ARIA roles and attributes, keyboard navigation and focus management, screen reader compatibility, color contrast ratios, alt text for images, form label associations, semantic HTML usage. If the code is not UI-related, say so and skip.

## Dispatch Model

Total runs = number of roles, NOT roles × models. Roles are **spread** across available models via shuffled round-robin:

```
9 roles, 3 models → 9 runs:
  claude  → [security-auditor, api-design, architecture]       (3 runs)
  gpt     → [performance-engineer, bug-hunter, dx-critic]      (3 runs)
  gemini  → [test-coverage, accessibility-auditor, general]     (3 runs)
```

Assignment is shuffled each run so you get different model-role pairings over time. With `--reviewer`, you override this and assign explicitly.

## How Roles Affect Consensus

The consensus engine needs to understand roles:

### Same role, different models (cross-provider consensus)
Two models with the `security-auditor` role both flag the same auth bypass → **strong consensus**. Same as today. (Only happens with `--reviewer` explicit assignment.)

### Different roles, same finding
A `security-auditor` and a `general` reviewer both flag the same issue → **cross-role consensus**. Even stronger signal — the finding is visible from multiple perspectives.

### Role-specific findings
Only the `performance-engineer` catches an N+1 query. No other reviewer flags it. → **single-reviewer finding**, but tagged with the role for context. User knows it came from a performance lens.

### Consensus scoring update

```typescript
interface ConsensusResult {
  score: number;          // how many reviewers flagged it
  total: number;          // total reviewers
  models: string[];       // which models
  roles: string[];        // which roles
  crossRole: boolean;     // flagged by reviewers with different roles?
  crossModel: boolean;    // flagged by different models?
  elevation: string;      // "none" | "cross-role" | "cross-model" | "unanimous"
}
```

**Elevation rules:**
- Same model, same role → can't consensus with itself (deduplicate, don't elevate)
- Same model, different roles → cross-role consensus (elevate)
- Different models, same role → cross-model consensus (elevate, same as today)
- Different models, different roles → maximum consensus (double elevate)

## Output Changes

Terminal output adds role attribution:

```
┌─ CRITICAL (unanimous, cross-role) ────────────────────────
│ IDOR in folder download
│ File: lib/controllers/download_controller.ex:42-55
│ 
│ Flagged by:
│   🔒 security-auditor (claude-opus)
│   📋 general (gpt-5.4)
│   🏗️  architecture (gemini-3-pro)
│
│ folder_id not validated against current user's space...
└───────────────────────────────────────────────────────────

┌─ IMPORTANT (single reviewer) ─────────────────────────────
│ N+1 query in portfolio listing
│ File: lib/explorer/queries.ex:89
│
│ Flagged by:
│   ⚡ performance-engineer (claude-opus)
│
│ Each fund loads investments in a loop...
└───────────────────────────────────────────────────────────
```

## Implementation Plan

### Phase 1: Role system (core)
1. **Role definition type** — name, system prompt, focus areas, severity bias
2. **Built-in roles** — 7 roles defined above, loaded from bundled YAML/JSON
3. **Custom roles** — loaded from `.review-council.yml`
4. **Prompt builder update** — inject role system prompt before the review prompt
5. **CLI flags** — `--role`, `--roles`, `--reviewer model:role`

### Phase 2: Consensus update
6. **Reviewer identity** — each dispatch result tagged with `{model, role}`
7. **Deduper update** — understand that same model + different role = valid consensus
8. **Voter update** — cross-role and cross-model scoring
9. **Output update** — role attribution in terminal, markdown, and JSON output

### Phase 3: Preset profiles
10. **Review profiles** — named presets like `quick` (1 model, general), `thorough` (3 models, 3 roles), `security` (2 models, security-auditor role)
11. **`rcl review --profile thorough`** shorthand

## Resolved Decisions

### CLI flag exclusivity
`--role`, `--roles`, and `--reviewer` are **mutually exclusive**. Passing more than one is a hard error:
```
Error: --role, --roles, and --reviewer are mutually exclusive. Use one:
  --role <name>              Same role for all configured models
  --roles <a>,<b>            Expand roles × configured models  
  --reviewer <model>:<role>   Explicit model:role pairs (repeatable)
```
No merging, no precedence rules. Pick one.

## Open Questions

1. **Role temperature** — should different roles use different temperatures? Security auditor might want lower temp (more deterministic), dx-critic might want higher (more creative observations). Default: inherit from model config.

2. **Role-specific output schema** — should the `test-coverage` role return a different schema (test cases instead of findings)? Or same schema with a `suggested_tests` field? Leaning toward same schema + optional field.

3. **Max reviewers** — with N models × M roles, costs scale fast. Should we cap at 6 reviewers by default? Or let the user footgun themselves? Leaning toward warning at >6, hard cap at 12.

4. **Role inheritance** — should custom roles extend built-in ones? e.g., `elixir-security` extends `security-auditor` + adds Elixir-specific checks. Nice-to-have, not MVP.
