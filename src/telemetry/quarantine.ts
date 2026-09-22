import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ArtifactBytes, RunEnvelope } from './envelope.js';
import { declareArtifacts } from './envelope.js';
import type { EvidenceDiagnostic } from './envelope-validation.js';
import type { WireEvent } from './events.js';
import { fileFailure, platformPath, readStable, writeRecoveryArtifact } from './recovery/files.js';
import { scrubText } from './scrub.js';

export const QUARANTINE_DIR = 'quarantine';
export const DEFAULT_QUARANTINE_CAP_BYTES = 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i;
const FILES = { report_json: 'report.json', report_md: 'report.md' } as const;
const digest = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
const storedFile = (file: string) => z.object({ file: z.literal(file), sha256: digest, bytes: z.number().int().nonnegative() }).strict();
const snapshotSchema = z.object({
  version: z.literal(1), run_id: z.string().regex(UUID),
  requested_mode: z.enum(['asserted', 'attested']), acknowledged: z.boolean(),
  artifacts: z.object({ report_json: storedFile('report.json'), report_md: storedFile('report.md').optional() }).strict(),
  envelope: storedFile('envelope.json').optional(), events: storedFile('events.json'),
  diagnostics: z.array(z.object({ path: z.string().max(200), message: z.string().max(300) }).strict()).max(20),
}).strict();
const manifestSchema = snapshotSchema.extend({ retained_at: z.iso.datetime() });
type QuarantineObservation = z.infer<typeof snapshotSchema>;

export interface RetentionOutcome {
  status: 'complete' | 'failed';
  path?: string;
  error?: string;
}

export interface QuarantineInput {
  runId: string;
  artifacts: ArtifactBytes;
  envelope?: RunEnvelope;
  events: WireEvent[];
  requestedMode: 'asserted' | 'attested';
  acknowledged: boolean;
  diagnostics: EvidenceDiagnostic[];
}

export interface QuarantineManifest {
  version: 1;
  run_id: string;
  retained_at: string;
  requested_mode: 'asserted' | 'attested';
  acknowledged: boolean;
  artifacts: Record<string, { file: string; sha256: string; bytes: number }>;
  envelope?: { file: string; sha256: string; bytes: number };
  events: { file: string; sha256: string; bytes: number };
  diagnostics: EvidenceDiagnostic[];
}

export interface QuarantineEntry {
  runId: string;
  path: string;
  status: 'complete' | 'incomplete' | 'unreadable';
  manifest?: QuarantineManifest;
  /** Distinct later delivery observations; these do not replace the original acknowledgment snapshot. */
  observations?: QuarantineObservation[];
  error?: string;
}

function declaration(file: string, bytes: string) {
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) };
}

