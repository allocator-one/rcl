import { describe, it, expect } from 'vitest';
import { buildPlanPrompt, isPlanFocus, PLAN_FOCUS_MODES } from '../../src/prompts/plan.js';
import { buildPrompt } from '../../src/prepare/prompt-builder.js';
import { OUTPUT_SCHEMA } from '../../src/prompts/base.js';
import { getRoleByName } from '../../src/roles/builtin.js';
import type { Chunk } from '../../src/prepare/chunker.js';

describe('buildPlanPrompt', () => {
  it('keeps the exact findings output contract the consensus pipeline depends on', () => {
    expect(buildPlanPrompt()).toContain(OUTPUT_SCHEMA);
  });

  it('defaults to a comprehensive review', () => {
    expect(buildPlanPrompt()).toContain('feasibility, completeness, risks, and timeline');
  });

  it.each(PLAN_FOCUS_MODES)('focus mode %s narrows the guidance', (mode) => {
    const prompt = buildPlanPrompt(mode);
    expect(prompt).toContain(mode.toUpperCase());
    expect(prompt).not.toContain('comprehensive plan review');
  });
});

describe('isPlanFocus', () => {
  it('accepts the four modes and rejects everything else', () => {
    for (const mode of PLAN_FOCUS_MODES) expect(isPlanFocus(mode)).toBe(true);
    expect(isPlanFocus('security')).toBe(false);
    expect(isPlanFocus('')).toBe(false);
  });
});

describe('buildPrompt — plan mode', () => {
  const planChunk: Chunk = {
    files: [
      {
        filename: 'docs/plan.md',
        status: 'added',
        additions: 2,
        deletions: 0,
        patch: '@@ -0,0 +1,2 @@\n+# Plan\n+Ship it.',
        language: 'plan',
      },
    ],
    totalLines: 3,
    index: 0,
    total: 1,
  };

  it('reframes the role for plan review and swaps in the plan base prompt', async () => {
    const role = getRoleByName('architecture')!;
    const { systemPrompt, userPrompt } = await buildPrompt(planChunk, role, {
      plan: { focus: 'risks' },
    });
    expect(systemPrompt).toContain('IMPLEMENTATION PLAN document, not code');
    expect(systemPrompt).toContain(role.systemPrompt);
    expect(userPrompt).toContain('Focus specifically on RISKS');
    expect(userPrompt).toContain('+# Plan');
    // Code-review base prompt must not leak into plan mode
    expect(userPrompt).not.toContain('meticulous code reviewer');
  });

  it('skips code-language prompt additions in plan mode', async () => {
    const role = getRoleByName('general')!;
    const planPrompts = await buildPrompt(planChunk, role, { plan: {} });
    expect(planPrompts.systemPrompt).not.toContain('## General Review Areas');

    const codePrompts = await buildPrompt(planChunk, role, {});
    expect(codePrompts.systemPrompt).toContain('## General Review Areas');
  });
});
