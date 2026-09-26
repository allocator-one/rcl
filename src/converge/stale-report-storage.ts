import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { serializeRecoveryDocument, syncDirectory, writeExclusiveBytes } from '../evidence/original-run/journal.js';
import { prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { readStable, sha256 } from '../telemetry/recovery/files.js';
import type { ConvergeRunState } from './run-state.js';
import type { StaleReportEntry } from './stale-report-schema.js';

export async function selectedStaleFile(path: string, digest: string) {
  const file = await readStable(path);
  if (file.sha256 !== digest) throw new Error('stale_report_digest_mismatch');
  return file;
}

/** Publish complete immutable bytes exclusively; retry never overwrites evidence. */
export async function retainStaleFile(path: string, bytes: Buffer): Promise<void> {
  try {
    const current = await readStable(path);
    if (!current.raw.equals(bytes)) throw new Error('stale_report_retained_conflict');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const staging = `${path}.${randomUUID()}.pending`;
    await writeExclusiveBytes(staging,bytes);
    await link(staging,path); await syncDirectory(dirname(path));
    await unlink(staging);
  }
  const current = await selectedStaleFile(path,sha256(bytes));
  const handle = await open(path,'r');
  try { if (!(await handle.readFile()).equals(current.raw)) throw new Error('stale_report_retained_conflict'); }
  finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

function objects(common: string): string { return join(common,'rcl-stale-report-audits','objects'); }

export async function retainStaleObject(common: string, bytes: Buffer): Promise<void> {
  const dir = objects(common);
  await prepareLockRoot(dir); await syncDirectory(dirname(dir));
  await retainStaleFile(join(dir,sha256(bytes)),bytes);
}

/** The receipt reader inspects the immutable object's directory once per audit traversal. */
export async function readStaleObject(common: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('stale_report_invalid_object');
  return selectedStaleFile(join(objects(common),digest),digest);
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('raw'),sha256:digest}).strict(),
  z.object({kind:z.literal('template'),sha256:digest,updatedAt:z.string(),
    auditCount:z.number().int().positive().max(10000)}).strict(),
]);

/** Preserve arbitrary initial bytes; canonical later snapshots share a template and audit prefix. */
export async function retainStaleSnapshot(common: string, path: string, before: Awaited<ReturnType<typeof readStable>>): Promise<void> {
  const state = decodeOriginalReport(before.text).value as ConvergeRunState;
  let snapshot: z.infer<typeof snapshotSchema> = {kind:'raw',sha256:before.sha256};
  let bytes = before.raw;
  if (state.staleReportAudit?.length && before.text === serializeRecoveryDocument(state)) {
    bytes = Buffer.from(serializeRecoveryDocument({...state,updatedAt:'',staleReportAudit:[]}));
    snapshot = {kind:'template',sha256:sha256(bytes),updatedAt:state.updatedAt,auditCount:state.staleReportAudit.length};
  }
  await retainStaleObject(common,bytes);
  await retainStaleFile(path,Buffer.from(serializeRecoveryDocument(snapshotSchema.parse(snapshot))));
}

/** Reconstruct byte-identical native state from an immutable template and the verified preceding audit. */
export async function readStaleSnapshot(common: string, path: string, expectedDigest: string, prefix: StaleReportEntry[]) {
  const descriptor = snapshotSchema.parse(decodeOriginalReport((await readStable(path)).text).value);
  const object = await readStaleObject(common,descriptor.sha256);
  let text = object.text;
  if (descriptor.kind === 'template') {
    if (descriptor.auditCount !== prefix.length) throw new Error('stale_report_audit_prefix_mismatch');
    const template = decodeOriginalReport(text).value as ConvergeRunState;
    if (template.updatedAt !== '' || !Array.isArray(template.staleReportAudit) || template.staleReportAudit.length !== 0) {
      throw new Error('stale_report_invalid_snapshot');
    }
    text = serializeRecoveryDocument({...template,updatedAt:descriptor.updatedAt,staleReportAudit:prefix});
  }
  if (sha256(text) !== expectedDigest) throw new Error('stale_report_digest_mismatch');
  return decodeOriginalReport(text).value as ConvergeRunState;
}
