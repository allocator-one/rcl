import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { claimDescriptorSchema, compareClaims } from './claims.js';
import { decodeOriginalReport, decodeRecoveryDocument } from '../../original-run/decode.js';
import { recoveryAnchors } from './native-state.js';
import { ConvergeRunStateError, findingGatingReason, migratedLegacyPendingRound, verdictClearsPending } from './obligations.js';
import { DEFAULT_SEVERITY_ORDER } from '../../../config/defaults.js';
import type { ConsensusFinding } from '../../../consensus/types.js';
import type { ConvergeRunState, FindingEntry, ReportBinding, RetainedReport } from './types.js';
import type { RetainedSources } from './sources.js';
import { semanticCacheMatches } from './semantic-cache.js';
import { object } from './primitives.js';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function verifyRoundBinding(binding: ReportBinding, target: string, round: number, runId: string, raw: string): RetainedReport {
  const bytes = Buffer.from(raw);
  let report: RetainedReport;
  try {
    const decoded = decodeOriginalReport(bytes.toString(), { exactNumbers: true });
    if (decoded.transformations.length > 0) throw new Error('bound_report_transformations_unsupported');
    report = decoded.value as RetainedReport;
  } catch (cause) { throw new ConvergeRunStateError('Original bound report is invalid JSON.', { cause }); }
  if (sha(bytes) !== binding.reportSha256 || binding.target !== target || binding.round !== round || binding.runId !== runId ||
      report?.run?.id !== runId || report.run?.converge?.target !== target || report.run?.converge?.round !== round) {
    throw new ConvergeRunStateError('Inconsistent immutable original report binding; refusing verdict mutation.');
  }
  return report;
}

function readBoundReport(binding: ReportBinding, target: string, round: number, runId: string,
  sources: RetainedSources, canonical = true): RetainedReport {
  const raw = sources.reports.get(binding.reportSha256);
  if (raw === undefined) throw new ConvergeRunStateError('Original bound report bytes unavailable; refusing content qualification.');
  sources.usedReports.add(binding.reportSha256);
  sources.pathRequirements.push({ kind: 'report', sha256: binding.reportSha256, storedPath: binding.sourcePath,
    ...(canonical ? { nativePathSuffix: `.evidence/${binding.reportSha256}.json` } : {}) });
  return verifyRoundBinding(binding, target, round, runId, raw);
}

const bindingSchema = z.object({
  runId: z.string().min(1), target: z.string().min(1), round: z.number().int().positive(),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/), sourcePath: z.string().min(1),
});
const sightingSchema = bindingSchema.omit({ sourcePath: true }).extend({
  findingRef: z.string().regex(/^f\d{3,}$/), reportKey: z.string().min(1), canonicalIdentity: z.string().min(1),
  claimDescriptor: claimDescriptorSchema,
  matchRationale: z.enum(['new_claim', 'exact_descriptor', 'supported_paraphrase', 'ambiguous', 'explicit_split']),
  status: z.enum(['new', 'repeat', 'suppressed', 'regating']), suppressReason: z.string().optional(),
  pendingRound: z.number().int().positive().nullable(),
  severity: z.enum(['critical', 'important', 'minor', 'nitpick']), gating: z.string().min(1), belowThreshold: z.boolean(),
  file: z.string(), category: z.string(), startLine: z.number().int().nonnegative(), endLine: z.number().int().nonnegative(),
});

/** All native consumers validate the same immutable sighting membership before effects. */
export function validateSemanticState(state: ConvergeRunState, sources: RetainedSources, recoveryLegacy?: ConvergeRunState,
  recoveryDismissalsByRound = new Map<number, ReadonlyMap<string, string>>()): void {
  try {
    validateSemanticMembership(state, sources, recoveryLegacy, recoveryDismissalsByRound);
  } catch (cause) {
    if (cause instanceof ConvergeRunStateError) throw cause;
    throw new ConvergeRunStateError('Invalid v2 sighting ledger or immutable source; refusing native mutation.', { cause });
  }
}

