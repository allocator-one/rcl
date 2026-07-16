import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { BUILTIN_ROLES, getRoleByName } from './builtin.js';
import type { Role } from './types.js';
import type { Config } from '../config/schema.js';

const PROJECT_RULES_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'DEVELOPMENT.md',
  'docs/CONTRIBUTING.md',
];

export async function findProjectRulesFile(cwd: string = process.cwd()): Promise<string | null> {
  for (const filename of PROJECT_RULES_FILES) {
    const fullPath = join(cwd, filename);
    try {
      await access(fullPath);
      return fullPath;
    } catch {
      // not found, try next
    }
  }
  return null;
}

export async function loadProjectRulesContent(cwd?: string): Promise<string | null> {
  const filePath = await findProjectRulesFile(cwd);
  if (!filePath) return null;
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function buildCustomRole(config: {
  name: string;
  systemPrompt?: string;
  focus?: string[];
  severityBias?: Record<string, number>;
}): Role {
  // If it extends a builtin, start from that base. Dispatch-relevant fields
  // inherit from the base: forcing isSpecialized on an override of `general`
  // would silently remove the baseline pass from all primary models. Matched
  // case-insensitively so "Security-Auditor" overrides the builtin rather
  // than coexisting with it as a duplicate reviewer.
  const base = getRoleByName(config.name) ?? getRoleByName(config.name.toLowerCase());

  return {
    // Canonical builtin name when overriding, so the override replaces the
    // builtin under one map key instead of coexisting as a duplicate.
    name: base?.name ?? config.name,
    description: base?.description ?? `Custom role: ${config.name}`,
    isSpecialized: base?.isSpecialized ?? true,
    focus: config.focus ?? base?.focus ?? ['best-practices'],
    severityBias: config.severityBias ?? base?.severityBias,
    systemPrompt:
      config.systemPrompt ??
      base?.systemPrompt ??
      `You are a code reviewer with focus on: ${config.focus?.join(', ') ?? 'general quality'}.`,
  };
}

export async function resolveRoles(
  config: Config,
  requestedRoles?: string[],
  projectRulesContent?: string,
  specContent?: string
): Promise<Role[]> {
  const roles = new Map<string, Role>();

  // Add all builtin roles
  for (const role of BUILTIN_ROLES) {
    roles.set(role.name, role);
  }

  // Add custom roles from config (override builtins of the same name,
  // case-insensitively — key by the built role's canonical name)
  if (config.customRoles) {
    for (const customConfig of config.customRoles) {
      const role = buildCustomRole(customConfig);
      roles.set(role.name, role);
    }
  }

  // Augment project-rules role with actual content
  if (projectRulesContent) {
    const projectRulesRole = roles.get('project-rules')!;
    roles.set('project-rules', {
      ...projectRulesRole,
      systemPrompt:
        projectRulesRole.systemPrompt +
        '\n\n## Project Rules File Content\n\n' +
        projectRulesContent,
    });
  }

  // Augment spec-compliance role with actual spec content
  if (specContent) {
    const specRole = roles.get('spec-compliance')!;
    roles.set('spec-compliance', {
      ...specRole,
      systemPrompt:
        specRole.systemPrompt +
        '\n\n## Specification Content\n\n' +
        specContent,
    });
  }

  // Content-dependent roles without their content burn a model call and
  // invite hallucinated "violations" against imagined rules. They are
  // dropped from default/'all' expansion and kept (with a warning) only
  // when requested by name.
  const missingContent = new Set<string>();
  if (!projectRulesContent) missingContent.add('project-rules');
  if (!specContent) missingContent.add('spec-compliance');

  // Determine which roles to use
  const requested = requestedRoles ?? (config.roles as string[] | undefined);
  if (requested && requested.length > 0) {
    const hasAll = requested.some((r) => r.toLowerCase() === 'all');
    if (hasAll) {
      if (requested.length > 1) {
        throw new Error(
          `'all' cannot be combined with other roles. Got: ${requested.join(', ')}`
        );
      }
      return Array.from(roles.values()).filter((r) => !missingContent.has(r.name));
    }

    const result: Role[] = [];
    for (const name of requested) {
      const role = roles.get(name) ?? roles.get(name.toLowerCase());
      if (!role) {
        console.warn(`Warning: unknown role "${name}", skipping`);
        continue;
      }
      if (missingContent.has(role.name)) {
        const missing =
          role.name === 'project-rules' ? 'project rules file' : 'spec file';
        console.warn(
          `Warning: role "${role.name}" was requested but no ${missing} was found — it will run without that content`
        );
      }
      result.push(role);
    }
    return result;
  }

  // Default: general + all specialized (minus content-dependent roles
  // whose content is absent)
  return Array.from(roles.values()).filter((r) => !missingContent.has(r.name));
}
