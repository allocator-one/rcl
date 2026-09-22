import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ReviewResult } from '../../consensus/types.js';
import { buildRunEnvelope, type ArtifactBytes, type RunEnvelope } from '../../telemetry/envelope.js';
import { validateRunEnvelope, MAX_ARTIFACT_BYTES } from '../../telemetry/envelope-validation.js';
import { originalRunReportSchema, originalRawFindingSchema, requiresArtifactRedaction } from '../../telemetry/recovery/source.js';
import { readStable, hasSyntheticAncestor, platformPath, sha256 } from '../../telemetry/recovery/files.js';
import { scrubSecrets, scrubText } from '../../telemetry/scrub.js';
import { parsePullRequestArg } from '../target.js';
import { decodeOriginalReport, findingProsePath, type ProseTransformation } from './decode.js';

export const hashSchema = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
export const uuidSchema = z.string().uuid().refine(value => value === value.toLowerCase(), 'UUID must already use canonical lowercase form');
export const selectionSchema = z.object({
  run: uuidSchema, forPr: z.string(), head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/).refine(s => !/^0+$/.test(s)),
  reportJson: z.string().min(1), reportSha256: hashSchema,
  reportMd: z.string().min(1).optional(), markdownSha256: hashSchema.optional(), originalMode: z.literal('asserted'),
}).strict().refine(s => (s.reportMd === undefined) === (s.markdownSha256 === undefined));
export type Selection = z.infer<typeof selectionSchema>;
export interface SourceFile { path: string; sha256: string; bytes: number }
export interface PreparedOriginal {
  selection: Selection;
  sources: { report_json: SourceFile; report_md?: SourceFile };
  envelope: RunEnvelope;
  envelope_sha256: string;
  transformations: ProseTransformation[];
  transport_derivations: Array<{ path: string; rule: string; original_sha256: string; transport_sha256: string }>;
  original_mode: { value: 'asserted'; authority: 'operator_assertion'; retained_runner: unknown };
  retained_content_limitations: { report_sha256: string; redacted_prose: Array<{ path: string; count: number }>; meaning: string };
}
const descriptor = z.object({
  version: z.literal(1), operation: z.string(), invariant: z.string(), evidence: z.array(z.string()).min(1).max(20),
}).strict().superRefine((v, ctx) => {
  for (const s of [v.operation, v.invariant, ...v.evidence]) {
    if (!s.trim() || [...s].length > 500 || Buffer.byteLength(s) > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s) || scrubText(s, 500) !== s) {
      ctx.addIssue({ code: 'custom', message: 'Descriptor would require transformation' });
    }
  }
});
function knownKeys(value: object, allowed: string[], label: string): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`unsupported_${label}_fields`);
}
const consensusFindingKeys = ['id','file','startLine','endLine','locationProvenance','severity','category','title','description','suggestedFix','identity','consensus','gating','claimDescriptor'];
function cleanMarkdown(text: string): void {
  if (scrubSecrets(text) !== text || text.includes('[redacted]') || text.includes('\0')) throw new Error('original_artifact_requires_redaction');
  if (text.includes('SYNTHETIC_TEST_ONLY')) throw new Error('source_marked_synthetic');
}
function retainedRedactions(value: unknown, path = ''): Array<{ path: string; count: number }> {
  if (typeof value === 'string') {
    const count = value.split('[redacted]').length - 1;
    if (!count) return [];
    if (!findingProsePath.test(path)) throw new Error('redacted_structural_binding');
    return [{ path, count }];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => retainedRedactions(v, `${path}/${i}`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, v]) => {
    if (key.includes('[redacted]')) throw new Error('redacted_structural_binding');
    return retainedRedactions(v, `${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`);
  });
  return [];
}