function validateSemanticMembership(state: ConvergeRunState, sources: RetainedSources, recoveryLegacy: ConvergeRunState | undefined,
  recoveryDismissalsByRound: ReadonlyMap<number, ReadonlyMap<string, string>>): void {
  const requireIntegrity = (valid: boolean): void => {
    if (!valid) throw new ConvergeRunStateError('Invalid v2 sighting ledger or immutable membership; refusing native mutation.');
  };
  requireIntegrity(Array.isArray(state.sightings));
  const sightings = state.sightings!;
  const originalTitles = new Map<typeof sightings[number], string>();
  const sightingsByRound = new Map<number, typeof sightings>();
  const sightingsByIdentity = new Map<string, typeof sightings>();
  const sightingsByIdentityAndRound = new Map<string, Map<number, typeof sightings>>();
  requireIntegrity(sightings.every(s => sightingSchema.safeParse(s).success));
  for (const sighting of sightings) {
    const roundMembers = sightingsByRound.get(sighting.round) ?? [];
    roundMembers.push(sighting); sightingsByRound.set(sighting.round, roundMembers);
    const identityMembers = sightingsByIdentity.get(sighting.canonicalIdentity) ?? [];
    identityMembers.push(sighting); sightingsByIdentity.set(sighting.canonicalIdentity, identityMembers);
    const identityRounds = sightingsByIdentityAndRound.get(sighting.canonicalIdentity) ?? new Map<number, typeof sightings>();
    const identityRoundMembers = identityRounds.get(sighting.round) ?? [];
    identityRoundMembers.push(sighting); identityRounds.set(sighting.round, identityRoundMembers);
    sightingsByIdentityAndRound.set(sighting.canonicalIdentity, identityRounds);
  }
  for (const anchor of recoveryAnchors(state)) {
    requireIntegrity((sightingsByIdentity.get(anchor.identity) ?? []).every(sighting =>
      sighting.file === anchor.source.file && sighting.category === anchor.source.category &&
      compareClaims(sighting.claimDescriptor, anchor.descriptor) !== undefined));
  }
  let legacy: ConvergeRunState | undefined = recoveryLegacy;
  if (state.migration !== undefined) {
    const migration = state.migration;
    requireIntegrity(!!migration && typeof migration === 'object' &&
      /^[a-f0-9]{64}$/.test(migration.sourceSha256) &&
      typeof migration.snapshotPath === 'string');
    sources.pathRequirements.push({ kind: 'migration', sha256: migration.sourceSha256, storedPath: migration.snapshotPath,
      nativePathSuffix: `.v1-${migration.sourceSha256}.snapshot` });
    try {
      const raw = sources.snapshots.get(migration.sourceSha256);
      requireIntegrity(raw !== undefined);
      const original = Buffer.from(raw!);
      requireIntegrity(sha(original) === migration.sourceSha256);
      legacy = decodeRecoveryDocument(original.toString()) as ConvergeRunState;
    } catch (cause) {
      throw new ConvergeRunStateError('Original v1 migration snapshot unavailable or invalid; refusing native mutation.', { cause });
    }
    requireIntegrity(!!legacy && legacy.version === 1 && legacy.target === state.target && Array.isArray(legacy.rounds) &&
      !!legacy.findings && typeof legacy.findings === 'object' && !Array.isArray(legacy.findings));
    for (const round of legacy!.rounds) {
      requireIntegrity(isDeepStrictEqual(state.rounds.find(r => r?.round === round.round), round));
    }
  }
  const rounds = new Set<number>();
  for (const round of state.rounds) {
    requireIntegrity(!!round && Number.isSafeInteger(round.round) && round.round > 0 && !rounds.has(round.round));
    rounds.add(round.round);
    const members = sightingsByRound.get(round.round) ?? [];
    if (legacy?.rounds.some(r => r.round === round.round)) {
      // Migrated legacy rounds deliberately have no semantic sightings. Their
      // exact snapshot is the boundary, not an invented descriptor or ref.
      requireIntegrity(members.length === 0);
      if (round.reportBinding) {
        requireIntegrity(bindingSchema.safeParse(round.reportBinding).success && round.runId === round.reportBinding.runId);
        readBoundReport(round.reportBinding, state.target, round.round, round.runId!, sources, false);
      }
      continue;
    }
    requireIntegrity(bindingSchema.safeParse(round.reportBinding).success && round.runId === round.reportBinding?.runId);
    const binding = round.reportBinding!;
    const report = readBoundReport(binding, state.target, round.round, round.runId!, sources);
    // Later semantic rounds must agree with the native cycle (including none).
    // Original legacy rounds remain bounded by their exact predecessor bytes.
    const cycleRun: unknown = report.run;
    requireIntegrity(object(cycleRun) && cycleRun.cycle_id === state.cycle?.id && (!state.cycle || object(cycleRun.target) &&
      typeof cycleRun.target.repo === 'string' && cycleRun.target.repo.toLowerCase() === state.cycle.repo.toLowerCase() &&
      cycleRun.target.pr_number === state.cycle.prNumber));
    requireIntegrity(Array.isArray(report.findings) && (report.belowThresholdFindings === undefined || Array.isArray(report.belowThresholdFindings)));
    const all = [...report.findings, ...(report.belowThresholdFindings ?? [])];
    // A genuinely empty legacy report can start v2, but its descriptor-less
    // appendix is not retroactively claimed as semantic evidence.
    const described = all.some(f => f?.claimDescriptor !== undefined);
    const original = described ? all : report.findings;
    requireIntegrity(members.length === original.length);
    const counts = { new: 0, repeat: 0, suppressed: 0, regating: 0 };
    const severities: Record<string, ConsensusFinding['severity']> = {};
    const reportKeys = new Set<string>();
    for (let i = 0; i < members.length; i++) {
      const sighting = members[i]!; const finding = original[i]!;
      requireIntegrity(!!finding && claimDescriptorSchema.safeParse(finding.claimDescriptor).success &&
        typeof finding.identity === 'string' && finding.identity.startsWith(`report:${binding.runId}:`) && !reportKeys.has(finding.identity));
      reportKeys.add(finding.identity!);
      const entry = state.findings[sighting.canonicalIdentity];
      requireIntegrity(!!entry && entry.key === sighting.canonicalIdentity && claimDescriptorSchema.safeParse(entry.claimDescriptor).success &&
        entry.file === finding.file && entry.category === finding.category &&
        (isDeepStrictEqual(entry.claimDescriptor, finding.claimDescriptor) || compareClaims(entry.claimDescriptor!, finding.claimDescriptor!) !== undefined));
      const expected = { runId: binding.runId, target: binding.target, round: binding.round, reportSha256: binding.reportSha256,
        findingRef: `f${String(i + 1).padStart(3, '0')}`, reportKey: finding.identity, claimDescriptor: finding.claimDescriptor,
        severity: finding.severity, gating: i < report.findings.length ? findingGatingReason(finding) : 'none',
        belowThreshold: i >= report.findings.length, file: finding.file, category: finding.category, startLine: finding.startLine, endLine: finding.endLine };
      for (const key of Object.keys(expected) as Array<keyof typeof expected>) requireIntegrity(isDeepStrictEqual(sighting[key], expected[key]));
      requireIntegrity(typeof finding.title === 'string');
      originalTitles.set(sighting, finding.title);
      requireIntegrity(sighting.endLine >= sighting.startLine);
      requireIntegrity(sighting.pendingRound === null || (Number.isSafeInteger(sighting.pendingRound) && sighting.pendingRound <= sighting.round));
      if (sighting.gating !== 'none' && (sighting.status === 'new' || sighting.status === 'regating')) {
        requireIntegrity(sighting.pendingRound === sighting.round);
      }
      counts[sighting.status]++;
      const prior = severities[sighting.canonicalIdentity];
      if (prior === undefined || DEFAULT_SEVERITY_ORDER.indexOf(sighting.severity) < DEFAULT_SEVERITY_ORDER.indexOf(prior)) {
        severities[sighting.canonicalIdentity] = sighting.severity;
      }
    }
    requireIntegrity(isDeepStrictEqual(counts, round.counts) && isDeepStrictEqual(severities, round.severities));
  }
  requireIntegrity(sightings.every(s => rounds.has(s.round)));
  validateSightingClassification(state, sightingsByIdentityAndRound, requireIntegrity, recoveryDismissalsByRound);
  if (legacy) {
    // Semantic admission never replaces or removes migrated original entries.
    requireIntegrity(Object.keys(legacy.findings).every(key => Object.hasOwn(state.findings, key)));
  }
  for (const [key, entry] of Object.entries(state.findings)) {
    requireIntegrity(!!entry && typeof entry === 'object' && entry.key === key);
    const legacyOriginal = legacy?.findings[key];
    if (entry.verdict !== undefined) {
      requireIntegrity((entry.verdict === 'fixed' || entry.verdict === 'dismissed') &&
        Number.isSafeInteger(entry.verdictRound) && rounds.has(entry.verdictRound!));
      const reviewed = state.rounds.find(r => r.round === entry.verdictRound)!;
      const unchangedImplicitLegacySeverity = legacyOriginal?.verdict !== undefined &&
        legacyOriginal.verdict === entry.verdict && legacyOriginal.verdictRound === entry.verdictRound &&
        legacyOriginal.verdictSeverity === undefined && entry.verdictSeverity === undefined;
      requireIntegrity(reviewed.severities === undefined ||
        (reviewed.severities[key] !== undefined &&
          (entry.verdictSeverity === reviewed.severities[key] || unchangedImplicitLegacySeverity)));
    } else {
      requireIntegrity(entry.verdictRound === undefined && entry.verdictSeverity === undefined);
    }
    if (entry.claimDescriptor === undefined) {
      const original = legacyOriginal;
      requireIntegrity(!!original && original.claimDescriptor === undefined);
      if (original!.verdict !== undefined) {
        requireIntegrity(entry.verdict !== undefined && entry.verdictRound! >= (original!.verdictRound ?? 0));
      }
      const identityFields = (value: FindingEntry) => Object.fromEntries(Object.entries(value)
        .filter(([field]) => !['pendingRound', 'verdict', 'verdictRound', 'verdictSeverity', 'verdictReason'].includes(field)));
      requireIntegrity(isDeepStrictEqual(identityFields(entry), identityFields(original!)));
      const initialPending = recoveryLegacy ? original!.pendingRound : migratedLegacyPendingRound(original!, legacy!);
      const expectedPending = initialPending !== undefined &&
        !(entry.verdict !== undefined && verdictClearsPending(state, key, initialPending, entry.verdictRound!, entry.verdictSeverity)) ? initialPending : undefined;
      requireIntegrity(entry.pendingRound === expectedPending);
      continue;
    }
    const members = sightingsByIdentity.get(key) ?? [];
    requireIntegrity(members.length > 0 && claimDescriptorSchema.safeParse(entry.claimDescriptor).success &&
      entry.firstRound === Math.min(...members.map(s => s.round)) && entry.lastRound === Math.max(...members.map(s => s.round)) &&
      members.some(s => s.round === entry.firstRound && isDeepStrictEqual(s.claimDescriptor, entry.claimDescriptor)));
    requireIntegrity(semanticCacheMatches(entry, members, originalTitles));
    const byRound = sightingsByIdentityAndRound.get(key)!;
    let latestGatedRound: number | null = null;
    let latestGatedRoundAfterVerdict: number | null = null;
    for (const [round, group] of [...byRound].sort(([a], [b]) => a - b)) {
      if (group.some(s => s.gating !== 'none' && s.status !== 'suppressed')) {
        latestGatedRound = round;
        if (entry.verdict === undefined || !verdictClearsPending(state, key, round, entry.verdictRound!, entry.verdictSeverity)) {
          latestGatedRoundAfterVerdict = round;
        }
      }
      requireIntegrity(group.every(s => s.pendingRound === group[0]!.pendingRound));
      const capturedPending = group[0]!.pendingRound;
      requireIntegrity(capturedPending === null || byRound.get(capturedPending)?.some(s =>
        s.gating !== 'none' && s.status !== 'suppressed') === true);
      if (group.every(s => s.status === 'suppressed')) continue;
      // A verdict is recorded after its round's sightings, so it can clear the
      // obligation carried by later sightings without rewriting that round's
      // immutable capture. A weaker verdict cannot clear a critical source.
      const expectedCaptured = entry.verdict !== undefined && entry.verdictRound! < round ?
        latestGatedRoundAfterVerdict : latestGatedRound;
      requireIntegrity(capturedPending === expectedCaptured);
    }
    const latestPending = byRound.get(entry.lastRound)![0]!.pendingRound;
    const expectedPending = latestPending !== null &&
      !(entry.verdict !== undefined && verdictClearsPending(state, key, latestPending, entry.verdictRound!, entry.verdictSeverity)) ? latestPending : undefined;
    requireIntegrity(entry.pendingRound === expectedPending);
  }
  const latest = Math.max(0, ...rounds);
  if (latest && !legacy?.rounds.some(r => r.round === latest)) {
    requireIntegrity(isDeepStrictEqual(state.lastAnnotations, { round: latest, identities: (sightingsByRound.get(latest) ?? [])
      .map(s => ({ identity: s.canonicalIdentity, status: s.status, gating: s.gating })) }));
  }
}


