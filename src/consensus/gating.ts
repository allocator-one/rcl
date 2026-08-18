import type { ConsensusFinding } from './types.js';
import type { ModelAnswer } from '../dispatch/adapter.js';
import type { FileChange } from '../resolver/types.js';
import { defaultAdapterFactory } from '../dispatch/runner.js';
import { detectProvider } from '../roles/dispatcher.js';

/**
 * Convergence gating (RCL-23). The RCL-21 audit showed why "any single
 * model's important finding blocks convergence" cannot converge: 88% of
 * gating findings were single-model and only 27% survived triage, so the
 * gating count flatlined at ~15/round forever (1 of 143 runs ever reached
 * zero). A finding now gates only if it is:
 *   (a) supported by ≥ minModels distinct models after dedup  → 'consensus'
 *   (b) critical severity                                     → 'critical'
 *   (c) single-model but unrefuted by a cheap verification
 *       pass against the actual change                        → 'verified'
 * Everything else still lands in the report — it just stops blocking
 * convergence ('none'). This is the two-stage recall→precision split
 * production review bots converged on.
 */
export type GatingReason = 'consensus' | 'critical' | 'verified' | 'none';

export interface GatingVerification {
  model: string;
  /**
   * 'refuted': the verifier showed the finding does not hold → not gating.
   * 'unrefuted': the verifier could not refute it → gates.
   * 'unavailable': the verification pass failed or did not cover this
   * finding — fail SAFE: the finding keeps gating, because a broken
   * precision filter must never greenlight unreviewed claims.
   */
  verdict: 'refuted' | 'unrefuted' | 'unavailable';
  note?: string;
}

export interface GatingInfo {
  reason: GatingReason;
  verification?: GatingVerification;
}

export type AskFn = (
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: { timeoutMs: number; maxRetries: number }
) => Promise<ModelAnswer>;

export interface GatingOptions {
  /** Distinct supporting models that make a finding 'consensus'. */
  minModels: number;
  /** Direct-API model that runs the refutation pass. */
  verificationModel: string;
  verificationTimeoutMs: number;
  /** Test seam; defaults to the verification model's own adapter. */
  ask?: AskFn;
  /** Changed files, so the verifier judges against the actual change. */
  diffFiles?: FileChange[];
}

export interface VerificationStats {
  model: string;
  candidates: number;
  refuted: number;
  unrefuted: number;
  unavailable: number;
  durationMs: number;
}

export interface GatingConfigInput {
  mode?: 'verified-consensus' | 'all-findings';
  minModels?: number;
  verificationModel?: string;
  verificationTimeout?: number;
}

export interface ResolvedGatingConfig {
  mode: 'verified-consensus' | 'all-findings';
  minModels: number;
  verificationModel: string;
  verificationTimeoutMs: number;
}

export const DEFAULT_GATING_CONFIG: ResolvedGatingConfig = {
  mode: 'verified-consensus',
  minModels: 2,
  // Fastest direct-API council member (corpus p50 well under a minute);
  // the verification pass must add ≤60s p50 to a round.
  verificationModel: 'google/gemini-3.6-flash',
  verificationTimeoutMs: 60_000,
};

export function resolveGatingConfig(input: GatingConfigInput | undefined): ResolvedGatingConfig {
  const resolved: ResolvedGatingConfig = {
    mode: input?.mode ?? DEFAULT_GATING_CONFIG.mode,
    minModels: input?.minModels ?? DEFAULT_GATING_CONFIG.minModels,
    verificationModel: input?.verificationModel ?? DEFAULT_GATING_CONFIG.verificationModel,
    verificationTimeoutMs:
      input?.verificationTimeout ?? DEFAULT_GATING_CONFIG.verificationTimeoutMs,
  };
  // The verification pass sits on the blocking path of every round — it must
  // use a direct provider API, never an aggregator with unbounded tails.
  if (resolved.verificationModel.startsWith('openrouter/')) {
    throw new Error(
      `gating.verificationModel must be a direct-API model, got "${resolved.verificationModel}"`
    );
  }
  return resolved;
}

const VERIFIER_SYSTEM_PROMPT = `You are a skeptical staff engineer double-checking code-review findings before they block a merge. For each finding, examine the provided change and try to REFUTE it: look for guards, types, tests, or context that make the claim wrong, already handled, or not applicable to this change.

Respond with ONLY a JSON array, one entry per finding id:
[{"id": "F1", "verdict": "refuted" | "confirmed", "reason": "<one line>"}]

"refuted" = the finding is wrong, already handled, or not applicable.
"confirmed" = you could not refute it; it plausibly holds against this change.
When unsure, answer "confirmed".`;

const MAX_PATCH_CHARS = 4_000;

