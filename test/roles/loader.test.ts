import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveRoles, buildCustomRole } from '../../src/roles/loader.js';
import { BUILTIN_ROLES } from '../../src/roles/builtin.js';
import type { Config } from '../../src/config/schema.js';

const emptyConfig: Config = {};
const RULES = '# Project rules\nUse gettext.';
const SPEC = '# Spec\nThe API returns JSON.';

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRoles — 'all' keyword", () => {
  it("['all'] returns all roles when rules and spec content exist", async () => {
    const roles = await resolveRoles(emptyConfig, ['all'], RULES, SPEC);
    expect(roles).toHaveLength(BUILTIN_ROLES.length);
  });

  it("['all'] skips content-dependent roles when their content is absent", async () => {
    const roles = await resolveRoles(emptyConfig, ['all']);
    expect(roles).toHaveLength(BUILTIN_ROLES.length - 2);
    const names = roles.map((r) => r.name);
    expect(names).not.toContain('project-rules');
    expect(names).not.toContain('spec-compliance');
  });

  it("['ALL'] is case-insensitive", async () => {
    const roles = await resolveRoles(emptyConfig, ['ALL'], RULES, SPEC);
    expect(roles).toHaveLength(BUILTIN_ROLES.length);
  });

  it("['all', 'security'] throws because 'all' cannot be combined", async () => {
    await expect(resolveRoles(emptyConfig, ['all', 'security'])).rejects.toThrow(
      "'all' cannot be combined"
    );
  });

  it("['security', 'all'] also throws", async () => {
    await expect(resolveRoles(emptyConfig, ['security', 'all'])).rejects.toThrow(
      "'all' cannot be combined"
    );
  });
});

describe('resolveRoles — content-dependent roles', () => {
  it('default resolution drops project-rules and spec-compliance without content', async () => {
    const roles = await resolveRoles(emptyConfig);
    const names = roles.map((r) => r.name);
    expect(names).not.toContain('project-rules');
    expect(names).not.toContain('spec-compliance');
  });

  it('default resolution includes them when their content exists', async () => {
    const roles = await resolveRoles(emptyConfig, undefined, RULES, SPEC);
    const names = roles.map((r) => r.name);
    expect(names).toContain('project-rules');
    expect(names).toContain('spec-compliance');
    // and the content is embedded in the role prompt (the single carrier)
    const specRole = roles.find((r) => r.name === 'spec-compliance')!;
    expect(specRole.systemPrompt).toContain('The API returns JSON.');
  });

  it('keeps an explicitly requested content-dependent role, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roles = await resolveRoles(emptyConfig, ['spec-compliance']);
    expect(roles.map((r) => r.name)).toEqual(['spec-compliance']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no spec file'));
  });
});

describe('resolveRoles — name lookup', () => {
  it('resolves role names case-insensitively', async () => {
    const roles = await resolveRoles(emptyConfig, ['Security-Auditor']);
    expect(roles.map((r) => r.name)).toEqual(['security-auditor']);
  });

  it('warns and skips unknown roles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roles = await resolveRoles(emptyConfig, ['security-auditor', 'nonexistent']);
    expect(roles).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
  });
});

describe('buildCustomRole', () => {
  it('inherits isSpecialized and description from an overridden builtin', () => {
    const role = buildCustomRole({ name: 'general', systemPrompt: 'Custom general prompt.' });
    // Forcing isSpecialized would silently demote the baseline general pass
    // from every primary model to a single round-robin slot
    expect(role.isSpecialized).toBe(false);
    expect(role.systemPrompt).toBe('Custom general prompt.');
    expect(role.description).toBe(
      BUILTIN_ROLES.find((r) => r.name === 'general')!.description
    );
  });

  it('defaults to specialized for brand-new roles', () => {
    const role = buildCustomRole({ name: 'perf-hawk', focus: ['correctness'] });
    expect(role.isSpecialized).toBe(true);
    expect(role.description).toBe('Custom role: perf-hawk');
  });
});
