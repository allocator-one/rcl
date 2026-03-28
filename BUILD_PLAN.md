# Review Council — Build Plan

## Phase 0: Scaffolding (Day 1)

### Repo setup
```bash
mkdir review-council && cd review-council
npm init -y
# TypeScript + ESM
npm i -D typescript @types/node tsx vitest
# Core deps
npm i zod commander chalk ora cosmiconfig
# LLM providers
npm i @anthropic-ai/sdk openai @google/genai
# Git/GitHub
npm i @octokit/rest simple-git
```

### Project structure
```
review-council/
├── src/
│   ├── index.ts                 # CLI entry (commander)
│   ├── config/
│   │   ├── schema.ts            # Zod config schema
│   │   ├── loader.ts            # cosmiconfig loader
│   │   └── defaults.ts          # Default models, thresholds
│   ├── resolver/
│   │   ├── github.ts            # Fetch PR metadata + diff via Octokit
│   │   ├── local.ts             # Read local diff/patch file
│   │   └── types.ts             # PR, Diff, FileChange types
│   ├── prepare/
│   │   ├── chunker.ts           # Split large diffs by file/hunk
│   │   ├── language.ts          # Detect language from extensions
│   │   └── prompt-builder.ts    # Build review prompt with hardening
│   ├── dispatch/
│   │   ├── adapter.ts           # Base adapter interface
│   │   ├── anthropic.ts         # Claude adapter
│   │   ├── openai.ts            # GPT adapter
│   │   ├── google.ts            # Gemini adapter
│   │   ├── openai-compat.ts     # Generic OpenAI-compatible adapter
│   │   └── runner.ts            # Parallel dispatch + timeout mgmt
│   ├── consensus/
│   │   ├── parser.ts            # Parse structured review output
│   │   ├── deduper.ts           # Match findings by file+line range
│   │   ├── voter.ts             # Score by agreement, elevate consensus
│   │   └── types.ts             # Finding, ConsensusResult types
│   ├── output/
│   │   ├── terminal.ts          # Chalk/Ora formatted output
│   │   ├── github.ts            # Post review via GitHub Reviews API
│   │   ├── json.ts              # Structured JSON export
│   │   └── markdown.ts          # Markdown report generation
│   └── prompts/
│       ├── base.ts              # Core review prompt template
│       ├── languages/            # Language-specific additions
│       │   ├── elixir.ts
│       │   ├── typescript.ts
│       │   ├── python.ts
│       │   └── generic.ts
│       └── hardening.ts         # Security boundary templates
├── action/
│   ├── action.yml               # GitHub Action definition
│   └── index.ts                 # Action entry point
├── test/
│   ├── consensus/
│   │   ├── deduper.test.ts      # Dedup by file+line
│   │   ├── voter.test.ts        # Consensus scoring
│   │   └── parser.test.ts       # Parse LLM output
│   ├── dispatch/
│   │   └── runner.test.ts       # Parallel dispatch, timeouts
│   ├── fixtures/
│   │   ├── sample-diff.patch    # Real diff for integration tests
│   │   ├── review-claude.json   # Sample Claude review output
│   │   ├── review-gpt.json      # Sample GPT review output
│   │   └── review-gemini.json   # Sample Gemini review output
│   └── e2e/
│       └── review.test.ts       # End-to-end review flow
├── .review-council.yml          # Self-referential config
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md
```

## Phase 1: Core Types + Config (Day 1-2)

### Key types (`consensus/types.ts`)
```typescript
interface Finding {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: 'critical' | 'important' | 'minor' | 'nitpick';
  category: 'security' | 'correctness' | 'best-practices' | 'tests' | 'api-design';
  title: string;
  description: string;
  suggestedFix?: string;
}

interface ModelReview {
  model: string;
  provider: string;
  findings: Finding[];
  durationMs: number;
  status: 'success' | 'timeout' | 'error';
  error?: string;
}

interface ConsensusFinding extends Finding {
  consensus: {
    score: number;        // how many models agreed
    total: number;        // total models that reviewed
    models: string[];     // which models flagged it
    elevated: boolean;    // severity was bumped by consensus
    original_severity?: string; // pre-elevation severity
  };
}

interface ReviewResult {
  pr: { owner: string; repo: string; number: number; title: string; };
  models: { model: string; status: string; durationMs: number; findingCount: number; }[];
  findings: ConsensusFinding[];
  summary: { critical: number; important: number; minor: number; nitpick: number; };
  timestamp: string;
}
```

