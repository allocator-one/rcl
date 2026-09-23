import type { NativeMaterialReference } from './native-material.js';
import type { NativeOccurrenceEvidence } from './native-occurrences.js';
import type { ConsensusFinding, ReviewResult } from '../../../consensus/types.js';
import type { ClaimDescriptor, MatchRationale } from './claims.js';
import type { NativeCorrectionAnchor } from './anchors.js';
import type { EventReceipt } from './receipts.js';

export interface RetainedFinding extends ConsensusFinding { claimDescriptor?: ClaimDescriptor }
export interface RetainedReport extends Omit<ReviewResult, 'findings' | 'belowThresholdFindings'> {
  findings: RetainedFinding[]; belowThresholdFindings?: RetainedFinding[];
}
export interface NativeRecoveryOperation {
  operationId: string; sourceVersion: 1 | 2 | 3; sourceSha256: string;
  anchors: NativeCorrectionAnchor[]; sourceReceipts: EventReceipt[]; occurrences?: NativeOccurrenceEvidence; material?: NativeMaterialReference;
}
export interface NativeRecoveryMetadata { version: 1 | 2; operations: NativeRecoveryOperation[] }
export type FindingVerdict = 'fixed' | 'dismissed';

export interface FindingEntry {
  key: string;
  file: string;
  category: string;
  startLine: number;
  endLine: number;
  title: string;
  severity: string;
  models: string[];
  firstRound: number;
  lastRound: number;
  verdict?: FindingVerdict;
  verdictReason?: string;
  verdictRound?: number;
  /**
   * Severity at the moment the verdict was recorded (RCL-30). A dismissal is
   * terminal on that evidence; only escalation past it re-gates. Absent on
   * pre-2.1.1 states — the retained `severity` is frozen before new sightings.
   */
  verdictSeverity?: string;
  claimDescriptor?: ClaimDescriptor;
  pendingRound?: number;
}

export interface RoundCounts {
  new: number;
  repeat: number;
  suppressed: number;
  regating: number;
}

export interface ConvergeRunState {
  version: 1 | 2 | 3;
  recovery?: NativeRecoveryMetadata;
  sightings?: SemanticSighting[];
  migration?: { sourceSha256: string; snapshotPath: string; migratedAt: string };
  target: string;
  roundCap: number;
  /** `runId` is the report's `run.id` (rcl ≥ 3.0), which converge-verdict sends with every verdict. */
  rounds: Array<{
    round: number;
    counts: RoundCounts;
    runId?: string;
    reportBinding?: ReportBinding;
    /** Strongest sighting per identity in this round, including for delayed verdicts. Absent in legacy state. */
    severities?: Record<string, ConsensusFinding['severity']>;
  }>;
  findings: Record<string, FindingEntry>;
  updatedAt: string;
  /**
   * The most recent round's classified identities (RCL-30), so
   * `converge-verdict` can decide the round's resolution — in particular
   * whether a dismissal-only round converges — without re-reading the report.
   * Replaced whenever a round is processed; absent on pre-2.1.1 states.
   */
  lastAnnotations?: {
    round: number;
    identities: Array<{ identity: string; status: FindingStatus; gating: string }>;
  };
}

export type FindingStatus = 'new' | 'repeat' | 'suppressed' | 'regating';

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
  /** Obligation immediately after this sighting, before subsequent verdicts. */
  pendingRound: number | null;
  suppressReason?: string;
  severity: ConsensusFinding['severity'];
  gating: string;
  belowThreshold: boolean;
  file: string;
  category: string;
  startLine: number;
  endLine: number;
}
