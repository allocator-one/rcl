import { describe,expect,it } from 'vitest';
import { deriveCurrentClaimProjection,nativeProjectionFingerprint,recoveryProjectionFreshness } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { packNativeMaterial } from '../../src/evidence/claim-recovery/validation/native-material.js';
import { correctionAnchor } from '../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimDisposition,prepareObligationTransfer } from '../../src/evidence/claim-recovery/validation/occurrence.js';
import { fixture,laterSource,rebind } from './recovery-validation/occurrence-fixtures.js';
import { sha,uuid } from './recovery-validation/fixtures.js';
import { sampleResult,sampleReview } from '../telemetry/fixtures.js';
import { projection } from './original-run-fixtures.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import type { ClaimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
const floor='2026-09-22T13:00:00.123456Z';
export function setup(verdict: 'fixed'|'dismissed'='fixed',nongating=false) {
  const f=fixture();
  if(nongating) { f.report.findings[0].gating.reason='none'; rebind(f.disposition,f.report); }
  const split=f.transfer.split;
  const state=JSON.parse(split.selection.nativeJson);
  const anchor=correctionAnchor(split.selection,split.receipt,split.actorUserId,uuid(99));
  f.transfer.eventId=uuid(21);
  f.disposition.eventId=uuid(22);
  f.disposition.verdict=verdict;
  const transfer={
    preparation: f.transfer,actorUserId: f.transfer.actorUserId,receipt: {
      ...split.source.scope,...prepareObligationTransfer(f.transfer).event,
      actor_user_id: f.transfer.actorUserId,attempt: null,sequence: 4,received_at: floor
    }
  };
  const disposition={
    preparation: f.disposition,actorUserId: f.disposition.actorUserId,receipt: {
      ...split.source.scope,...prepareClaimDisposition(f.disposition).event,
      actor_user_id: f.disposition.actorUserId,attempt: null,sequence: 5,received_at: floor
    }
  };
  const history: ClaimHistoryContent={ actorUserId: f.disposition.actorUserId,readWindow: { startedAt: '2026-09-23T00:00:00.000Z',completedAt: '2026-09-23T00:00:01.000Z' },sources: [],histories: [] };
  function add(source: typeof split.source,receipts=[source.classification,...source.corrections]) {
    source.storedRun.received_at??=source.classification.received_at;
    history.sources.push({
      selector: {
        scope: source.scope,target: state.target,round: source.classification.round!,headSha: (source.storedRun.target as any).head_sha,
        reportSha256: sha(source.reportJson)
      },reportJson: source.reportJson,storedRun: source.storedRun,classifications: [source.classification],corrections: source.corrections,correctionIds: source.corrections.map(r => r.id)
    });
    history.histories.push({ runId: source.scope.run_id,eventSequence: Math.max(...receipts.map(r => r.sequence)),receipts });
  }
  add(split.source,[split.source.classification,f.originalVerdict,split.receipt,transfer.receipt,disposition.receipt]);
  function confirm(change?: (report: any,stored: any,event: any) => void) {
    const report=sampleResult({ reviews: [sampleReview({ model: 'a' }),sampleReview({ model: 'b' }),sampleReview({ model: 'c',status: 'timeout' })],findings: [],belowThresholdFindings: [] }) as any;
    report.run.id=uuid(900);
    report.run.target={ ...report.run.target,repo: split.source.scope.repo,pr_number: split.source.scope.pr_number };
    report.run.converge={ target: state.target,round: 2,attempt: 2 };
    report.run.roster=report.reviews.map((r: any) => ({ model: r.model,role: r.role,provider: r.provider,lane: 'blocking' }));
    report.run.started_at='2026-09-22T13:00:00.123457Z';
    report.run.finished_at='2026-09-22T14:00:00.000000Z';
    const stored: any={ repo_verified: true,is_cross_repository: false,received_at: '2026-09-22T14:01:00.000000Z' };
    const event: any={
      ...split.source.classification,id: uuid(901),run_id: report.run.id,round: 2,attempt: 2,sequence: 1,
      received_at: '2026-09-22T14:02:00.000000Z',payload: { classification_version: 1,identities: [] }
    };
    change?.(report,stored,event);
    const raw=JSON.stringify(report);
    Object.assign(stored,projection(buildRunEnvelope(report,{ report_json: raw },{ level: 'full',delivery: { mode: 'direct' } }),{ report_json: 'present' }));
    event.payload.report_json_sha256=sha(raw);
    add({ scope: { ...split.source.scope,run_id: report.run.id },reportJson: raw,storedRun: stored,classification: event,corrections: [] });
  }
  const run=(version: 1|2=2) => deriveCurrentClaimProjection(state,[anchor],[{ transfers: [transfer],dispositions: [disposition],carriers: [],pendingIdentities: [] } as any],history,[],split.selection.nativeJson,version);
  return { f,state,anchor,history,transfer,disposition,add,confirm,run };
}
