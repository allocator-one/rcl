import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTelemetryRuntime } from '../deliver.js';
import { text } from '../../evidence/format.js';
import { inventoryRefutations } from './discovery.js';
import { fileFailure, readStable, writeRecoveryArtifact } from './files.js';
import { applyRecovery, planRecovery } from './plan.js';

export interface RefutationRecoveryOptions {
  manifest: string;
  root?: string[];
  excludeSha256?: string[];
  inventoryOnly?: boolean;
  apply?: boolean;
  output?: string;
}
interface CommandDeps {
  rclVersion: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

async function requireUnused(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error; }
  throw new Error('output_already_exists');
}

/** Recovery deliberately stays outside ordinary outbox delivery and event replay. */
export async function runRefutationRecovery(options: RefutationRecoveryOptions, deps: CommandDeps): Promise<number> {
  try {
    if ((options.apply && (options.inventoryOnly || options.root || options.excludeSha256)) || (!options.apply && options.output)) {
      throw new Error('incompatible_recovery_options');
    }
    const manifestPath = resolve(options.manifest);
    const outputPath = options.apply ? resolve(options.output ?? `${manifestPath}.outcome-${randomUUID()}.json`) : manifestPath;
    // Catch accidental reuse before authentication or any remote write. Final
    // atomic publication remains exclusive even if another process races us.
    await requireUnused(outputPath);
    if (options.inventoryOnly) {
      const inventory = await inventoryRefutations({ roots: options.root, excludeSha256: options.excludeSha256 });
      await writeRecoveryArtifact(outputPath, inventory);
      deps.stdout(`Inventoried ${inventory.reports.length} report digests; ${inventory.coverage.issues.length} discovery issues. Saved ${text(outputPath, 1000)}. This inventory cannot be applied.`);
      return 0;
    }
    const runtime = await createTelemetryRuntime({ rclVersion: deps.rclVersion, requireRepo: false });
    if (!runtime.sink) throw new Error('recovery_requires_enabled_telemetry_and_harness_login');
    if (options.apply) {
      const file = await readStable(manifestPath, 64 * 1024 * 1024);
      let reviewed: unknown;
      try { reviewed = JSON.parse(file.text); } catch { throw new Error('invalid_recovery_manifest'); }
      const outcome = await applyRecovery(reviewed, runtime.sink);
      await writeRecoveryArtifact(outputPath, outcome);
      deps.stdout(`Confirmed ${outcome.writes.runs} new historical runs and ${outcome.writes.artifacts} artifact uploads; ${outcome.server_recovery_run_ids.length} runs need server recovery. Saved ${text(outputPath, 1000)}.`);
      return outcome.reports.some((p) => ['conflict', 'unavailable', 'recover', 'upload_and_recover', 'import_history'].includes(p.action) ||
        (p.action === 'skip' && !['no_refutations', 'explicit_synthetic_exclusion'].includes(p.reason ?? ''))) ? 1 : 0;
    }
    const inventory = await inventoryRefutations({ roots: options.root, excludeSha256: options.excludeSha256 });
    const manifest = await planRecovery(inventory, runtime.sink);
    await writeRecoveryArtifact(outputPath, manifest);
    const counts = new Map<string, number>();
    for (const plan of manifest.plans) counts.set(plan.action, (counts.get(plan.action) ?? 0) + 1);
    deps.stdout(`Dry run: ${[...counts].map(([action, count]) => `${count} ${action}`).join(', ') || 'no reports'}. Saved ${text(outputPath, 1000)}. No evidence was written.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error && /^[a-z_]+(?::[a-z_]+)?$/.test(error.message) ? error.message : fileFailure(error);
    deps.stderr(`Cannot recover refutations: ${message}.`);
    return 2;
  }
}
