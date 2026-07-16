import { describe, it, expect, vi } from 'vitest';
import { detectProvider, buildRoleAssignments, buildAssignments, buildExplicitAssignments } from '../../src/roles/dispatcher.js';
import type { Role } from '../../src/roles/types.js';

describe('detectProvider', () => {
  it('detects anthropic from explicit prefix', () => {
    expect(detectProvider('anthropic/claude-sonnet-4-5')).toBe('anthropic');
  });

  it('detects openai from explicit prefix', () => {
    expect(detectProvider('openai/gpt-5.4')).toBe('openai');
  });

  it('detects google from explicit prefix', () => {
    expect(detectProvider('google/gemini-2.5-pro')).toBe('google');
  });

  it('detects openai-compat from explicit prefix', () => {
    expect(detectProvider('openai-compat/local-model')).toBe('openai-compat');
  });

  it('detects anthropic by model name (legacy)', () => {
    expect(detectProvider('claude-sonnet-4-5')).toBe('anthropic');
  });

  it('detects openai by model name (legacy gpt)', () => {
    expect(detectProvider('gpt-4o')).toBe('openai');
  });

  it('detects google by model name (legacy gemini)', () => {
    expect(detectProvider('gemini-pro')).toBe('google');
  });

  it('explicit prefix beats name-based heuristic', () => {
    expect(detectProvider('google/claude-like-model')).toBe('google');
  });

  it('falls back to openai-compat for unknown model', () => {
    expect(detectProvider('unknown-model')).toBe('openai-compat');
  });
});

const generalRole: Role = {
  name: 'general',
  description: 'General review',
  isSpecialized: false,
  focus: ['correctness'],
  systemPrompt: 'Review the code.',
};

const specializedA: Role = {
  name: 'security-auditor',
  description: 'Security review',
  isSpecialized: true,
  focus: ['security'],
  systemPrompt: 'Check security.',
};

const specializedB: Role = {
  name: 'bug-hunter',
  description: 'Bug hunting',
  isSpecialized: true,
  focus: ['correctness'],
  systemPrompt: 'Find bugs.',
};

const specializedC: Role = {
  name: 'performance-engineer',
  description: 'Performance review',
  isSpecialized: true,
  focus: ['correctness'],
  systemPrompt: 'Check performance.',
};

describe('buildExplicitAssignments — failure modes', () => {
  it('throws when every reviewer pair has an unknown role', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      buildExplicitAssignments(
        [
          { model: 'claude-fable-5', role: 'typo-role' },
          { model: 'gpt-5.5', role: 'another-typo' },
        ],
        new Map([['general', generalRole]])
      )
    ).toThrow(/No valid --reviewer pairs/);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('resolves reviewer-pair role names case-insensitively', () => {
    const assignments = buildExplicitAssignments(
      [{ model: 'claude-fable-5', role: 'General' }],
      new Map([['general', generalRole]])
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.role.name).toBe('general');
  });
});

describe('buildRoleAssignments', () => {
  const primaryModels = ['anthropic/claude-fable-5', 'openai/gpt-5.5'];
  const secondaryModels = ['anthropic/claude-opus-4-8', 'openai/gpt-5.4'];
  const allRoles = [generalRole, specializedA, specializedB, specializedC];

  it('general role runs only on primary models', () => {
    const assignments = buildRoleAssignments(primaryModels, allRoles, secondaryModels);
    const generalAssignments = assignments.filter((a) => a.role.name === 'general');

    expect(generalAssignments).toHaveLength(primaryModels.length);
    const models = generalAssignments.map((a) => a.model).sort();
    expect(models).toEqual([...primaryModels].sort());
  });

  it('general role never runs on secondary models', () => {
    const assignments = buildRoleAssignments(primaryModels, allRoles, secondaryModels);
    const generalAssignments = assignments.filter((a) => a.role.name === 'general');

    for (const a of generalAssignments) {
      expect(secondaryModels).not.toContain(a.model);
    }
  });

  it('specialized roles spread across all models (primary + secondary)', () => {
    const assignments = buildRoleAssignments(primaryModels, allRoles, secondaryModels);
    const specializedAssignments = assignments.filter((a) => a.role.name !== 'general');
    const usedModels = new Set(specializedAssignments.map((a) => a.model));
    const allModels = [...primaryModels, ...secondaryModels];

    // With 3 specialized roles across 4 models, at least some models get used
    expect(specializedAssignments).toHaveLength(3);
    for (const model of usedModels) {
      expect(allModels).toContain(model);
    }
  });

  it('works with no secondary models (backwards compat)', () => {
    const assignments = buildRoleAssignments(primaryModels, allRoles);
    const generalAssignments = assignments.filter((a) => a.role.name === 'general');
    const specializedAssignments = assignments.filter((a) => a.role.name !== 'general');

    expect(generalAssignments).toHaveLength(primaryModels.length);
    expect(specializedAssignments).toHaveLength(3);
    // Specialized should only use primary models when no secondary
    for (const a of specializedAssignments) {
      expect(primaryModels).toContain(a.model);
    }
  });

  it('works with empty secondary models array', () => {
    const assignments = buildRoleAssignments(primaryModels, allRoles, []);
    const generalAssignments = assignments.filter((a) => a.role.name === 'general');

    expect(generalAssignments).toHaveLength(primaryModels.length);
  });

  it('total assignment count = primary*general + specialized', () => {
    const assignments = buildRoleAssignments(primaryModels, allRoles, secondaryModels);
    // 2 primary * 1 general + 3 specialized = 5
    expect(assignments).toHaveLength(5);
  });
});

describe('buildAssignments', () => {
  const allRoles = [generalRole, specializedA, specializedB];
  const roleMap = new Map<string, Role>(allRoles.map((r) => [r.name, r]));

  it('passes secondaryModels through to role assignments', () => {
    const assignments = buildAssignments({
      models: ['anthropic/claude-fable-5'],
      secondaryModels: ['openai/gpt-5.4'],
      roles: allRoles,
      roleMap,
    });

    const generalAssignments = assignments.filter((a) => a.role.name === 'general');
    expect(generalAssignments).toHaveLength(1);
    expect(generalAssignments[0]!.model).toBe('anthropic/claude-fable-5');
  });

  it('explicit reviewers bypass tiered dispatch', () => {
    const assignments = buildAssignments({
      models: ['anthropic/claude-fable-5'],
      secondaryModels: ['openai/gpt-5.4'],
      roles: allRoles,
      roleMap,
      explicitReviewers: [{ model: 'openai/gpt-5.4', role: 'general' }],
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.model).toBe('openai/gpt-5.4');
  });
});
