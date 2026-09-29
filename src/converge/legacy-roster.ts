import { isDeepStrictEqual } from 'node:util';
import type { Config } from '../config/schema.js';
import type { ModelProvider } from '../config/providers.js';
import type { RosterEntry } from '../report/run-header.js';

interface LegacyCatalog {
  roles: readonly string[];
  defaultVerifier: string;
  verificationReasoningEffort?: 'high';
}

const CATALOGS: Readonly<Record<string, LegacyCatalog>> = {
  '4.1.10': {
    roles: [
      'general', 'security-auditor', 'performance-engineer', 'api-design',
      'test-coverage', 'dx-critic', 'architecture', 'bug-hunter',
      'accessibility-auditor', 'project-rules', 'spec-compliance',
      'regression-hunter', 'dead-code', 'dependency-hygiene', 'edge-case-hunter',
    ],
    defaultVerifier: 'google/gemini-3.8-flash',
  },
  '4.1.11': {
    roles: [
      'general', 'security-auditor', 'performance-engineer', 'api-design',
      'test-coverage', 'dx-critic', 'architecture', 'bug-hunter',
      'accessibility-auditor', 'project-rules', 'spec-compliance',
      'regression-hunter', 'dead-code', 'dependency-hygiene', 'edge-case-hunter',
    ],
    defaultVerifier: 'google/gemini-3.8-flash',
  },
  '4.1.12': {
    roles: [
      'general', 'security-auditor', 'performance-engineer', 'api-design',
      'test-coverage', 'dx-critic', 'architecture', 'bug-hunter',
      'accessibility-auditor', 'spec-compliance', 'regression-hunter',
      'dependency-hygiene', 'edge-case-hunter',
    ],
    defaultVerifier: 'openai/gpt-6-astra',
    verificationReasoningEffort: 'high',
  },
};

interface LegacyRunIdentity {
  rcl_version: string;
  roster: RosterEntry[];
  gating: {
    mode: 'verified-consensus' | 'all-findings';
    min_models: number;
    verification_model?: string;
    verification_reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    verification_timeout_ms: number;
    verification_pass_timeout_ms?: number;
  };
  spec?: unknown;
}

function historicalProvider(model: string): ModelProvider {
  if (model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('openai/')) return 'openai';
  if (model.startsWith('google/')) return 'google';
  if (model.startsWith('openrouter/')) return 'openrouter';
  if (model.startsWith('openai-compat/')) return 'openai-compat';
  if (model.startsWith('claude')) return 'anthropic';
  if (/^(?:gpt|o1|o3|o4)/.test(model)) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  return 'openai-compat';
}

function roleDefinitions(config: Config, catalog: LegacyCatalog): Map<string, { name: string; specialized: boolean }> {
  const roles = new Map(catalog.roles.map(name => [name, { name, specialized: name !== 'general' }]));
  for (const custom of config.customRoles ?? []) {
    const builtin = roles.get(custom.name) ?? roles.get(custom.name.toLowerCase());
    const role = builtin ?? { name: custom.name, specialized: true };
    roles.set(role.name, role);
  }
  return roles;
}

function resolveRequestedRoles(config: Config, catalog: LegacyCatalog, hasSpec: boolean,
  projectRulesPresent: boolean): Array<{ name: string; specialized: boolean }> | undefined {
  const definitions = roleDefinitions(config, catalog);
  const requested = config.roles;
  if (requested && requested.length > 0) {
    const all = requested.some(name => name.toLowerCase() === 'all');
    if (all && requested.length !== 1) return undefined;
    if (all) {
      return [...definitions.values()].filter(role =>
        (role.name !== 'project-rules' || projectRulesPresent) &&
        (role.name !== 'spec-compliance' || hasSpec));
    }
    const resolved: Array<{ name: string; specialized: boolean }> = [];
    for (const name of requested) {
      const role = definitions.get(name) ?? definitions.get(name.toLowerCase());
      if (!role) return undefined;
      resolved.push(role);
    }
    return resolved.length > 0 ? resolved : undefined;
  }
  return [...definitions.values()].filter(role =>
    (role.name !== 'project-rules' || projectRulesPresent) &&
    (role.name !== 'spec-compliance' || hasSpec));
}