/** Rebuild only the reviewed transport interpretation; artifact strings remain exact originals. */
export async function prepareOriginalRun(input: unknown): Promise<{ prepared: PreparedOriginal; artifacts: ArtifactBytes }> {
  const selection = selectionSchema.parse(input);
  const pr = parsePullRequestArg(selection.forPr, null);
  for (const path of [selection.reportJson, ...(selection.reportMd ? [selection.reportMd] : [])]) {
    if (await hasSyntheticAncestor(path)) throw new Error('source_marked_synthetic');
  }
  const json = await readStable(selection.reportJson, MAX_ARTIFACT_BYTES);
  if (json.sha256 !== selection.reportSha256 || !Buffer.from(json.text, 'utf8').equals(json.raw)) throw new Error('original_report_digest_mismatch');
  const decoded = decodeOriginalReport(json.text);
  if (!originalRunReportSchema.safeParse(decoded.value).success) throw new Error('unsupported_original_report');
  const report = decoded.value as ReviewResult & { run: NonNullable<ReviewResult['run']> };
  if (report.reviews.some(r => r.findings.length > 2000 || r.findings.some(f => !originalRawFindingSchema.safeParse(f).success))) throw new Error('unsupported_original_reviewer_finding');
  if (requiresArtifactRedaction(decoded.value)) throw new Error('original_artifact_requires_redaction');
  const redactions = retainedRedactions(decoded.value);
  if (json.text.includes('SYNTHETIC_TEST_ONLY')) throw new Error('source_marked_synthetic');
  knownKeys(report, ['run','reviews','findings','belowThresholdFindings','stats'], 'report');
  knownKeys(report.run, ['id','rcl_version','command','target','roster','config_sha256','thresholds','gating','spec','context_files','plan','runner','started_at','finished_at','duration_ms','ci_exit_code','converge','provenance'], 'header');
  knownKeys(report.run.runner, ['kind','agent','host','ci_run_id'], 'runner');
  knownKeys(report.run.target, ['kind','repo','pr_number','url','head_sha','base_sha','head_ref','base_ref','diff_sha256','files','additions','deletions'], 'target');
  if (report.run.converge) knownKeys(report.run.converge, ['target','round','attempt'], 'converge');
  if (report.run.spec) knownKeys(report.run.spec, ['source','sha256'], 'spec');
  if (report.run.plan) knownKeys(report.run.plan, ['focus'], 'plan');
  for (const row of report.run.roster) knownKeys(row, ['model','role','provider','lane'], 'roster');
  for (const row of report.run.context_files) knownKeys(row, ['path','sha256'], 'context');
  for (const finding of [...report.findings, ...(report.belowThresholdFindings ?? [])]) knownKeys(finding, consensusFindingKeys, 'finding');
  if (!['human','agent'].includes(report.run.runner.kind) || report.run.runner.ci_run_id !== undefined || report.run.provenance === 'backfill') throw new Error('unsupported_original_evidence_mode');
  if (report.run.id !== selection.run || !['pr','patch'].includes(report.run.target.kind) || report.run.target.repo !== `${pr.owner}/${pr.repo}` || report.run.target.pr_number !== pr.number || report.run.target.head_sha !== selection.head) throw new Error('original_run_binding_mismatch');
  const artifacts: ArtifactBytes = { report_json: json.text };
  const sources: PreparedOriginal['sources'] = { report_json: { path: platformPath(selection.reportJson), sha256: json.sha256, bytes: json.raw.length } };
  if (selection.reportMd) {
    const md = await readStable(selection.reportMd, MAX_ARTIFACT_BYTES);
    if (md.sha256 !== selection.markdownSha256 || !Buffer.from(md.text, 'utf8').equals(md.raw)) throw new Error('original_markdown_digest_mismatch');
    cleanMarkdown(md.text); artifacts.report_md = md.text;
    sources.report_md = { path: platformPath(selection.reportMd), sha256: md.sha256, bytes: md.raw.length };
  }
  const originalFindings = [...report.findings, ...(report.belowThresholdFindings ?? [])];
  if (originalFindings.some(f => typeof f.identity !== 'string' || !f.identity.trim())) throw new Error('missing_original_finding_identity');
  // A range reversal is the existing parser contract, recorded explicitly without rewriting the source.
  const transport = structuredClone(report);
  for (const f of [...transport.findings, ...(transport.belowThresholdFindings ?? [])]) {
    if (f.startLine > f.endLine) {
      if (f.locationProvenance !== undefined) throw new Error('conflicting_location_provenance');
      f.locationProvenance = { version: 1, source: 'parser', reason: 'reversed_range', originalStartLine: f.startLine, originalEndLine: f.endLine };
      [f.startLine, f.endLine] = [f.endLine, f.startLine];
    }
  }
  const envelope = buildRunEnvelope(transport, artifacts, { level: 'full', delivery: { mode: 'direct' } });
  if (!isDeepStrictEqual(envelope.run, report.run)) throw new Error('original_header_requires_transformation');
  const derivations: PreparedOriginal['transport_derivations'] = [];
  const derive = (path: string, before: unknown, after: unknown, rule: string) => {
    if (!isDeepStrictEqual(before, after)) derivations.push({ path, rule, original_sha256: sha256(JSON.stringify(before) ?? 'null'), transport_sha256: sha256(JSON.stringify(after) ?? 'null') });
  };
  const findingGroups = [
    { source: report.findings, root: '/findings', offset: 0 },
    { source: report.belowThresholdFindings ?? [], root: '/belowThresholdFindings', offset: report.findings.length },
  ];
  for (const group of findingGroups) {
    group.source.forEach((f, index) => {
      const wire = envelope.findings[group.offset + index]!;
      if (f.startLine > f.endLine) wire.location_provenance = { ...wire.location_provenance!, source: 'report_projection', report_json_sha256: json.sha256 };
      if (wire.file !== f.file || wire.identity_key !== f.identity || wire.category !== f.category || !isDeepStrictEqual(wire.consensus, f.consensus)) throw new Error('structural_finding_requires_transformation');
      const described = f as unknown as Record<string, unknown>;
      if (Object.hasOwn(described, 'claimDescriptor')) {
        const parsed = descriptor.safeParse(described.claimDescriptor);
        if (!parsed.success) throw new Error('unsupported_original_descriptor');
        (wire as unknown as Record<string, unknown>).claim_descriptor = parsed.data;
      }
      for (const [source, dest] of [['title','title'],['description','description'],['suggestedFix','suggested_fix']] as const) derive(`${group.root}/${index}/${dest}`, f[source], wire[dest], 'existing_buildRunEnvelope_scrub_and_codepoint_limit');
      derive(`${group.root}/${index}/location`, [f.startLine, f.endLine, f.locationProvenance ?? null], [wire.start_line, wire.end_line, wire.location_provenance ?? null], 'existing_reversed_range_provenance');
      derive(`${group.root}/${index}/verification`, f.gating?.verification ?? null, { verdict: wire.verification_verdict, model: wire.verification_model, note: wire.verification_note }, 'existing_normalizeVerificationEvidence');
    });
  }
  report.reviews.forEach((r, i) => {
    const call = envelope.calls[i]!;
    if (call.model !== r.model || call.role !== r.role || call.provider !== r.provider) throw new Error('call_identity_requires_transformation');
    derive(`/calls/${i}`, r, call, 'existing_buildRunEnvelope_call_projection_rounding_and_error_summary');
  });
  const keys = new Map<string, boolean>();
  for (const f of envelope.findings) {
    const has = Object.hasOwn(f, 'claim_descriptor');
    if (keys.has(f.identity_key) && (has || keys.get(f.identity_key))) throw new Error('duplicate_described_identity');
    keys.set(f.identity_key, has || keys.get(f.identity_key) === true);
  }
  if (validateRunEnvelope(envelope, artifacts).length) throw new Error('unsupported_original_envelope');
  return { artifacts, prepared: { selection: { ...selection, reportJson: sources.report_json.path, ...(sources.report_md ? { reportMd: sources.report_md.path } : {}) }, sources, envelope, envelope_sha256: sha256(JSON.stringify(envelope)), transformations: decoded.transformations, transport_derivations: derivations, original_mode: { value: 'asserted', authority: 'operator_assertion', retained_runner: report.run.runner }, retained_content_limitations: { report_sha256: json.sha256, redacted_prose: redactions, meaning: 'Pre-existing literal markers are retained content, not reconstructed text or proof of an unredacted original.' } } };
}
