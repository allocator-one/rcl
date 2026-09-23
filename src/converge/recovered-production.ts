import { lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describeClaim } from '../consensus/claim-identity.js';
import type { ConsensusFinding } from '../consensus/types.js';
import type { ConvergeContext } from '../report/run-header.js';
import { ConvergeRunStateError, convergeRunStatePath, loadConvergeRunStateEvidence } from './run-state.js';
import { resolveGitCommonDir } from './attempt-budget.js';

const execFileAsync=promisify(execFile);

/** Local predecessor evidence, selected before providers; never review authority. */
export interface RecoveredProduction {
  readonly version: 1;
  readonly nativeSha256: string;
}

/** A patch review outside a repository has no canonical native target. Preserve
 * that ordinary producer while refusing every other Git discovery failure. */
export async function selectCurrentRecoveredProduction(context: ConvergeContext,cwd=process.cwd()): Promise<RecoveredProduction|undefined> {
  try {
    await execFileAsync('git',['rev-parse','--is-inside-work-tree'],{ cwd,encoding: 'utf8',timeout: 5000,env: { ...process.env,LC_ALL: 'C' } });
  } catch(error) {
    const failure=error as { code?: number; stderr?: string };
    if(failure.code===128&&failure.stderr?.trim()==='fatal: not a git repository (or any of the parent directories): .git') return undefined;
    throw new ConvergeRunStateError('Could not inspect the repository for native recovery evidence.',{ cause: error });
  }
  return selectRecoveredProduction(await resolveGitCommonDir(cwd),context);
}

/** Read and fully validate the canonical target, including every recovery source. */
export async function selectRecoveredProduction(gitCommonDir: string, context: ConvergeContext): Promise<RecoveredProduction | undefined> {
  const observed = await loadConvergeRunStateEvidence(gitCommonDir, context.target);
  if (!observed) {
    // A missing recovered state is not a new target: its retained sources are
    // evidence that ordinary fallback would discard prior identity/accounting.
    const path = convergeRunStatePath(gitCommonDir, context.target);
    for (const suffix of ['.recovery-sources', '.recovery-materials', '.evidence']) {
      try { await lstat(path + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new ConvergeRunStateError('Native recovery state unavailable; retained sources require inspection before review.');
    }
    return undefined;
  }
  if (observed.state.version === 1) return undefined;
  if (observed.state.version !== 3) throw new ConvergeRunStateError('Semantic continuation requires supported recovery of this target first.');
  const nextRound = Math.max(0, ...observed.state.rounds.map(r => r.round)) + 1;
  if (context.round !== nextRound || nextRound > observed.state.roundCap) {
    throw new ConvergeRunStateError(`Recovered target requires next round ${nextRound} within its retained cap.`);
  }
  return Object.freeze({ version: 1, nativeSha256: observed.sha256 });
}

/** Materialize all consensus members before kept/appendix partition or serialization. */
export function materializeRecoveredClaims(findings: ConsensusFinding[], mode: RecoveredProduction | undefined): ConsensusFinding[] {
  return mode ? findings.map(finding => ({ ...finding, claimDescriptor: describeClaim(finding) })) : findings;
}
