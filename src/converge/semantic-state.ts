import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { claimDescriptorSchema, compareClaims, semanticFindingKey, type ClaimDescriptor, type MatchRationale } from '../consensus/claim-identity.js';
import type { ConsensusFinding, ReviewResult } from '../consensus/types.js';
import { DEFAULT_SEVERITY_ORDER } from '../config/defaults.js';
import { ConvergeRunStateError, ConvergeRoundCapError, DEFAULT_CONVERGE_ROUND_CAP, HARD_CONVERGE_ROUND_CAP,
  convergeRunStatePath, loadConvergeRunState, loadConvergeRunStateEvidence, writeState, validateRoundCap, findingGatingReason,
  type ProcessRoundOptions, type RoundReport, type ConvergeRunState, type FindingStatus, type FindingEntry } from './run-state.js';

export interface ReportBinding {
  runId: string;
  target: string;
  round: number;
  reportSha256: string;
  sourcePath: string;
}
export interface SemanticSighting {
  runId: string;
  target: string;
  round: number;
  reportSha256: string;
  findingRef: string;
  reportKey: string;
  canonicalIdentity: string;
  claimDescriptor: ClaimDescriptor;
  matchRationale: MatchRationale;
  status: FindingStatus;
  suppressReason?: string;
  severity: ConsensusFinding['severity'];
  gating: string;
  belowThreshold: boolean;
  file: string;
  category: string;
  startLine: number;
  endLine: number;
}
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Validate exact original bytes and caller bindings before any durable effect. */
export function bindRoundEvidence(options: ProcessRoundOptions): ReportBinding {
  let report: ReviewResult;
  try { report = JSON.parse(options.evidence!.reportJson) as ReviewResult; }
  catch { throw new ConvergeRunStateError('Invalid immutable report JSON.'); }
  const run = report.run;
  if (!run || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(run.id) ||
      run.id !== options.runId || run.converge?.target !== options.target.trim() ||
      !Number.isSafeInteger(run.converge.round) || run.converge.round !== options.round) {
    throw new ConvergeRunStateError('Original report run, target and round must exactly match the caller binding.');
  }
  const described = options.findings.some(f => f.claimDescriptor !== undefined);
  const original = [...report.findings, ...(described ? report.belowThresholdFindings ?? [] : [])];
  if (JSON.stringify(original) !== JSON.stringify(options.findings)) {
    throw new ConvergeRunStateError('Selected findings differ from immutable report objects or original order.');
  }
  const reportSha256 = sha(options.evidence!.reportJson);
  return { runId: run.id, target: options.target.trim(), round: options.round, reportSha256,
    sourcePath: `${convergeRunStatePath(options.gitCommonDir, options.target.trim())}.evidence/${reportSha256}.json` };
}
export async function retainReportEvidence(raw: string, binding: ReportBinding): Promise<void> {
  if (sha(raw) !== binding.reportSha256) throw new ConvergeRunStateError('Original report digest changed.');
  await mkdir(dirname(binding.sourcePath), { recursive: true, mode: 0o700 });
  try { await writeFile(binding.sourcePath, raw, { flag: 'wx', mode: 0o400 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(binding.sourcePath)).equals(Buffer.from(raw))) throw e;
  }
}
export async function verifyRoundBinding(binding: ReportBinding, target: string, round: number, runId: string): Promise<void> {
  let bytes: Buffer;
  try { bytes = await readFile(binding.sourcePath); }
  catch { throw new ConvergeRunStateError('Original bound report bytes unavailable; refusing verdict mutation.'); }
  let report: ReviewResult;
  try { report = JSON.parse(bytes.toString()) as ReviewResult; }
  catch { throw new ConvergeRunStateError('Original bound report is invalid JSON.'); }
  if (sha(bytes) !== binding.reportSha256 || binding.target !== target || binding.round !== round || binding.runId !== runId ||
      report.run?.id !== runId || report.run?.converge?.target !== target || report.run?.converge?.round !== round) {
    throw new ConvergeRunStateError('Inconsistent immutable original report binding; refusing verdict mutation.');
  }
}
function located(a: Pick<ConsensusFinding, 'file' | 'category' | 'startLine' | 'endLine'>, b: Pick<FindingEntry, 'file' | 'category' | 'startLine' | 'endLine'>, window: number): boolean {
  return a.file === b.file && a.category === b.category && a.startLine <= b.endLine + window && b.startLine <= a.endLine + window;
}
function highest(rows: ConsensusFinding[]): ConsensusFinding['severity'] {
  return rows.map(f => f.severity).sort((a, b) => DEFAULT_SEVERITY_ORDER.indexOf(a) - DEFAULT_SEVERITY_ORDER.indexOf(b))[0]!;
}