### Config schema (`config/schema.ts`)
```typescript
const ConfigSchema = z.object({
  models: z.array(z.object({
    provider: z.enum(['anthropic', 'openai', 'google', 'openai-compat']),
    model: z.string(),
    apiKey: z.string().optional(), // falls back to env
    timeout: z.number().default(180),
    baseUrl: z.string().optional(), // for openai-compat
  })).min(1),
  review: z.object({
    focus: z.array(z.string()).default(['all']),
    language: z.string().default('auto'),
    maxDiffSize: z.number().default(100_000),
    chunkStrategy: z.enum(['by-file', 'by-hunk', 'whole']).default('by-file'),
  }).default({}),
  output: z.object({
    format: z.enum(['terminal', 'json', 'markdown', 'github-review']).default('terminal'),
    postToPr: z.boolean().default(false),
    includeModelAttribution: z.boolean().default(true),
  }).default({}),
});
```

## Phase 2: Resolver + Prompter (Day 2-3)

### GitHub resolver
- `gh pr diff NUMBER` via Octokit (or shell out to `gh` CLI)
- Parse diff into structured `FileChange[]`
- Calculate stats: files changed, lines added/removed, languages

### Prompt builder
- Base prompt: role + focus areas + output schema
- Language detection from file extensions in diff
- Security boundary wrapping for the diff content
- Output schema instruction (JSON mode):

```typescript
const OUTPUT_SCHEMA = `
Respond with a JSON array of findings. Each finding:
{
  "file": "path/to/file.ts",
  "startLine": 42,
  "endLine": 55,
  "severity": "critical|important|minor|nitpick",
  "category": "security|correctness|best-practices|tests|api-design",
  "title": "Short title",
  "description": "Detailed explanation of the issue",
  "suggestedFix": "Optional code fix or approach"
}
`;
```

## Phase 3: Provider Adapters (Day 3-4)

### Adapter interface
```typescript
interface ReviewAdapter {
  name: string;
  review(prompt: string, diff: string, options: AdapterOptions): Promise<ModelReview>;
}
```

### Implementation per provider
Each adapter:
1. Constructs the API call with provider-specific params
2. Uses JSON mode / structured output where available
3. Handles rate limits, retries (1 retry on 429/500)
4. Enforces timeout via AbortController
5. Parses response into `Finding[]`

**Critical detail**: Each provider's JSON mode works differently:
- **Anthropic**: `response_format: { type: "json" }` or tool use
- **OpenAI**: `response_format: { type: "json_object" }` or structured outputs
- **Google**: `generationConfig.responseMimeType: "application/json"`

### Parallel runner (`dispatch/runner.ts`)
```typescript
async function dispatchReviews(
  adapters: ReviewAdapter[],
  prompt: string,
  diff: string,
  options: DispatchOptions
): Promise<ModelReview[]> {
  return Promise.allSettled(
    adapters.map(adapter =>
      withTimeout(adapter.review(prompt, diff, options), options.timeout)
    )
  ).then(results => results.map(toModelReview));
}
```

## Phase 4: Consensus Engine (Day 4-6) — THE HARD PART

### Step 1: Parse reviews
Validate each `ModelReview.findings` against the Zod schema. Drop malformed entries (log warning).

### Step 2: Deduplicate by location
The core challenge: different models describe the same bug differently.

**Matching heuristics** (in order of confidence):
1. **Exact match**: Same file + overlapping line range → definite match
2. **Near match**: Same file + lines within 5 of each other → likely match
3. **Semantic match**: Same file + similar title (Levenshtein < 0.3 or cosine similarity > 0.8) → probable match
4. **Cross-file**: Different files but same title pattern → possible match (flag for review)

For v0.1, use heuristics 1+2 only. Add 3+4 in v0.2 (possibly with embeddings).

```typescript
function deduplicateFindings(reviews: ModelReview[]): DeduplicatedGroup[] {
  const groups: DeduplicatedGroup[] = [];
  
  for (const review of reviews) {
    for (const finding of review.findings) {
      const match = findMatchingGroup(groups, finding);
      if (match) {
        match.findings.push({ ...finding, model: review.model });
      } else {
        groups.push({ findings: [{ ...finding, model: review.model }] });
      }
    }
  }
  
  return groups;
}
```

### Step 3: Vote + Score
```typescript
function scoreGroup(group: DeduplicatedGroup, totalModels: number): ConsensusFinding {
  const models = [...new Set(group.findings.map(f => f.model))];
  const score = models.length;
  
  // Use highest severity from any model as base
  let severity = maxSeverity(group.findings.map(f => f.severity));
  
  // Elevate if consensus (2+ models agree)
  const elevated = score >= 2 && severity !== 'critical';
  if (elevated) severity = elevateSeverity(severity);
  
  // Merge descriptions (pick longest or combine)
  const description = mergeDescriptions(group.findings);
  
  return { ...bestFinding(group), severity, consensus: { score, total: totalModels, models, elevated } };
}
```

### Step 4: Rank + Filter
Sort by: severity (desc) → consensus score (desc) → file path (asc) → line (asc)

