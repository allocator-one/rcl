import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveRoles, buildCustomRole } from '../../src/roles/loader.js';
import { BUILTIN_ROLES } from '../../src/roles/builtin.js';
import type { Config } from '../../src/config/schema.js';

const emptyConfig: Config = {};
const SPEC = '# Spec\nThe API returns JSON.';

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRoles — 'all' keyword", () => {
  it("['all'] returns all roles when spec content exists", async () => {
    const roles = await resolveRoles(emptyConfig, ['all'], SPEC);
    // The coupling lens needs repository config; the rest are all built in.
    expect(roles).toHaveLength(BUILTIN_ROLES.length - 1);
  });

  it("['all'] skips content-dependent roles when their content is absent", async () => {
    const roles = await resolveRoles(emptyConfig, ['all']);
    expect(roles).toHaveLength(BUILTIN_ROLES.length - 2);
    const names = roles.map((r) => r.name);
    expect(names).not.toContain('cross-context-coupling');
    expect(names).not.toContain('project-rules');
    expect(names).not.toContain('spec-compliance');
  });

  it("['ALL'] is case-insensitive", async () => {
    const roles = await resolveRoles(emptyConfig, ['ALL'], SPEC);
    expect(roles).toHaveLength(BUILTIN_ROLES.length - 1);
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
  it('default resolution drops spec-compliance without content', async () => {
    const roles = await resolveRoles(emptyConfig);
    const names = roles.map((r) => r.name);
    expect(names).not.toContain('project-rules');
    expect(names).not.toContain('spec-compliance');
  });

  it('default resolution includes spec-compliance when spec content exists', async () => {
    const roles = await resolveRoles(emptyConfig, undefined, SPEC);
    const names = roles.map((r) => r.name);
    expect(names).not.toContain('project-rules');
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

describe('retired built-in roles', () => {
  it.each([undefined, ['all']])('excludes retired seats from %j with a specification', async (requested) => {
    const roles = await resolveRoles(emptyConfig, requested, SPEC);
    const names = roles.map((role) => role.name);
    expect(names).not.toContain('project-rules');
    expect(names).not.toContain('dead-code');
    expect(names).toContain('general');
    expect(names).toContain('spec-compliance');
    // Only the config-gated coupling lens is built in but not default.
    expect(BUILTIN_ROLES.map((role) => role.name).filter((name) => name !== 'cross-context-coupling')).toEqual(names);
  });

  it('warns and skips stale explicit names while keeping valid roles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roles = await resolveRoles(emptyConfig, ['general', 'project-rules', 'dead-code']);
    expect(roles.map((role) => role.name)).toEqual(['general']);
    expect(warn).toHaveBeenCalledWith('Warning: unknown role "project-rules", skipping');
    expect(warn).toHaveBeenCalledWith('Warning: unknown role "dead-code", skipping');
  });

  it('still accepts an explicitly configured custom role with a retired name', async () => {
    const roles = await resolveRoles({
      customRoles: [{ name: 'project-rules', systemPrompt: 'Our custom review instructions.' }],
    }, ['project-rules']);
    expect(roles).toHaveLength(1);
    expect(roles[0]!.systemPrompt).toBe('Our custom review instructions.');
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

  it('inherits from a builtin matched case-insensitively and takes its canonical name', () => {
    const role = buildCustomRole({ name: 'Security-Auditor', systemPrompt: 'custom' });
    expect(role.name).toBe('security-auditor');
    expect(role.isSpecialized).toBe(true);
  });
});

describe('resolveRoles — case-variant custom override', () => {
  it('replaces the builtin instead of coexisting with it', async () => {
    const config: Config = {
      customRoles: [{ name: 'Security-Auditor', systemPrompt: 'my custom security prompt' }],
    };
    const roles = await resolveRoles(config, ['all'], SPEC);

    const securityRoles = roles.filter((r) => r.name === 'security-auditor');
    expect(securityRoles).toHaveLength(1);
    expect(securityRoles[0]!.systemPrompt).toBe('my custom security prompt');
    // no duplicate under the mixed-case key
    expect(roles.filter((r) => r.name === 'Security-Auditor')).toHaveLength(0);
  });
});

describe('resolveRoles — cross-context coupling lens', () => {
  const couplingLens = {
    contexts: [
      { name: 'DataRoom', paths: ['lib/data_room'], modules: ['App.DataRoom'] },
      { name: 'Contacts', paths: ['lib/contacts'], modules: ['App.Contacts'] },
    ],
  };

  it('is absent from default resolution and from all without repository configuration', async () => {
    for (const requested of [undefined, ['all']]) {
      const roles = await resolveRoles(emptyConfig, requested, SPEC);
      expect(roles.map((r) => r.name)).not.toContain('cross-context-coupling');
    }
  });

  it('is part of default resolution and all once the repository configures its contexts', async () => {
    for (const requested of [undefined, ['all']]) {
      const roles = await resolveRoles({ couplingLens }, requested, SPEC);
      expect(roles.map((r) => r.name)).toContain('cross-context-coupling');
    }
  });

  it('warns when requested by name without configuration but keeps the seat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roles = await resolveRoles(emptyConfig, ['cross-context-coupling']);
    expect(roles.map((r) => r.name)).toEqual(['cross-context-coupling']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('couplingLens'));
  });

  it('does not warn when configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resolveRoles({ couplingLens }, ['cross-context-coupling']);
    expect(warn).not.toHaveBeenCalled();
  });
});