/** @internal Pure retained-history projection used by validation regressions. */
export function recoveredDismissalsBefore(dismissalsByRound: ReadonlyMap<number, ReadonlyMap<string, string>>, round: number): ReadonlyMap<string, string> {
  const selected = new Map<string, string>();
  for (const [sourceRound, dismissals] of [...dismissalsByRound].sort(([a], [b]) => a - b)) {
    if (sourceRound >= round) continue;
    for (const [identity, severity] of dismissals) selected.set(identity, severity);
  }
  return selected;
}

/** @internal Index retained dismissal history once for bounded per-identity lookups. */
export function createRecoveredDismissalLookup(
  dismissalsByRound: ReadonlyMap<number, ReadonlyMap<string, string>>,
): (round: number, identity: string) => string | undefined {
  const histories = new Map<string, Array<{ round: number; severity: string }>>();
  for (const [round, dismissals] of [...dismissalsByRound].sort(([a], [b]) => a - b)) {
    for (const [identity, severity] of dismissals) {
      const values = histories.get(identity) ?? [];
      values.push({ round, severity });
      histories.set(identity, values);
    }
  }
  return (round, identity) => {
    const values = histories.get(identity);
    if (!values) return undefined;
    let low = 0; let high = values.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (values[middle]!.round < round) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? undefined : values[low - 1]!.severity;
  };
}