## Phase 5: Output (Day 6-7)

### Terminal output
```
┌─────────────────────────────────────────────────────────┐
│  Review Council — owner/repo#123                        │
│  Models: claude-opus ✅ | gpt-5.4 ✅ | gemini-3-pro ⏱  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  🚨 CRITICAL (2 findings)                               │
│                                                         │
│  1. [claude+gpt] IDOR in folder download               │
│     download_service.ex:42-55 | security                │
│     folder_id not validated against space_id...         │
│     ↑ elevated from important (2/3 consensus)           │
│                                                         │
│  2. [claude+gpt+gemini] Path traversal in zip paths    │
│     download_service.ex:78 | security                   │
│     ★ unanimous (3/3)                                   │
│                                                         │
│  ⚠️  IMPORTANT (4 findings)                             │
│  ...                                                    │
│                                                         │
│  📝 MINOR (3 findings)                                  │
│  ...                                                    │
│                                                         │
│  Summary: 2 critical, 4 important, 3 minor, 1 nitpick  │
│  Consensus: 6/10 findings flagged by 2+ models          │
└─────────────────────────────────────────────────────────┘
```

### GitHub Reviews API posting
- Use `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with:
  - `event: "COMMENT"` (don't auto-request-changes)
  - `body`: Synthesized summary with model attribution
  - `comments[]`: Inline comments on specific lines from findings

## Phase 6: CLI (Day 7-8)

```typescript
// commander setup
program
  .command('review <target>')
  .description('Review a PR or local diff')
  .option('--models <models>', 'Comma-separated model list')
  .option('--focus <areas>', 'Review focus areas')
  .option('--no-fix', 'Review only, no fix suggestions')
  .option('--post', 'Post review to PR')
  .option('--json', 'Output as JSON')
  .option('--ci', 'CI mode (reads PR from env)')
  .option('--config <path>', 'Config file path')
  .action(reviewCommand);
```

## Phase 7: Tests (Parallel with all phases)

### Unit tests (vitest)
- `deduper.test.ts`: exact match, near match, no match, cross-file
- `voter.test.ts`: consensus scoring, severity elevation, unanimous detection
- `parser.test.ts`: valid JSON, malformed JSON, partial output, empty findings
- `prompt-builder.test.ts`: language detection, security boundary insertion

### Integration tests
- Fixtures with real review outputs from each provider
- End-to-end: diff → dispatch (mocked) → consensus → output

### Key test scenarios for consensus engine:
```typescript
test('same finding from 2 models merges and elevates', () => {
  const reviews = [
    { model: 'claude', findings: [{ file: 'auth.ex', startLine: 42, severity: 'important', title: 'IDOR' }] },
    { model: 'gpt', findings: [{ file: 'auth.ex', startLine: 44, severity: 'important', title: 'Missing auth check' }] },
  ];
  const result = synthesize(reviews);
  expect(result[0].consensus.score).toBe(2);
  expect(result[0].severity).toBe('critical'); // elevated
});

test('single-model finding preserved at original severity', () => { ... });
test('3/3 unanimous marked accordingly', () => { ... });
test('contradictory findings flagged', () => { ... });
test('findings from failed models excluded', () => { ... });
```

## Timeline

| Day | What | Deliverable |
|-----|------|-------------|
| 1 | Scaffolding + types + config | Repo, TS setup, Zod schemas |
| 2 | Resolver (GitHub + local) | `rcl review` fetches diff |
| 3 | Prompt builder + hardening | Prompts with security boundaries |
| 4 | Provider adapters (3) | Claude, GPT, Gemini dispatching |
| 5 | Parallel runner | Concurrent dispatch with timeouts |
| 6 | Consensus engine | Dedup + voting + scoring |
| 7 | Terminal output | Formatted findings table |
| 8 | CLI polish + tests | `rcl review owner/repo#123` works e2e |
| 9 | GitHub posting | `--post` writes review to PR |
| 10 | README + npm publish | v0.1.0 on npm |

## Build approach

I'd recommend spawning a coding agent (Codex or Claude Code) per phase. Each phase is self-contained:
- Phase 1-2: Types + resolver (no external deps to test)
- Phase 3: Adapters (mockable, test with fixtures)
- Phase 4: Consensus (pure logic, easiest to test)
- Phase 5-6: Output + CLI (integration layer)

The consensus engine (Phase 4) is the IP — spend the most time here. Everything else is plumbing.

## Decisions needed from Michael

1. **Name**: `review-council` / `rcl`? Or one of the alternatives?
2. **Repo**: Under `allocator-one` org or new org (e.g., `review-council`)?
3. **License**: MIT (max adoption) or Apache 2.0 (patent protection)?
4. **v0.1 scope**: CLI-only or include GitHub Action from day 1?
5. **Start now or after India trip?**
