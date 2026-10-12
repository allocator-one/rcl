import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTelemetryRuntime } from './deliver.js';
import { QUARANTINE_DIR, Quarantine } from './quarantine.js';
import { fileFailure, readStable, writeRecoveryArtifact } from './recovery/files.js';
import { applyRejectedEvidenceRecovery, planRejectedEvidenceRecovery, rejectedRecoverySink } from './rejected-recovery.js';
import { scrubText } from './scrub.js';

export interface RejectedRecoveryOptions {
  run?: string;
  manifest: string;
  apply?: boolean;
  output?: string;
  json?: boolean;
}

interface CommandDeps {
  rclVersion: string;
  dataDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

async function requireUnused(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('output_already_exists');
}

export async function runRejectedRecovery(options: RejectedRecoveryOptions, deps: CommandDeps): Promise<number> {
  try {
    if ((!options.apply && !options.run) || (options.apply && options.run) || (!options.apply && options.output)) {
      throw new Error('incompatible_recovery_options');
    }
    const manifestPath = resolve(options.manifest);
    const outputPath = options.apply ? resolve(options.output ?? `${manifestPath}.outcome-${randomUUID()}.json`) : manifestPath;
    await requireUnused(outputPath);
    const runtime = await createTelemetryRuntime({ rclVersion: deps.rclVersion, requireRepo: false });
    if (!runtime.sink) throw new Error('recovery_requires_enabled_telemetry_and_harness_login');
    const store = new Quarantine(join(resolve(deps.dataDir), QUARANTINE_DIR));
    const sink = rejectedRecoverySink(runtime.sink);
    if (!options.apply) {
      const manifest = await planRejectedEvidenceRecovery(store, options.run!, sink);
      await writeRecoveryArtifact(manifestPath, manifest);
      if (options.json) deps.stdout(JSON.stringify(manifest));
      else deps.stdout(`Dry run: prepared source-bound severity-fallback recovery for ${manifest.source.run_id}; saved ${manifestPath}. No evidence was written.`);
      return 0;
    }
    const file = await readStable(manifestPath, 8 * 1024 * 1024);
    let reviewed: unknown;
    try { reviewed = JSON.parse(file.text); } catch { throw new Error('invalid_recovery_manifest'); }
    const outcome = await applyRejectedEvidenceRecovery(reviewed, store, sink);
    await writeRecoveryArtifact(outputPath, outcome);
    if (options.json) deps.stdout(JSON.stringify(outcome));
    else deps.stdout(`Recovered ${outcome.run_id} with exact retained artifacts and zero reviewer/native-history changes; saved ${outputPath}.`);
    return 0;
  } catch (error) {
    const raw = error instanceof Error ? error.message : fileFailure(error);
    const message = /^[a-z0-9_:-]+$/.test(raw) ? raw : scrubText(raw, 200);
    deps.stderr(`Cannot recover rejected evidence: ${message}.`);
    return 2;
  }
}
