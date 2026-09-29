import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { historicalExecutionPlan, legacyPendingClaimRoles } from '../../src/converge/legacy-roster.js';
import { buildAssignments } from '../../src/roles/dispatcher.js';
import type { RosterEntry } from '../../src/report/run-header.js';

describe('historical retry execution planning', () => {
  it('reconstructs the exact A33 17-seat blocking plan instead of the current 15-seat plan', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('../fixtures/legacy-4.1.10-a33-roster.json', import.meta.url), 'utf8'
    )) as { config: Record<string, unknown>; run: { rcl_version: string; roster: RosterEntry[]; gating: any; spec: any } };
    const plan = historicalExecutionPlan(
      fixture.run as any,
      fixture.config as any,
      '# Exact project rules\nKeep historical prompts bound.\n',
      '# Exact issue specification\nKeep the roster unchanged.\n'
    );

    expect(plan?.roles.map(role => role.name)).toEqual([
      'general', 'security-auditor', 'performance-engineer', 'api-design',
      'test-coverage', 'dx-critic', 'architecture', 'bug-hunter',
      'accessibility-auditor', 'project-rules', 'spec-compliance',
      'regression-hunter', 'dead-code', 'dependency-hygiene', 'edge-case-hunter',
    ]);
    expect(plan?.roles.find(role => role.name === 'project-rules')?.systemPrompt)
      .toContain('# Exact project rules');
    expect(plan?.roles.find(role => role.name === 'spec-compliance')?.systemPrompt)
      .toContain('# Exact issue specification');
    const roleMap = new Map(plan!.roles.map(role => [role.name, role]));
    const assignments = buildAssignments({
      models: fixture.config.models as string[],
      secondaryModels: fixture.config.secondaryModels as string[],
      roles: plan!.roles,
      roleMap,
      deterministic: true,
    });
    expect(assignments.map(({ model, role, provider }) => ({ model, role: role.name, provider, lane: 'blocking' })))
      .toEqual(fixture.run.roster.filter(seat => seat.lane === 'blocking'));
    expect(plan?.gating).toMatchObject({
      verificationModel: 'google/gemini-3.8-flash',
      verificationTimeoutMs: 180_000,
      verificationPassTimeoutMs: 180_000,
    });
  });

  it('fails closed for unknown producers and bound custom prompts', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('../fixtures/legacy-4.1.10-a33-roster.json', import.meta.url), 'utf8'
    )) as any;
    expect(historicalExecutionPlan({ ...fixture.run, rcl_version: '4.1.9' }, fixture.config, 'rules', 'spec'))
      .toBeUndefined();
    expect(historicalExecutionPlan(fixture.run, {
      ...fixture.config,
      customRoles: [{ name: 'general', systemPrompt: 'unbound substitution' }],
    }, 'rules', 'spec')).toBeUndefined();
  });

  it('reconstructs the exact flawed 4.4.9 role plan separately from corrected execution', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('../fixtures/legacy-4.1.10-a33-roster.json', import.meta.url), 'utf8'
    )) as any;

    const roles = legacyPendingClaimRoles(fixture.config, '# Bound specification');

    expect(roles?.map(role => role.name)).toEqual([
      'general', 'security-auditor', 'performance-engineer', 'api-design',
      'test-coverage', 'dx-critic', 'architecture', 'bug-hunter',
      'accessibility-auditor', 'spec-compliance', 'regression-hunter',
      'dependency-hygiene', 'edge-case-hunter',
    ]);
    expect(roles?.find(role => role.name === 'spec-compliance')?.systemPrompt)
      .toContain('# Bound specification');
    expect(legacyPendingClaimRoles({ ...fixture.config,
      customRoles: [{ name: 'general', systemPrompt: 'unbound' }] }, 'spec')).toBeUndefined();
  });
});