function buildVerifierPrompt(
  candidates: ConsensusFinding[],
  diffFiles: FileChange[] | undefined
): string {
  const lines: string[] = ['## Findings to verify', ''];
  candidates.forEach((f, i) => {
    lines.push(
      `### F${i + 1}`,
      `- file: ${f.file}:${f.startLine}-${f.endLine}`,
      `- severity: ${f.severity} · category: ${f.category}`,
      `- title: ${f.title}`,
      `- claim: ${f.description}`,
      ''
    );
  });

  if (diffFiles?.length) {
    const wanted = new Set(candidates.map((f) => f.file));
    const relevant = diffFiles.filter((df) => wanted.has(df.filename));
    if (relevant.length > 0) {
      lines.push('## The change under review (relevant files)', '');
      for (const df of relevant) {
        const patch =
          df.patch.length > MAX_PATCH_CHARS
            ? `${df.patch.slice(0, MAX_PATCH_CHARS)}\n… (truncated)`
            : df.patch;
        lines.push(`### ${df.filename}`, '```diff', patch, '```', '');
      }
    }
  }
  return lines.join('\n');
}

function parseVerdicts(text: string): Map<string, { refuted: boolean; note?: string }> {
  const verdicts = new Map<string, { refuted: boolean; note?: string }>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return verdicts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return verdicts;
  }
  if (!Array.isArray(parsed)) return verdicts;
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, verdict, reason } = entry as { id?: unknown; verdict?: unknown; reason?: unknown };
    if (typeof id !== 'string') continue;
    if (verdict !== 'refuted' && verdict !== 'confirmed') continue;
    verdicts.set(id, {
      refuted: verdict === 'refuted',
      ...(typeof reason === 'string' ? { note: reason } : {}),
    });
  }
  return verdicts;
}

function defaultAsk(model: string): AskFn {
  const adapter = defaultAdapterFactory(detectProvider(model));
  return (m, systemPrompt, userPrompt, options) => adapter.ask(m, systemPrompt, userPrompt, options);
}

/**
 * Annotate every finding with its gating reason; single-model blocking
 * findings get one batched refutation call to the verification model.
 * Returns new finding objects (input is not mutated).
 */
export async function applyGating(
  findings: ConsensusFinding[],
  options: GatingOptions
): Promise<{ findings: ConsensusFinding[]; verification?: VerificationStats }> {
  const annotated: ConsensusFinding[] = new Array(findings.length);
  const candidateIndices: number[] = [];

  findings.forEach((finding, i) => {
    const blocking = finding.severity === 'critical' || finding.severity === 'important';
    if (!blocking) {
      annotated[i] = { ...finding, gating: { reason: 'none' } };
    } else if (finding.consensus.models.length >= options.minModels) {
      annotated[i] = { ...finding, gating: { reason: 'consensus' } };
    } else if (finding.severity === 'critical') {
      annotated[i] = { ...finding, gating: { reason: 'critical' } };
    } else {
      candidateIndices.push(i);
    }
  });

  if (candidateIndices.length === 0) {
    return { findings: annotated };
  }

  const candidates = candidateIndices.map((i) => findings[i]!);
  const started = Date.now();
  const ask = options.ask ?? defaultAsk(options.verificationModel);
  let verdicts = new Map<string, { refuted: boolean; note?: string }>();
  let failure: string | undefined;
  try {
    const answer = await ask(
      options.verificationModel,
      VERIFIER_SYSTEM_PROMPT,
      buildVerifierPrompt(candidates, options.diffFiles),
      { timeoutMs: options.verificationTimeoutMs, maxRetries: 1 }
    );
    if (answer.status === 'success') {
      verdicts = parseVerdicts(answer.text);
    } else {
      failure = answer.error ?? answer.status;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const stats: VerificationStats = {
    model: options.verificationModel,
    candidates: candidates.length,
    refuted: 0,
    unrefuted: 0,
    unavailable: 0,
    durationMs: Date.now() - started,
  };

  candidateIndices.forEach((findingIndex, c) => {
    const finding = findings[findingIndex]!;
    const verdict = verdicts.get(`F${c + 1}`);
    let gating: GatingInfo;
    if (verdict === undefined) {
      stats.unavailable++;
      gating = {
        reason: 'verified',
        verification: {
          model: options.verificationModel,
          verdict: 'unavailable',
          note: failure ?? 'verifier response did not cover this finding',
        },
      };
    } else if (verdict.refuted) {
      stats.refuted++;
      gating = {
        reason: 'none',
        verification: {
          model: options.verificationModel,
          verdict: 'refuted',
          ...(verdict.note ? { note: verdict.note } : {}),
        },
      };
    } else {
      stats.unrefuted++;
      gating = {
        reason: 'verified',
        verification: {
          model: options.verificationModel,
          verdict: 'unrefuted',
          ...(verdict.note ? { note: verdict.note } : {}),
        },
      };
    }
    annotated[findingIndex] = { ...finding, gating };
  });

  return { findings: annotated, verification: stats };
}
