import { describe, it, expect } from 'vitest';
import { resolveRoles } from '../../src/roles/loader.js';
import { BUILTIN_ROLES } from '../../src/roles/builtin.js';
import type { Config } from '../../src/config/schema.js';

const emptyConfig: Config = {};

describe("resolveRoles — 'all' keyword", () => {
  it("['all'] returns all roles", async () => {
    const roles = await resolveRoles(emptyConfig, ['all']);
    expect(roles).toHaveLength(BUILTIN_ROLES.length);
  });

  it("['ALL'] returns all roles (case-insensitive)", async () => {
    const roles = await resolveRoles(emptyConfig, ['ALL']);
    expect(roles).toHaveLength(BUILTIN_ROLES.length);
  });

  it("['All'] returns all roles (mixed case)", async () => {
    const roles = await resolveRoles(emptyConfig, ['All']);
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
