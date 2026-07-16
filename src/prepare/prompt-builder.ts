import { readFile } from 'fs/promises';
import { stat } from 'fs/promises';
import { buildBasePrompt } from '../prompts/base.js';
import { buildSecureDiffSection } from '../prompts/hardening.js';
import { TYPESCRIPT_PROMPT_ADDITION } from '../prompts/languages/typescript.js';
import { ELIXIR_PROMPT_ADDITION } from '../prompts/languages/elixir.js';
import { PYTHON_PROMPT_ADDITION } from '../prompts/languages/python.js';
import { GENERIC_PROMPT_ADDITION } from '../prompts/languages/generic.js';
import { formatChunkForPrompt, type Chunk } from './chunker.js';
import type { Role } from '../roles/types.js';

const LANGUAGE_ADDITIONS: Record<string, string> = {
  typescript: TYPESCRIPT_PROMPT_ADDITION,
  javascript: TYPESCRIPT_PROMPT_ADDITION,
  elixir: ELIXIR_PROMPT_ADDITION,
  python: PYTHON_PROMPT_ADDITION,
};

function getLanguageAdditions(languages: Set<string>): string {
  const additions = new Set<string>();
  for (const lang of languages) {
    const addition = LANGUAGE_ADDITIONS[lang] ?? GENERIC_PROMPT_ADDITION;
    additions.add(addition);
  }
  return Array.from(additions).join('\n\n');
}

export interface PromptContext {
  contextFiles?: string[];
  specFile?: string;
}

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
}

async function loadFile(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (s.size > 200_000) {
      return `[File too large to include: ${path}]`;
    }
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Roles can declare a severity bias per category (e.g. security 1.2).
 * The scoring pipeline is deliberately bias-free — the bias becomes
 * calibration guidance in the reviewer's prompt instead.
 */
function buildSeverityBiasNote(bias?: Record<string, number>): string | null {
  if (!bias) return null;
  const parts = Object.entries(bias)
    .filter(([, factor]) => factor !== 1)
    .map(([category, factor]) =>
      factor > 1
        ? `err toward the MORE severe rating for ${category} findings`
        : `err toward the LESS severe rating for ${category} findings`
    );
  if (parts.length === 0) return null;
  return `Severity calibration: when torn between two adjacent severity levels, ${parts.join('; ')}.`;
}

export async function buildPrompt(
  chunk: Chunk,
  role: Role,
  context?: PromptContext
): Promise<BuiltPrompt> {
  // Detect languages in this chunk
  const languages = new Set(chunk.files.map((f) => f.language));
  const languageAdditions = getLanguageAdditions(languages);

  // Build system prompt from role
  const severityBiasNote = buildSeverityBiasNote(role.severityBias);
  const systemPrompt =
    role.systemPrompt +
    '\n\n' +
    languageAdditions +
    (severityBiasNote ? '\n\n' + severityBiasNote : '');

  // Load context files
  const contextDocs: Array<{ label: string; content: string }> = [];

  if (context?.contextFiles) {
    for (const filePath of context.contextFiles) {
      const content = await loadFile(filePath);
      if (content) {
        contextDocs.push({ label: filePath, content });
      }
    }
  }

  if (context?.specFile) {
    const content = await loadFile(context.specFile);
    if (content) {
      contextDocs.push({ label: `spec: ${context.specFile}`, content });
    }
  }

  // Build user prompt
  const basePrompt = buildBasePrompt();
  const diffText = formatChunkForPrompt(chunk);
  const secureSection = buildSecureDiffSection(diffText, contextDocs);

  const userPrompt = `${basePrompt}\n\n${secureSection}`;

  return { systemPrompt, userPrompt };
}