function validateSightingClassification(state: ConvergeRunState,
  sightingsByIdentityAndRound: ReadonlyMap<string, ReadonlyMap<number, NonNullable<ConvergeRunState['sightings']>>>,
  requireIntegrity: (valid: boolean) => void, recoveryDismissalsByRound: ReadonlyMap<number, ReadonlyMap<string, string>>): void {
  if (state.version === 1) return;
  const anchored = new Set(state.version === 3 ? recoveryAnchors(state).map(anchor => anchor.identity) : []);
  const recoveryDismissalsForRound = createRecoveredDismissalLookup(recoveryDismissalsByRound);
  for (const [key, entry] of Object.entries(state.findings)) {
    if (entry.claimDescriptor === undefined) continue;
    const byRound = sightingsByIdentityAndRound.get(key) ??
      new Map<number, NonNullable<ConvergeRunState['sightings']>>();
    if (byRound.size === 0) continue;
    const firstRound = Math.min(...byRound.keys());
    for (const [round, group] of byRound) {
      const ordinaryVerdict = (entry.verdictRound ?? Infinity) < round;
      const recoveryDismissal = recoveryDismissalsForRound(round, key);
      const recoveredEscalation = !ordinaryVerdict && group.some(row => row.severity === 'critical') &&
        recoveryDismissal !== undefined && recoveryDismissal !== 'critical';
      const expectedStatus = state.version === 2 ? round === firstRound ? 'new' : undefined
        : recoveredEscalation ? 'regating' : round === firstRound
          ? anchored.has(key) ? 'repeat' : 'new'
          : entry.verdict === undefined ? 'repeat'
          : ordinaryVerdict ? entry.verdict === 'dismissed' && group.some(row => row.severity === 'critical') && entry.verdictSeverity !== 'critical'
            ? 'regating' : entry.verdict === 'dismissed' ? 'suppressed' : 'repeat'
            : undefined;
      if (expectedStatus !== undefined) {
        requireIntegrity(group.every(row => row.status === expectedStatus));
        if (expectedStatus === 'suppressed') {
          const reason = `dismissed in round ${entry.verdictRound}${entry.verdictReason ? ` (${entry.verdictReason})` : ''} — matching semantic claim; escalation to critical re-gates`;
          requireIntegrity(group.every(row => row.suppressReason === reason));
        }
      } else {
        // A later ordinary verdict overwrites the prior verdict's reason and
        // severity. The retained schema cannot reconstruct that old decision,
        // but it can still rule out a fresh classification.
        requireIntegrity(group.every(row => row.status !== 'new'));
      }
      for (const sighting of group) {
        // v2 retained the original producer's later match rationale without a
        // replayable classification protocol. Its first semantic sighting is
        // still immutable, while v3 replays every later descriptor match.
        if (state.version === 2 && round > firstRound) continue;
        const match = compareClaims(sighting.claimDescriptor, entry.claimDescriptor!);
        if (round > firstRound || sighting.matchRationale === 'exact_descriptor' || sighting.matchRationale === 'supported_paraphrase') {
          requireIntegrity(match === sighting.matchRationale);
        } else {
          requireIntegrity(sighting.matchRationale === 'new_claim' || sighting.matchRationale === 'ambiguous');
        }
      }
    }
  }
}
