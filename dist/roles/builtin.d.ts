import type { Role } from './types.js';
export declare const BUILTIN_ROLES: Role[];
export declare function getRoleByName(name: string): Role | undefined;
export declare function getBuiltinRoleNames(): string[];
