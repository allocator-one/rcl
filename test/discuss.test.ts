import { describe, it, expect } from 'vitest';
import { resolveFinding, buildDiscussPrompts, runDiscussion } from '../src/discuss.js';
import type { ReviewAdapter, ModelAnswer } from '../src/dispatch/adapter.js';
import type { ConsensusFinding, ReviewResult } from '../src/consensus/types.js';

function mkFinding(over: Partial<ConsensusFinding> = {}): ConsensusFinding {
  return {
    id: 'f001',
    file: 'src/a.ts',
    startLine: 10,
    endLine: 12,
    severity: 'important',
    category: 'security',
    title: 'SQL injection in query builder',
    description: 'User input is interpolated into the SQL string.',
    consensus: {
      score: 2,
      total: 5,
      models: ['anthropic/claude-fable-5', 'openai/gpt-5.6-sol'],
      roles: ['security-auditor', 'general'],
      crossRole: true,
      crossModel: true,
      elevated: false,
      elevation: 'none',
      confidence: 0.7,
      confidenceLabel: 'High',
      tier: 'minority',
    },
    ...over,
  };
}

function mkResult(
  findings: ConsensusFinding[],
  belowThresholdFindings?: ConsensusFinding[]
): ReviewResult {
  return {
    reviews: [],
    findings,
    ...(belowThresholdFindings ? { belowThresholdFindings } : {}),
    stats: {
      totalReviews: 5,
      successfulReviews: 5,
      totalRawFindings: findings.length,
      totalDeduped: findings.length,
      belowThreshold: belowThresholdFindings?.length ?? 0,
      durationMs: 1000,
    },
  };
}

describe('resolveFinding', () => {
  it('finds by id in kept findings', () => {
    const result = mkResult([mkFinding()]);
    expect(resolveFinding(result, 'f001').title).toContain('SQL injection');
  });

  it('finds appendix findings too', () => {
    const result = mkResult([], [mkFinding({ id: 'appendix-1', title: 'One model saw it' })]);
    expect(resolveFinding(result, 'appendix-1').title).toBe('One model saw it');
  });

  it('errors with available ids when the id is unknown', () => {
    const result = mkResult([mkFinding()]);
    expect(() => resolveFinding(result, 'nope')).toThrow(/No finding with id "nope"[\s\S]*f001/);
  });

  it('disambiguates colliding ids with :n', () => {
    const a = mkFinding({ title: 'first' });
    const b = mkFinding({ title: 'second', file: 'src/b.ts' });
    const result = mkResult([a, b]);
    expect(() => resolveFinding(result, 'f001')).toThrow(/ambiguous[\s\S]*f001:1[\s\S]*f001:2/);
    expect(resolveFinding(result, 'f001:2').title).toBe('second');
    expect(() => resolveFinding(result, 'f001:3')).toThrow(/out of range/);
  });
});

describe('buildDiscussPrompts', () => {
  it('reconstructs the finding context and asks the question', () => {
    const finding = mkFinding({ suggestedFix: 'Use parameterized queries.' });
    const { systemPrompt, userPrompt } = buildDiscussPrompts({
      finding,
      question: 'Is this exploitable given the sanitizer at line 40?',
    });
    expect(systemPrompt).toContain('changing your mind under new information is good reviewing');
    expect(userPrompt).toContain('src/a.ts (lines 10–12)');
    expect(userPrompt).toContain('SQL injection in query builder');
    expect(userPrompt).toContain('minority — flagged by anthropic/claude-fable-5, openai/gpt-5.6-sol');
    expect(userPrompt).toContain('Use parameterized queries.');
    expect(userPrompt).toContain('## Question\nIs this exploitable given the sanitizer at line 40?');
  });

  it('includes dispute details and per-model positions when disputed', () => {
    const finding = mkFinding();
    finding.consensus.disputed = true;
    finding.consensus.disputeDetails = 'Reviewers disagree on severity';
    finding.consensus.positions = [
      { model: 'm1', role: 'general', severity: 'critical', title: 'Broken', excerpt: 'Very bad.' },
    ];
    const { userPrompt } = buildDiscussPrompts({ finding, question: 'Who is right?' });
    expect(userPrompt).toContain('DISPUTED');
    expect(userPrompt).toContain('Reviewers disagree on severity');
    expect(userPrompt).toContain('m1 (general) rated critical: Broken — Very bad.');
  });

  it('attaches context docs', () => {
    const { userPrompt } = buildDiscussPrompts({
      finding: mkFinding(),
      question: 'q',
      contextDocs: [{ label: 'src/a.ts', content: 'const x = 1;' }],
    });
    expect(userPrompt).toContain('### Context: src/a.ts');
    expect(userPrompt).toContain('const x = 1;');
  });
});

describe('runDiscussion', () => {
  function fakeAdapter(provider: string, answer: (model: string) => ModelAnswer): ReviewAdapter {
    return {
      name: provider,
      provider,
      review: () => {
        throw new Error('not used');
      },
      ask: async (model) => answer(model),
    };
  }

  it('asks every model in parallel and preserves order', async () => {
    const asked: string[] = [];
    const answers = await runDiscussion(
      ['anthropic/claude-fable-5', 'openai/gpt-5.6-sol'],
      { systemPrompt: 's', userPrompt: 'u' },
      {
        timeoutMs: 1000,
        maxRetries: 0,
        adapterFactory: (provider) =>
          fakeAdapter(provider, (model) => {
            asked.push(model);
            return { model, provider, text: `answer from ${model}`, durationMs: 5, status: 'success' };
          }),
      }
    );
    expect(answers.map((a) => a.text)).toEqual([
      'answer from anthropic/claude-fable-5',
      'answer from openai/gpt-5.6-sol',
    ]);
    expect(asked).toHaveLength(2);
  });

  it('a throwing adapter factory (missing API key) yields an error answer, not a crash', async () => {
    const answers = await runDiscussion(
      ['openrouter/x/y', 'anthropic/claude-fable-5'],
      { systemPrompt: 's', userPrompt: 'u' },
      {
        timeoutMs: 1000,
        maxRetries: 0,
        adapterFactory: (provider) => {
          if (provider === 'openrouter') throw new Error('OPENROUTER_API_KEY is not set');
          return fakeAdapter(provider, (model) => ({
            model,
            provider,
            text: 'ok',
            durationMs: 5,
            status: 'success',
          }));
        },
      }
    );
    expect(answers[0]!.status).toBe('error');
    expect(answers[0]!.error).toContain('OPENROUTER_API_KEY');
    expect(answers[1]!.status).toBe('success');
  });
});