/** Frozen batch matching: a component must be a clique and agree on one prior claim. */
export async function processSemanticRound(options: ProcessRoundOptions, binding: ReportBinding): Promise<RoundReport> {
  const findings = options.findings;
  const keys = new Set<string>();
  for (const f of findings) {
    if (!claimDescriptorSchema.safeParse(f.claimDescriptor).success || !f.identity || !f.identity.startsWith(`report:${binding.runId}:`) || keys.has(f.identity)) {
      throw new ConvergeRunStateError('Every described sighting requires a valid descriptor and distinct original report-qualified key.');
    }
    if (!Number.isSafeInteger(f.startLine) || !Number.isSafeInteger(f.endLine) || f.startLine < 0 || f.endLine < f.startLine) throw new ConvergeRunStateError('Invalid described sighting location.');
    keys.add(f.identity);
  }
  const state: ConvergeRunState = await loadConvergeRunState(options.gitCommonDir, binding.target) ?? {
    version: 2, target: binding.target, roundCap: DEFAULT_CONVERGE_ROUND_CAP, rounds: [], findings: {}, sightings: [], updatedAt: new Date().toISOString(),
  };
  if (state.version !== 2) throw new ConvergeRunStateError('Legacy v1 state requires explicit converge-migrate preview/apply before semantic processing.');
  if (!Array.isArray(state.sightings)) throw new ConvergeRunStateError('Invalid v2 sighting ledger; refusing to reset it.');
  const old = state.rounds.find(r => r.round === options.round);
  if (old) {
    if (old.reportBinding?.reportSha256 !== binding.reportSha256 || old.runId !== binding.runId) throw new ConvergeRunStateError('Round is already bound to different immutable report bytes.');
    await verifyRoundBinding(old.reportBinding, binding.target, options.round, binding.runId);
    const sightings = state.sightings.filter(s => s.round === options.round);
    if (sightings.length !== findings.length) throw new ConvergeRunStateError('Incomplete immutable sighting ledger.');
    return { roundCap: state.roundCap, counts: old.counts, actionableIdentities: pending(state), findings: findings.map((finding, i) => {
      const sighting = sightings[i]!;
      return { identity: sighting.canonicalIdentity, status: sighting.status, suppressReason: sighting.suppressReason, finding, sighting };
    }) };
  }
  if (options.maxRounds !== undefined) state.roundCap = validateRoundCap(options.maxRounds);
  if (options.round > state.roundCap || options.round > HARD_CONVERGE_ROUND_CAP) throw new ConvergeRoundCapError(binding.target, options.round, state.roundCap);
  const max = Math.max(0, ...state.rounds.map(r => r.round));
  if (max && options.round !== max + 1) throw new ConvergeRunStateError(`Round ${options.round} is out of order; next round is ${max + 1}.`);
  const window = options.lineWindow ?? 5;
  const prior = Object.values(state.findings).filter(e => e.claimDescriptor !== undefined);
  // Never expand equivalence through a paraphrase bridge. Every previously
  // associated descriptor must support the new sighting, not just the latest.
  const candidates = findings.map(f => prior.filter(e => located(f, e, window) && compareClaims(f.claimDescriptor!, e.claimDescriptor!) &&
    state.sightings!.filter(s => s.canonicalIdentity === e.key).every(s => compareClaims(f.claimDescriptor!, s.claimDescriptor))).map(e => e.key).sort());
  const related = findings.map(a => findings.map(b => located(a, b, window) && compareClaims(a.claimDescriptor!, b.claimDescriptor!) !== undefined));
  const visited = new Set<number>();
  const groups: Array<{ indices: number[]; matched?: string; rationale: MatchRationale; key?: string; representative?: ConsensusFinding }> = [];
  for (let i = 0; i < findings.length; i++) {
    if (visited.has(i)) continue;
    const component = [i]; visited.add(i);
    for (let j = 0; j < component.length; j++) for (let k = 0; k < findings.length; k++) {
      if (!visited.has(k) && related[component[j]!]![k]) { visited.add(k); component.push(k); }
    }
    const clique = component.every(a => component.every(b => a === b || related[a]![b]));
    const sameCandidates = component.every(j => JSON.stringify(candidates[j]) === JSON.stringify(candidates[i]));
    if (!clique || !sameCandidates) {
      for (const j of component) groups.push({ indices: [j], rationale: 'ambiguous' });
    } else {
      const matches = candidates[i]!;
      groups.push({ indices: component, ...(matches.length === 1 ? { matched: matches[0] } : {}),
        rationale: matches.length > 1 ? 'ambiguous' : 'new_claim' });
    }
  }
  // Disconnected current components may still share a broad prior candidate.
  // A prior claim is not permission to bridge mutually unsupported sightings.
  for (const key of new Set(groups.flatMap(g => g.matched ? [g.matched] : []))) {
    const sharing = groups.filter(g => g.matched === key);
    const members = sharing.flatMap(g => g.indices);
    if (!members.every(a => members.every(b => a === b || related[a]![b]))) {
      for (const group of sharing) { delete group.matched; group.rationale = 'ambiguous'; }
    }
  }
  // Canonical allocation order is independent of report order. Sighting refs
  // below retain the untouched original kept/appendix positions.
  const signature = (g: typeof groups[number]) => JSON.stringify(g.indices.map(i => {
    const f = findings[i]!; return [semanticFindingKey(f.file, f.category, f.claimDescriptor!), f.startLine, f.endLine];
  }).sort());
  const occupied = new Set(Object.keys(state.findings));
  for (const group of [...groups].sort((a, b) => signature(a).localeCompare(signature(b)))) {
    if (group.matched) { group.key = group.matched; continue; }
    const representatives = group.indices.map(i => findings[i]!).sort((a, b) => semanticFindingKey(a.file, a.category, a.claimDescriptor!).localeCompare(semanticFindingKey(b.file, b.category, b.claimDescriptor!)));
    const rep = representatives[0]!;
    group.representative = rep;
    const base = semanticFindingKey(rep.file, rep.category, rep.claimDescriptor!);
    let key = base; let salt = 0;
    while (occupied.has(key)) key = sha(JSON.stringify([base, signature(group), ++salt])).slice(0, 16);
    occupied.add(key); group.key = key;
  }
  const original = JSON.parse(options.evidence!.reportJson) as ReviewResult;
  const keptCount = original.findings.length;
  const counts = { new: 0, repeat: 0, suppressed: 0, regating: 0 };
  const severities: Record<string, ConsensusFinding['severity']> = {};
  const annotations: RoundReport['findings'] = [];
  for (const group of groups) {
    const rows = group.indices.map(i => findings[i]!);
    const severity = highest(rows); const key = group.key!;
    severities[key] = severity;
    const representative = group.representative ?? rows.slice().sort((a, b) => JSON.stringify(a.claimDescriptor).localeCompare(JSON.stringify(b.claimDescriptor)))[0]!;
    const previous = state.findings[key];
    const status: FindingStatus = !previous ? 'new' : previous.verdict === 'dismissed'
      ? severity === 'critical' && (previous.verdictSeverity ?? previous.severity) !== 'critical' ? 'regating' : 'suppressed' : 'repeat';
    const suppressReason = status === 'suppressed' ? `dismissed in round ${previous!.verdictRound}${previous!.verdictReason ? ` (${previous!.verdictReason})` : ''} — matching semantic claim; escalation to critical re-gates` : undefined;
    const entry: FindingEntry = previous ?? { key, file: representative.file, category: representative.category, startLine: representative.startLine,
      endLine: representative.endLine, title: representative.title, severity, models: [], firstRound: options.round, lastRound: options.round, claimDescriptor: representative.claimDescriptor };
    if (entry.verdict && !entry.verdictSeverity) entry.verdictSeverity = entry.severity;
    entry.severity = severity; entry.lastRound = options.round;
    entry.startLine = Math.min(...rows.map(f => f.startLine)); entry.endLine = Math.max(...rows.map(f => f.endLine));
    entry.models = [...new Set([...entry.models, ...rows.flatMap(f => f.consensus.models)])].sort();
    if ((status === 'new' || status === 'regating' || (status === 'repeat' && !entry.verdict)) && group.indices.some(i => i < keptCount && findingGatingReason(findings[i]!) !== 'none')) entry.pendingRound = options.round;
    state.findings[key] = entry;
    for (const i of group.indices) {
      const finding = findings[i]!;
      const rationale = group.matched ? compareClaims(finding.claimDescriptor!, entry.claimDescriptor!)! : group.rationale;
      const sighting: SemanticSighting = { runId: binding.runId, target: binding.target, round: options.round, reportSha256: binding.reportSha256,
        findingRef: `f${String(i + 1).padStart(3, '0')}`, reportKey: finding.identity!, canonicalIdentity: key, claimDescriptor: finding.claimDescriptor!,
        matchRationale: rationale, status, ...(suppressReason ? { suppressReason } : {}), severity: finding.severity,
        gating: i < keptCount ? findingGatingReason(finding) : 'none', belowThreshold: i >= keptCount, file: finding.file, category: finding.category,
        startLine: finding.startLine, endLine: finding.endLine };
      counts[status]++;
      annotations[i] = { identity: key, status, ...(suppressReason ? { suppressReason } : {}), finding, sighting };
    }
  }
  state.sightings.push(...annotations.map(a => a.sighting!));
  state.rounds.push({ round: options.round, counts, severities, runId: binding.runId, reportBinding: binding });
  state.lastAnnotations = { round: options.round, identities: annotations.map(a => ({ identity: a.identity, status: a.status, gating: a.sighting!.gating })) };
  state.updatedAt = new Date().toISOString();
  await retainReportEvidence(options.evidence!.reportJson, binding);
  await writeState(options.gitCommonDir, state);
  return { roundCap: state.roundCap, counts, findings: annotations, actionableIdentities: pending(state) };
}
export function pending(state: ConvergeRunState): string[] {
  return Object.values(state.findings).filter(e => e.pendingRound !== undefined).map(e => e.key).sort();
}

