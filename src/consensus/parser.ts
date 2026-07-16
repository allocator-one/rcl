import { z } from 'zod';
import type { Finding } from './types.js';

const FindingSchema = z.object({
  // Optional with a default: models routinely omit ids, and a required id
  // used to fail the whole response (and every salvage attempt), silently
  // dropping the reviewer's entire output. Empty ids are regenerated below.
  id: z.string().optional().default(''),
  file: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  severity: z.enum(['critical', 'important', 'minor', 'nitpick']),
  category: z.enum(['security', 'correctness', 'best-practices', 'tests', 'api-design']),
  title: z.string().max(200),
  description: z.string(),
  suggestedFix: z.string().optional(),
});

const ReviewOutputSchema = z.object({
  findings: z.array(FindingSchema),
});

export interface ParseResult {
  findings: Finding[];
  warnings: string[];
}

/**
 * Candidate JSON extractions from a string that may have prose around it,
 * in decreasing order of trust: the trimmed text itself, each fenced code
 * block, then brace/bracket slices. The first candidate that parses wins —
 * an early return here used to block the fallbacks whenever output merely
 * STARTED with '{' but had trailing prose.
 */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    candidates.push(trimmed);
  }

  for (const match of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)) {
    candidates.push(match[1]!.trim());
  }

  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1));
  }

  const bracketStart = text.indexOf('[');
  const bracketEnd = text.lastIndexOf(']');
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    candidates.push(text.slice(bracketStart, bracketEnd + 1));
  }

  return candidates;
}

/** Assign stable, unique ids: empty or colliding ids are regenerated. */
function normalizeIds(findings: Finding[], model: string, role: string): Finding[] {
  const modelSlug = model.replace(/[^a-z0-9]/gi, '');
  const seen = new Set<string>();
  return findings.map((f, i) => {
    let id = f.id;
    if (!id || seen.has(id)) {
      id = `${modelSlug}_${role}_${i}`;
    }
    seen.add(id);
    return { ...f, id };
  });
}

export function parseReviewOutput(
  rawOutput: string,
  model: string,
  role: string
): ParseResult {
  const warnings: string[] = [];

  if (!rawOutput || rawOutput.trim().length === 0) {
    warnings.push(`${model}/${role}: empty output`);
    return { findings: [], warnings };
  }

  const candidates = extractJsonCandidates(rawOutput);
  if (candidates.length === 0) {
    warnings.push(`${model}/${role}: could not extract JSON from output`);
    return { findings: [], warnings };
  }

  let parsed: unknown;
  let parsedOk = false;
  let lastParseError: unknown;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parsedOk = true;
      break;
    } catch (err) {
      lastParseError = err;
    }
  }
  if (!parsedOk) {
    warnings.push(`${model}/${role}: JSON parse error: ${String(lastParseError)}`);
    return { findings: [], warnings };
  }

  // Some models emit the findings array without the wrapping object.
  if (Array.isArray(parsed)) {
    parsed = { findings: parsed };
  }

  const result = ReviewOutputSchema.safeParse(parsed);
  if (!result.success) {
    // Try to salvage individual findings
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'findings' in parsed &&
      Array.isArray((parsed as { findings: unknown }).findings)
    ) {
      const rawFindings = (parsed as { findings: unknown[] }).findings;
      const salvaged: Finding[] = [];

      for (const item of rawFindings) {
        const itemResult = FindingSchema.safeParse(item);
        if (itemResult.success) {
          salvaged.push(itemResult.data as Finding);
        } else {
          warnings.push(`${model}/${role}: dropped malformed finding: ${JSON.stringify(item).slice(0, 100)}`);
        }
      }

      if (salvaged.length > 0) {
        warnings.push(`${model}/${role}: schema validation errors (salvaged ${salvaged.length} findings)`);
        return { findings: normalizeIds(salvaged, model, role), warnings };
      }
    }

    warnings.push(
      `${model}/${role}: schema validation failed: ${result.error.issues.map((e) => e.message).join(', ')}`
    );
    return { findings: [], warnings };
  }

  return {
    findings: normalizeIds(result.data.findings as Finding[], model, role),
    warnings,
  };
}
