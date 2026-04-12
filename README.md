# review-council

> Multi-model AI code review in your terminal — many models, many roles, one consensus.

![npm](https://img.shields.io/npm/v/review-council) ![license](https://img.shields.io/npm/l/review-council) ![node](https://img.shields.io/node/v/review-council)

---

## Install

```bash
npm install -g review-council
```

Requires Node.js >= 18.

---

## Quick Start

```bash
# Review a GitHub PR with default models and roles
rcl review owner/repo#42

# Review with specific roles and post findings as a PR comment
rcl review owner/repo#42 --roles security-auditor,bug-hunter --post

# Review a local patch file; fail CI if critical/important findings exist
rcl review changes.patch --ci --markdown report.md
```

---

## Built-in Roles

| Role | Description |
|------|-------------|
| 🔍 `general` | Comprehensive review covering all dimensions |
| 🔒 `security-auditor` | Auth, injection, XSS, CSRF, IDOR, and sensitive data exposure |
| ⚡ `performance-engineer` | N+1 queries, caching, algorithmic complexity, and memory efficiency |
| 📐 `api-design` | API contracts, breaking changes, REST/gRPC conventions |
| 🧪 `test-coverage` | Missing tests, edge cases, flawed test logic |
| ✏️ `dx-critic` | Readability, naming, documentation, and developer ergonomics |
| 🏗️ `architecture` | Module boundaries, coupling, and architectural patterns |
| 🐛 `bug-hunter` | Logic errors, null paths, race conditions, off-by-one |
| ♿ `accessibility-auditor` | WCAG compliance, ARIA roles, keyboard navigation |
| 📋 `project-rules` | Enforces repo conventions from `AGENTS.md`, `CLAUDE.md`, etc. |
| 📄 `spec-compliance` | Checks implementation against a spec or plan file |

List roles in the terminal:

```bash
rcl roles list
rcl roles show security-auditor
```

---

## CLI Reference

### `rcl review <target>`

Review a PR or local diff.

**Target formats:**
- `owner/repo#N` — GitHub PR number
- GitHub PR URL
- Path to a `.patch` or `.diff` file

**Options:**

| Flag | Description |
|------|-------------|
| `--role <name>` | Use a single named role |
| `--roles <names>` | Comma-separated list of roles |
| `--reviewer <model:role>` | Explicit model:role pair (repeatable) |
| `--models <models>` | Comma-separated list of models to use |
| `--context <path>` | Context file or directory (repeatable) |
| `--spec <path>` | Specification file for `spec-compliance` role |
| `--focus <areas>` | Comma-separated focus areas |
| `--post` | Post review as a GitHub PR comment |
| `--json` | Print JSON output to stdout |
| `--json-file <path>` | Write JSON output to a file |
| `--markdown <path>` | Write Markdown report to a file |
| `--ci` | Exit non-zero if critical/important findings exist |
| `--config <path>` | Path to a config file |

`--role`, `--roles`, and `--reviewer` are mutually exclusive.

**Examples:**

```bash
# Use explicit model:role pairs
rcl review owner/repo#7 \
  --reviewer claude-opus-4-6:security-auditor \
  --reviewer gpt-5.4:bug-hunter

# Spec compliance review with context
rcl review ./feature.patch --role spec-compliance --spec SPEC.md --context src/

# Output JSON for downstream processing
rcl review owner/repo#99 --json > findings.json
```

---

### `rcl roles`

```bash
rcl roles list             # List all built-in roles
rcl roles show <name>      # Show system prompt and details for a role
```

---

## Config File

Place `.review-council.yml` in your project root (or any parent directory). All fields are optional.

```yaml
# Models to use (provider-prefixed names)
models:
  - anthropic/claude-opus-4-6
  - openai/gpt-5.4
  - google/gemini-2.5-pro

# Default roles to run
roles:
  - security-auditor
  - bug-hunter
  - test-coverage

# Or pin explicit model:role pairs
reviewers:
  - model: anthropic/claude-opus-4-6
    role: security-auditor
  - model: openai/gpt-5.4
    role: bug-hunter

# Custom role overrides (extends a built-in or creates new)
customRoles:
  - name: my-style-guide
    focus: [best-practices]
    systemPrompt: |
      Enforce our team style guide. Flag any deviation from snake_case
      variable names and require docstrings on all public functions.

# Consensus and deduplication thresholds
thresholds:
  minConsensusScore: 0.4   # 0–1; findings below this are dropped
  minConfidence: 0.2
  dedupeLineWindow: 5      # lines within which findings are merged
  jaccardThreshold: 0.3    # token-overlap threshold for deduplication

# Output defaults
output:
  markdown: true
  markdownPath: review-report.md

# Concurrency and reliability
concurrency: 6
timeout: 120000       # ms per model call
maxRetries: 3

# Context files to attach to every review
context:
  - ARCHITECTURE.md
  - docs/api.md

# Spec file for spec-compliance role
spec: SPEC.md

# GitHub token (prefer GITHUB_TOKEN env var instead)
# githubToken: ghp_...
```

Supported config file names: `.review-council.yml`, `.review-council.yaml`, `.review-council.json`, `review-council.config.js`.

---

## How Consensus Works

When multiple models and roles review the same diff, their findings are:

1. **Deduplicated** — findings on the same file, overlapping line range, and similar category are grouped together using Jaccard token overlap.
2. **Scored** — each group receives a consensus score based on three dimensions: reviewer diversity (how many distinct models and roles flagged it), role relevance (whether the reporting role specialises in that finding type), and isolation (what fraction of relevant reviewers flagged it).
3. **Classified** — groups are assigned a confidence band (Very High → Minimal) and a final severity, with upward elevation when multiple high-relevance roles agree.
4. **Filtered** — groups below `minConsensusScore` or `minConfidence` are dropped.

The result is a ranked list of findings that rewards agreement across independent reviewers and penalises noise from a single model.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Claude models |
| `OPENAI_API_KEY` | API key for OpenAI models |
| `GEMINI_API_KEY` | API key for Google Gemini models |
| `GITHUB_TOKEN` | GitHub personal access token (PR fetch and post) |
| `RCL_DEBUG` | Set to any value to print full error stack traces |

---

## License

MIT © 2026 Michael Ströck