/** Explicit additive migration, never an in-place reinterpretation of originals. */
export async function migrateConvergeState(options: { gitCommonDir: string; target: string; apply?: boolean }) {
  const target = options.target.trim();
  const path = convergeRunStatePath(options.gitCommonDir, target);
  const observed = await loadConvergeRunStateEvidence(options.gitCommonDir, target);
  const state = observed?.state;
  if (!state) throw new ConvergeRunStateError(`No converge run state for ${target}.`);
  const original = await readFile(path); const sourceSha256 = sha(original);
  if (sourceSha256 !== observed!.sha256) throw new ConvergeRunStateError('Native state changed during migration read; retry preview.');
  const snapshotPath = state.version === 1 ? `${path}.v1-${sourceSha256}.snapshot` : state.migration?.snapshotPath;
  const result = { status: state.version === 2 ? 'already-current' as const : options.apply ? 'migrated' as const : 'preview' as const,
    fromVersion: state.version, toVersion: 2 as const, sourceSha256, originalSha256: sourceSha256,
    legacyIdentityCount: Object.values(state.findings).filter(e => !e.claimDescriptor).length, roundCap: state.roundCap, roundCount: state.rounds.length,
    applied: false, ...(snapshotPath ? { snapshotPath } : {}) };
  if (state.version === 2 || !options.apply) return result;
  try { await writeFile(snapshotPath!, original, { flag: 'wx', mode: 0o400 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(snapshotPath!)).equals(original)) throw e; }
  if (!(await readFile(path)).equals(original)) throw new ConvergeRunStateError('Native state changed during migration; original snapshot retained, retry preview.');
  state.version = 2; state.sightings = [];
  state.migration = { sourceSha256, snapshotPath: snapshotPath!, migratedAt: new Date().toISOString() };
  for (const entry of Object.values(state.findings)) {
    if (!entry.verdict) {
      const annotations = state.lastAnnotations?.identities.filter(a => a.identity === entry.key) ?? [];
      const provenNonGating = entry.firstRound === entry.lastRound && entry.lastRound === state.lastAnnotations?.round &&
        annotations.length > 0 && annotations.every(a => a.gating === 'none');
      if (!provenNonGating) entry.pendingRound ??= entry.firstRound;
    }
    const criticalAfterDismissal = entry.verdict === 'dismissed' && entry.verdictSeverity !== 'critical'
      ? state.rounds.filter(r => r.round > (entry.verdictRound ?? 0) && r.severities?.[entry.key] === 'critical').map(r => r.round) : [];
    if (criticalAfterDismissal.length > 0) entry.pendingRound ??= Math.min(...criticalAfterDismissal);
    const regating = state.lastAnnotations?.identities.some(a => a.identity === entry.key && a.status === 'regating' && a.gating !== 'none');
    if (regating && entry.verdictRound !== state.lastAnnotations!.round) entry.pendingRound ??= state.lastAnnotations!.round;
  }
  await writeState(options.gitCommonDir, state);
  return { ...result, applied: true };
}
