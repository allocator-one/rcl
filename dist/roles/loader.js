import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { BUILTIN_ROLES, getRoleByName } from './builtin.js';
const PROJECT_RULES_FILES = [
    'AGENTS.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    '.github/CONTRIBUTING.md',
    'DEVELOPMENT.md',
    'docs/CONTRIBUTING.md',
];
export async function findProjectRulesFile(cwd = process.cwd()) {
    for (const filename of PROJECT_RULES_FILES) {
        const fullPath = join(cwd, filename);
        try {
            await access(fullPath);
            return fullPath;
        }
        catch {
            // not found, try next
        }
    }
    return null;
}
export async function loadProjectRulesContent(cwd) {
    const filePath = await findProjectRulesFile(cwd);
    if (!filePath)
        return null;
    try {
        return await readFile(filePath, 'utf-8');
    }
    catch {
        return null;
    }
}
export function buildCustomRole(config) {
    // If it extends a builtin, start from that base
    const base = getRoleByName(config.name);
    return {
        name: config.name,
        description: `Custom role: ${config.name}`,
        isSpecialized: true,
        focus: config.focus ?? base?.focus ?? ['best-practices'],
        severityBias: config.severityBias ?? base?.severityBias,
        systemPrompt: config.systemPrompt ??
            base?.systemPrompt ??
            `You are a code reviewer with focus on: ${config.focus?.join(', ') ?? 'general quality'}.`,
    };
}
export async function resolveRoles(config, requestedRoles, projectRulesContent, specContent) {
    const roles = new Map();
    // Add all builtin roles
    for (const role of BUILTIN_ROLES) {
        roles.set(role.name, role);
    }
    // Add custom roles from config (override builtins if same name)
    if (config.customRoles) {
        for (const customConfig of config.customRoles) {
            roles.set(customConfig.name, buildCustomRole(customConfig));
        }
    }
    // Augment project-rules role with actual content
    if (projectRulesContent) {
        const projectRulesRole = roles.get('project-rules');
        roles.set('project-rules', {
            ...projectRulesRole,
            systemPrompt: projectRulesRole.systemPrompt +
                '\n\n## Project Rules File Content\n\n' +
                projectRulesContent,
        });
    }
    // Augment spec-compliance role with actual spec content
    if (specContent) {
        const specRole = roles.get('spec-compliance');
        roles.set('spec-compliance', {
            ...specRole,
            systemPrompt: specRole.systemPrompt +
                '\n\n## Specification Content\n\n' +
                specContent,
        });
    }
    // Determine which roles to use
    const requested = requestedRoles ?? config.roles;
    if (requested && requested.length > 0) {
        // "all" keyword expands to every role
        if (requested.length === 1 && requested[0] === 'all') {
            return Array.from(roles.values());
        }
        const result = [];
        for (const name of requested) {
            const role = roles.get(name);
            if (role) {
                result.push(role);
            }
            else {
                console.warn(`Warning: unknown role "${name}", skipping`);
            }
        }
        return result;
    }
    // Default: general + all specialized
    return Array.from(roles.values());
}
//# sourceMappingURL=loader.js.map