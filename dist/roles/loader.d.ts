import type { Role } from './types.js';
import type { Config } from '../config/schema.js';
export declare function findProjectRulesFile(cwd?: string): Promise<string | null>;
export declare function loadProjectRulesContent(cwd?: string): Promise<string | null>;
export declare function buildCustomRole(config: {
    name: string;
    systemPrompt?: string;
    focus?: string[];
    severityBias?: Record<string, number>;
}): Role;
export declare function resolveRoles(config: Config, requestedRoles?: string[], projectRulesContent?: string, specContent?: string): Promise<Role[]>;