async function durableFile(path: string, bytes: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Immutable local recovery inputs, outside the auto-flushed outbox. A directory
 * is reserved exclusively before writing; a complete manifest is published last.
 * Interrupted entries stay visible, and retries never overwrite their bytes.
 */
export class Quarantine {
  readonly dir: string;
  constructor(dir: string, readonly capBytes = DEFAULT_QUARANTINE_CAP_BYTES) { this.dir = platformPath(resolve(dir)); }

  private entryPath(runId: string): string {
    if (!UUID.test(runId)) throw new Error('invalid_run_id');
    return join(this.dir, runId.toLowerCase());
  }

  async retain(input: QuarantineInput): Promise<RetentionOutcome> {
    let path: string | undefined;
    try {
      path = this.entryPath(input.runId);
      const artifacts = Object.fromEntries(declareArtifacts(input.artifacts).map((d) => [d.kind, { file: FILES[d.kind], sha256: d.sha256, bytes: d.bytes }]));
      const envelopeBytes = input.envelope === undefined ? undefined : JSON.stringify(input.envelope);
      const eventBytes = JSON.stringify(input.events);
      const manifest: QuarantineManifest = {
        version: 1, run_id: input.runId, retained_at: new Date().toISOString(),
        requested_mode: input.requestedMode, acknowledged: input.acknowledged, artifacts,
        ...(envelopeBytes === undefined ? {} : { envelope: declaration('envelope.json', envelopeBytes) }),
        events: declaration('events.json', eventBytes),
        diagnostics: input.diagnostics.slice(0, 20).map((d) => ({
          path: scrubText(d.path.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), 200),
          message: scrubText(d.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), 300),
        })),
      };
      manifestSchema.parse(manifest);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      if (await realpath(this.dir) !== this.dir) throw new Error('symlink_directory');
      const existing = await this.inspect(input.runId);
      if (existing) {
        if (existing.status !== 'complete') throw new Error('existing_retention_incomplete');
        const old = existing.manifest!;
        if (JSON.stringify(old.artifacts) !== JSON.stringify(manifest.artifacts) ||
            old.envelope?.sha256 !== manifest.envelope?.sha256 || old.events.sha256 !== manifest.events.sha256 ||
            old.requested_mode !== manifest.requested_mode) throw new Error('retained_evidence_conflict');
        if (old.acknowledged !== manifest.acknowledged || JSON.stringify(old.diagnostics) !== JSON.stringify(manifest.diagnostics)) {
          const { retained_at: _time, ...observation } = manifest;
          const bytes = JSON.stringify(observation, null, 2) + '\n';
          const name = `observation-${createHash('sha256').update(bytes).digest('hex')}.json`;
          const destination = join(path, name);
          let prior: Awaited<ReturnType<typeof readStable>> | undefined;
          try { prior = await readStable(destination, 64_000); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (prior) {
            if (prior.text !== bytes) throw new Error('retained_evidence_conflict');
          } else {
            if (Buffer.byteLength(bytes) + await this.totalBytes() > this.capBytes) throw new Error('quarantine_over_cap');
            try { await writeRecoveryArtifact(destination, observation); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readStable(destination, 64_000)).text !== bytes) throw error;
            }
            await syncDirectory(path);
          }
        }
        return { status: 'complete', path };
      }
      const bytes = Object.values(artifacts).reduce((sum, a) => sum + a.bytes, 0) + Buffer.byteLength(envelopeBytes ?? '') + Buffer.byteLength(eventBytes) + 2 * Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n');
      if (bytes + await this.totalBytes() > this.capBytes) throw new Error('quarantine_over_cap');
      await mkdir(path, { mode: 0o700 });
      await writeRecoveryArtifact(join(path, 'pending.json'), manifest);
      await syncDirectory(this.dir);
      await durableFile(join(path, FILES.report_json), input.artifacts.report_json);
      if (input.artifacts.report_md !== undefined) await durableFile(join(path, FILES.report_md), input.artifacts.report_md);
      if (envelopeBytes !== undefined) await durableFile(join(path, 'envelope.json'), envelopeBytes);
      await durableFile(join(path, 'events.json'), eventBytes);
      await writeRecoveryArtifact(join(path, 'manifest.json'), manifest);
      await syncDirectory(path);
      await syncDirectory(this.dir);
      return { status: 'complete', path };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const known = ['invalid_run_id', 'symlink_directory', 'existing_retention_incomplete', 'retained_evidence_conflict', 'quarantine_over_cap'];
      return { status: 'failed', ...(path ? { path } : {}), error: known.includes(message) ? message : fileFailure(error) };
    }
  }

  /** Read and verify an explicitly selected original; this performs no writes or delivery. */
  async inspect(runId: string): Promise<QuarantineEntry | undefined> {
    const path = this.entryPath(runId);
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('symlink_directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return { runId, path, status: 'unreadable', error: fileFailure(error) };
    }
    try {
      const original = await readStable(join(path, 'manifest.json'), 64_000);
      const pending = await readStable(join(path, 'pending.json'), 64_000);
      const manifest = manifestSchema.parse(JSON.parse(original.text));
      if (original.sha256 !== pending.sha256 || manifest.run_id.toLowerCase() !== runId.toLowerCase()) throw new Error('invalid_manifest');
      const declarations = [...Object.values(manifest.artifacts), ...(manifest.envelope ? [manifest.envelope] : []), manifest.events];
      for (const d of declarations) {
        if (!['report.json', 'report.md', 'envelope.json', 'events.json'].includes(d.file)) throw new Error('invalid_manifest');
        const bytes = await readStable(join(path, d.file), this.capBytes);
        if (bytes.sha256 !== d.sha256 || bytes.raw.length !== d.bytes) throw new Error('retained_digest_mismatch');
      }
      const observations: QuarantineObservation[] = [];
      for (const name of (await readdir(path)).filter((name) => name.startsWith('observation-')).sort()) {
        const raw = await readStable(join(path, name), 64_000);
        const observation = snapshotSchema.parse(JSON.parse(raw.text));
        if (name !== `observation-${raw.sha256}.json` || observation.run_id !== manifest.run_id ||
            observation.requested_mode !== manifest.requested_mode || JSON.stringify(observation.artifacts) !== JSON.stringify(manifest.artifacts) ||
            JSON.stringify(observation.envelope) !== JSON.stringify(manifest.envelope) || JSON.stringify(observation.events) !== JSON.stringify(manifest.events)) {
          throw new Error('invalid_observation');
        }
        observations.push(observation);
      }
      return { runId, path, status: 'complete', manifest, observations };
    } catch (error) {
      return { runId, path, status: 'incomplete', error: fileFailure(error) };
    }
  }

  async list(): Promise<QuarantineEntry[]> {
    let names: string[];
    try { names = await readdir(this.dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const entries: QuarantineEntry[] = [];
    for (const name of names.filter((n) => UUID.test(n)).sort()) {
      const entry = await this.inspect(name);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private async totalBytes(): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const file of await readdir(join(this.dir, entry.name))) {
        const info = await lstat(join(this.dir, entry.name, file));
        if (info.isFile()) total += info.size;
      }
    }
    return total;
  }
}
