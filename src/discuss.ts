import { readFile } from 'fs/promises';
import { detectProvider } from './roles/dispatcher.js';
import { defaultAdapterFactory } from './dispatch/runner.js';
import type { ReviewAdapter, AdapterOptions, ModelAnswer } from './dispatch/adapter.js';
import type { ConsensusFinding, ReviewResult } from './consensus/types.js';
import type { ReasoningEffort } from './config/schema.js';

/**
 * One-shot council discussion of a single finding from a saved report
 * (`rcl review --json-file`). No session state: the finding's own report
 * entry — description, consensus, per-model positions — is the
 * reconstructed context, and each model that flagged the finding answers
 * the follow-up question independently, in parallel.
 */

export interface DiscussInput {
  result: ReviewResult;
  findingId: string;
  question: string;
  /** Override which models answer; defaults to the models that flagged it. */
  models?: string[];
  contextDocs?: Array<{ label: string; content: string }>;
}

/**
 * Resolve `--finding <id>` against kept findings first, then the
 * below-threshold appendix (appendix findings are prime discussion
 * targets — one model saw something nobody confirmed). Model-generated ids
 * can collide across reviewers, so `<id>:<n>` picks the nth match (1-based).
 */
export function resolveFinding(result: ReviewResult, findingRef: string): ConsensusFinding {
  const all = [...result.findings, ...(result.belowThresholdFindings ?? [])];

  const nthMatch = findingRef.match(/^(.+):(\d+)$/);
  const id = nthMatch ? nthMatch[1]! : findingRef;
  const matches = all.filter((f) => f.id === id);

  if (matches.length === 0) {
    const available = all
      .slice(0, 30)
      .map((f) => `  ${f.id}  ${f.file}:${f.startLine}  ${f.title.slice(0, 70)}`)
      .join('\n');
    throw new Error(
      `No finding with id "${id}" in the report. Available (first 30):\n${available}`
    );
  }

  if (matches.length === 1) return matches[0]!;

  if (nthMatch) {
    const n = parseInt(nthMatch[2]!, 10);
    const picked = matches[n - 1];
    if (!picked) {
      throw new Error(`Finding id "${id}" has ${matches.length} matches; :${n} is out of range.`);
    }
    return picked;
  }

  const candidates = matches
    .map((f, i) => `  ${id}:${i + 1}  ${f.file}:${f.startLine}  ${f.title.slice(0, 70)}`)
    .join('\n');
  throw new Error(
    `Finding id "${id}" is ambiguous (${matches.length} matches). Pick one with:\n${candidates}`
  );
}

export function buildDiscussPrompts(input: {
  finding: ConsensusFinding;
  question: string;
  contextDocs?: Array<{ label: string; content: string }>;
}): { systemPrompt: string; userPrompt: string } {
  const { finding, question, contextDocs } = input;
  const c = finding.consensus;

  const systemPrompt = `You are a reviewer on a multi-model code review council, discussing one of the council's findings with the engineer who must decide whether to act on it. Answer the question directly and concretely, grounded in the finding's context. If the question or context shows the finding is wrong, overstated, or unexploitable, say so plainly — changing your mind under new information is good reviewing, not weakness. If you lack the code context to be sure, say exactly what you would need to see. Keep the answer under 300 words.`;

  const lines: string[] = [
    '## Finding under discussion',
    '',
    `- File: ${finding.file} (lines ${finding.startLine}–${finding.endLine})`,
    `- Severity: ${finding.severity} · Category: ${finding.category}`,
    `- Council agreement: ${c.disputed ? 'DISPUTED' : c.tier} — flagged by ${c.models.join(', ')} (roles: ${c.roles.join(', ')}) · confidence ${c.confidenceLabel}`,
    `- Title: ${finding.title}`,
    '',
    finding.description,
  ];

  if (finding.suggestedFix) {
    lines.push('', '### Suggested fix on record', finding.suggestedFix);
  }

  if (c.disputed && c.disputeDetails) {
    lines.push('', `### Dispute`, c.disputeDetails);
  }
  if (c.positions?.length) {
    lines.push('', '### Positions taken by council members');
    for (const p of c.positions) {
      lines.push(`- ${p.model} (${p.role}) rated ${p.severity}: ${p.title} — ${p.excerpt}`);
    }
  }

  if (contextDocs?.length) {
    for (const doc of contextDocs) {
      lines.push('', `### Context: ${doc.label}`, '```', doc.content, '```');
    }
  }

  lines.push('', '## Question', question);

  return { systemPrompt, userPrompt: lines.join('\n') };
}

export interface DiscussOptions extends AdapterOptions {
  reasoningEffort?: ReasoningEffort;
  /** Test seam; defaults to the builtin providers. */
  adapterFactory?: (provider: string) => ReviewAdapter;
}

/** Ask every target model the same question in parallel. */
export async function runDiscussion(
  models: string[],
  prompts: { systemPrompt: string; userPrompt: string },
  options: DiscussOptions
): Promise<ModelAnswer[]> {
  const factory =
    options.adapterFactory ??
    ((provider: string) => defaultAdapterFactory(provider, options.reasoningEffort));

  return Promise.all(
    models.map(async (model): Promise<ModelAnswer> => {
      try {
        const adapter = factory(detectProvider(model));
        return await adapter.ask(model, prompts.systemPrompt, prompts.userPrompt, options);
      } catch (err) {
        // A missing API key for one provider must not sink the other answers.
        return {
          model,
          provider: detectProvider(model),
          text: '',
          durationMs: 0,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}

const MAX_CONTEXT_BYTES = 200_000;

export async function loadContextDocs(
  paths: string[]
): Promise<Array<{ label: string; content: string }>> {
  const docs: Array<{ label: string; content: string }> = [];
  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf-8');
      docs.push({
        label: path,
        content:
          Buffer.byteLength(content, 'utf-8') > MAX_CONTEXT_BYTES
            ? `${content.slice(0, MAX_CONTEXT_BYTES)}\n[truncated]`
            : content,
      });
    } catch {
      console.warn(`Warning: could not read context file: ${path}`);
    }
  }
  return docs;
}