function historicalGating(config: Config, catalog: LegacyCatalog, rosterModels: readonly string[]) {
  const input = config.gating;
  const mode = input?.mode ?? 'verified-consensus';
  const minModels = input?.minModels ?? 2;
  if (!Number.isSafeInteger(minModels) || minModels < 2) return undefined;
  let verificationModel = input?.verificationModel;
  if (verificationModel?.startsWith('openrouter/')) return undefined;
  if (verificationModel === undefined) {
    const providers = new Set(rosterModels.map(historicalProvider));
    verificationModel = providers.has(historicalProvider(catalog.defaultVerifier))
      ? catalog.defaultVerifier
      : rosterModels.find(model => ['anthropic', 'openai', 'google'].includes(historicalProvider(model)));
  }
  const effort = input?.verificationReasoningEffort ??
    (verificationModel === catalog.defaultVerifier ? catalog.verificationReasoningEffort : undefined);
  if (effort !== undefined && (!verificationModel || historicalProvider(verificationModel) !== 'openai')) return undefined;
  const passTimeout = input?.verificationPassTimeout ?? 180_000;
  const timeout = input?.verificationTimeout ?? passTimeout;
  if (![passTimeout, timeout].every(value => Number.isFinite(value) && value > 0 && value <= 2_147_483_647)) return undefined;
  return {
    mode,
    min_models: minModels,
    ...(verificationModel ? { verification_model: verificationModel } : {}),
    ...(effort ? { verification_reasoning_effort: effort } : {}),
    verification_timeout_ms: timeout,
    verification_pass_timeout_ms: passTimeout,
  };
}

function buildRoster(config: Config, roles: Array<{ name: string; specialized: boolean }>,
  gating: ReturnType<typeof historicalGating>): RosterEntry[] | undefined {
  if (!gating) return undefined;
  const models = config.models ?? [];
  const secondaryModels = config.secondaryModels ?? [];
  const asyncModels = (config.asyncModels ?? []).filter(model => !models.includes(model));
  const definitions = new Map(roles.map(role => [role.name, role]));
  let blocking: RosterEntry[];
  if ((config.reviewers?.length ?? 0) > 0) {
    blocking = config.reviewers!.flatMap(pair => {
      const role = definitions.get(pair.role) ?? definitions.get(pair.role.toLowerCase());
      return role ? [{ model: pair.model, role: role.name, provider: historicalProvider(pair.model), lane: 'blocking' as const }] : [];
    });
    if (blocking.length === 0) return undefined;
  } else {
    const core = new Set(models);
    blocking = [];
    for (const model of models) {
      for (const role of roles.filter(candidate => !candidate.specialized)) {
        blocking.push({ model, role: role.name, provider: historicalProvider(model), lane: 'blocking' });
      }
    }
    const allModels = [...new Set([...models, ...secondaryModels])];
    if (allModels.length === 0 && roles.some(role => role.specialized)) return undefined;
    roles.filter(role => role.specialized).forEach((role, index) => {
      const model = allModels[index % allModels.length]!;
      blocking.push({ model, role: role.name, provider: historicalProvider(model),
        lane: core.has(model) ? 'blocking' : 'secondary' });
    });
  }
  const async: RosterEntry[] = config.reviewers?.length ? [] : asyncModels.flatMap(model =>
    roles.filter(role => !role.specialized).map(role => ({ model, role: role.name,
      provider: historicalProvider(model), lane: 'async' as const })));
  const verification: RosterEntry[] = gating.mode === 'verified-consensus' && gating.verification_model
    ? [{ model: gating.verification_model, role: 'verification',
      provider: historicalProvider(gating.verification_model), lane: 'verification' }]
    : [];
  return [...blocking, ...async, ...verification];
}

/** Authenticate a removed producer's deterministic roster without consulting today's role/default registry. */
export function authenticHistoricalRoster(run: LegacyRunIdentity, config: Config): boolean {
  if (!Object.hasOwn(CATALOGS, run.rcl_version)) return false;
  const catalog = CATALOGS[run.rcl_version];
  if (!catalog || !Array.isArray(run.roster) || run.roster.length === 0) return false;
  // A retained report has no authenticated source for either custom prompts or
  // explicit reviewer selection. Preserve the current-roster path for those
  // configurations, but never infer them from a historical default catalog.
  if ((config.customRoles?.length ?? 0) > 0 || (config.reviewers?.length ?? 0) > 0) return false;
  const rosterModels = [...(config.models ?? []), ...(config.secondaryModels ?? []), ...(config.asyncModels ?? [])];
  const gating = historicalGating(config, catalog, rosterModels);
  if (!gating || !isDeepStrictEqual(run.gating, gating)) return false;
  const projectVariants = catalog.roles.includes('project-rules') && !config.roles?.includes('project-rules')
    ? [false, true] : [true];
  return projectVariants.some(projectRulesPresent => {
    const roles = resolveRequestedRoles(config, catalog, run.spec !== undefined, projectRulesPresent);
    const roster = roles && buildRoster(config, roles, gating);
    return roster !== undefined && isDeepStrictEqual(run.roster, roster);
  });
}
