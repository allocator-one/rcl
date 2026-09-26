import { createHash, randomUUID } from 'node:crypto';
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
  if (state.staleReportAudit?.length && Object.keys(state)[0] === 'staleReportAudit' && before.text === serializeRecoveryDocument(state)) {
    bytes = Buffer.from(serializeRecoveryDocument({...state,updatedAt:'',staleReportAudit:[],staleReportAuditCount:0}));
    snapshot = {kind:'template',sha256:sha256(bytes),updatedAt:state.updatedAt,auditCount:state.staleReportAudit.length};
  }
  await retainStaleObject(common,bytes);
  await retainStaleFile(path,Buffer.from(serializeRecoveryDocument(snapshotSchema.parse(snapshot))));
}

/** A traversal reads each immutable object once and hashes each audit entry once. */
export class StaleHistoryReader {
  readonly prefix: StaleReportEntry[] = [];
  private hash = createHash('sha256').update('{\n  "staleReportAudit": [\n');
  private objects = new Map<string, Awaited<ReturnType<typeof readStable>>>();
  private decoded = new Map<string, ConvergeRunState>();
  private tails = new WeakMap<ConvergeRunState,string>();

  constructor(private common: string) {}

  async object(digest: string) {
    let object = this.objects.get(digest);
    if (!object) { object = await readStaleObject(this.common,digest); this.objects.set(digest,object); }
    return object;
  }

  private entryBytes(entry: StaleReportEntry): string {
    return (this.prefix.length ? ',\n' : '') + JSON.stringify(entry,null,2).split('\n').map(line => '    '+line).join('\n');
  }

  append(entry: StaleReportEntry): void { this.hash.update(this.entryBytes(entry)); this.prefix.push(entry); }

  private digest(body: ConvergeRunState, updatedAt: string, entry?: StaleReportEntry): string {
    let tail = this.tails.get(body);
    if (tail === undefined) {
      const {staleReportAudit: _audit, staleReportAuditCount: _count, updatedAt: _at, ...rest} = body;
      tail = ','+JSON.stringify(rest,null,2).slice(1,-2);
      this.tails.set(body,tail);
    }
    const hash = this.hash.copy();
    if (entry) hash.update(this.entryBytes(entry));
    return hash.update('\n  ]').update(tail)
      .update(',\n  "staleReportAuditCount": '+(this.prefix.length+(entry ? 1 : 0)))
      .update(',\n  "updatedAt": '+JSON.stringify(updatedAt)+'\n}\n').digest('hex');
  }

  afterDigest(body: ConvergeRunState, entry: StaleReportEntry, updatedAt: string): string {
    return this.digest(body,updatedAt,entry);
  }

  /** Reconstruct the exact state without repeatedly serializing or parsing its audit prefix. */
  async snapshot(path: string, expectedDigest: string) {
    const descriptor = snapshotSchema.parse(decodeOriginalReport((await readStable(path)).text).value);
    const object = await this.object(descriptor.sha256);
    let body = this.decoded.get(descriptor.sha256);
    if (!body) { body = decodeOriginalReport(object.text).value as ConvergeRunState; this.decoded.set(descriptor.sha256,body); }
    if (descriptor.kind === 'raw') {
      if (object.sha256 !== expectedDigest) throw new Error('stale_report_digest_mismatch');
      return {state:body,body};
    }
    if (descriptor.auditCount !== this.prefix.length) throw new Error('stale_report_audit_prefix_mismatch');
    if (body.updatedAt !== '' || body.staleReportAuditCount !== 0 ||
      !Array.isArray(body.staleReportAudit) || body.staleReportAudit.length !== 0 ||
      Object.keys(body)[0] !== 'staleReportAudit') throw new Error('stale_report_invalid_snapshot');
    if (this.digest(body,descriptor.updatedAt) !== expectedDigest) throw new Error('stale_report_digest_mismatch');
    return {state:{...body,updatedAt:descriptor.updatedAt,staleReportAudit:this.prefix,staleReportAuditCount:this.prefix.length},body};
  }
}
