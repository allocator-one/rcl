import { describe, expect, it } from 'vitest';
import { MAX_CARRIER_INVENTORY, MAX_CARRIER_PREFIX_ROUNDS, projectOccurrenceCarrier } from '../../../src/evidence/claim-recovery/validation/carrier-projection.js';
import { accepted, carrier, inventory, projectionFixture, roundInput } from './carrier-fixtures.js';
import { laterSource } from './occurrence-fixtures.js';
import type { CarrierSourceInventory } from '../../../src/evidence/claim-recovery/validation/carrier-types.js';
import { sha, uuid } from './fixtures.js';

function correction(row: CarrierSourceInventory, ref: number, sequence = 2) {
  const classification = row.classifications![0]; const report = JSON.parse(row.reportJson!);
  const member = [...report.findings, ...report.belowThresholdFindings][ref - 1];
  const receipt = { ...classification, id: uuid(800 + ref), kind: 'finding_identity_corrected', actor_user_id: uuid(7),
    sequence, received_at: '2026-09-22T14:30:00.123456Z', payload: { org_id: row.selector.scope.org_id,
      repo: row.selector.scope.repo, pr_number: row.selector.scope.pr_number, head_sha: row.selector.headSha,
      report_json_sha256: row.selector.reportSha256, finding_ref: `f00${ref}`, identity_key: member.identity,
      matched_identity: 'ffffffffffffffff' } };
  row.correctionIds!.push(receipt.id); row.corrections!.push(receipt); return receipt;
}

describe('supplied-inventory occurrence carrier projection', () => {
  it('enumerates all kept and appendix occurrences with exact source and carrier selectors', () => {
    const { projection: input } = projectionFixture(); const before = structuredClone(input);
    const out = projectOccurrenceCarrier(input);
    expect(out.carrier).toEqual(input.carrier); expect(out.qualification).toBe('supplied-inventory-content-only');
    expect(out.occurrences.map(o => o.selector.findingRef)).toEqual(['f001', 'f002', 'f003']);
    expect(out.residuals.filter(r => r.reason === 'untransferred-occurrence')).toHaveLength(3);
    expect(out.occurrences[2].selector).toMatchObject({ source: input.sources[0].selector,
      classificationId: input.carrier.classificationId, correctionId: null, reportKey: 'raw-appendix' });
    expect(out.coverage).toBe('residuals-present'); expect(input).toEqual(before);
  });

  it('an exact receipt transfers one occurrence, leaving co-key siblings pending', () => {
    const { input, projection } = projectionFixture(); projection.transfers = [accepted(input)];
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toHaveLength(1); expect(out.occurrences[0].transferEventId).toBe(projection.transfers[0].receipt.id);
    expect(out.residuals.filter(r => r.reason === 'untransferred-occurrence').map(r => r.occurrence!.findingRef)).toEqual(['f002', 'f003']);
    expect(out.transfers[0]).toMatchObject({ actorUserId: uuid(8), splitActorUserId: uuid(7),
      receivedAt: '2026-09-22T15:00:00.123456Z', sequence: 21 });
  });

  it('all transfers cover this supplied carrier without resolving or approving destination claims', () => {
    const { input, projection } = projectionFixture(); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    const out = projectOccurrenceCarrier(projection);
    expect(out.coverage).toBe('no-residuals-in-supplied-content'); expect(out.transfers).toHaveLength(3);
    expect(out.residuals).toEqual([]); expect(out.occurrences.every(o => o.transferEventId)).toBe(true);
    expect(out).not.toHaveProperty('approved'); expect(out).not.toHaveProperty('verdict');
  });

  it('checks a real legacy prefix, including empty rounds, without inventing findings in the carrier', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    const before = structuredClone(projection); const out = projectOccurrenceCarrier(projection);
    expect(out.inspectedRounds.map(r => r.round)).toEqual([1, 2, 3]); expect(out.residuals).toEqual([]);
    expect(out.occurrences).toHaveLength(3); expect(out.occurrences.every(o => o.selector.source.round === 1)).toBe(true);
    expect(projection).toEqual(before);
  });

  it('missing an empty original round prevents prefix closure even when every known member transferred', () => {
    const { input, projection } = projectionFixture(true); projection.sources.splice(1, 1);
    projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toHaveLength(3); expect(out.coverage).toBe('residuals-present');
    expect(out.residuals).toContainEqual({ reason: 'round-missing', round: 2, runIds: [] });
  });

  it.each(['run', 'artifact', 'classification', 'correction'])('keeps unavailable %s evidence explicit and preserves prior receipts', missing => {
    const { input, projection } = projectionFixture(true); projection.transfers = [accepted(input)];
    const source = projection.sources[0];
    if (missing === 'run') source.storedRun = null;
    if (missing === 'artifact') source.reportJson = null;
    if (missing === 'classification') source.classifications = [];
    if (missing === 'correction') { source.correctionIds = [uuid(99)]; source.corrections = []; }
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toHaveLength(1);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: `${missing}-unavailable`, source: source.selector }));
  });

  it('unmapped legacy appendix members remain unresolved even when all known kept members transfer', () => {
    const { input, projection } = projectionFixture();
    (projection.sources[0].classifications![0].payload.identities as any[]).pop();
    projection.transfers = [accepted(input, 1), accepted(input, 2)];
    // Released unmarked classifications genuinely omit this appendix member in
    // both inventories; do not model contradictory copies of one receipt here.
    for (const proof of projection.transfers) {
      (proof.preparation.split.source.classification.payload.identities as any[]).pop();
    }
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toHaveLength(2);
    expect(out.residuals.some(r => r.reason === 'classification-conflict')).toBe(false);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'classification-unavailable',
      occurrence: expect.objectContaining({ findingRef: 'f003', reportKey: 'raw-appendix' }) }));
  });

  it('later supplied older evidence reopens residuals while preserving already accepted occurrence transfers', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    const first = projectOccurrenceCarrier(projection); expect(first.residuals).toEqual([]);
    const extra = inventory(roundInput(2).split.source); projection.sources.push(extra);
    const next = projectOccurrenceCarrier(projection);
    expect(next.transfers).toEqual(first.transfers);
    expect(next.residuals).toContainEqual(expect.objectContaining({ reason: 'round-conflict', round: 2,
      runIds: expect.arrayContaining([extra.selector.scope.run_id]) }));
    expect(next.residuals.filter(r => r.reason === 'untransferred-occurrence').every(r => r.occurrence!.source.round === 2)).toBe(true);
    expect(next.residuals.filter(r => r.reason === 'untransferred-occurrence')).toHaveLength(3);
  });

  it('a later independent carrier with the same bare key cannot clear this carrier', () => {
    const { projection } = projectionFixture(); const other = accepted(roundInput(2)); projection.transfers = [other];
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toEqual([]); expect(out.ignoredTransferEventIds).toEqual([other.receipt.id]);
    expect(out.occurrences.every(o => o.transferEventId === null)).toBe(true);
  });

  it('ignores other-target/source inventories without borrowing their apparent empty coverage', () => {
    const { input, projection } = projectionFixture(); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    const other = structuredClone(projection.sources[0]); other.selector.target = 'another-target'; projection.sources.push(other);
    const out = projectOccurrenceCarrier(projection);
    expect(out.residuals).toEqual([]); expect(out.ignoredSources).toEqual([other.selector]);
  });

  it.each(['actor', 'payload', 'microsecond', 'sequence', 'missing-time'])('refuses a transfer with %s drift', change => {
    const { input, projection } = projectionFixture(); const transfer = accepted(input); projection.transfers = [transfer];
    if (change === 'actor') transfer.receipt.actor_user_id = uuid(99);
    if (change === 'payload') transfer.receipt.payload.claim_identity = 'ffffffffffffffff';
    if (change === 'microsecond') transfer.receipt.occurred_at = '2026-09-22T13:00:00.123458Z';
    if (change === 'sequence') transfer.receipt.sequence = 1;
    if (change === 'missing-time') delete (transfer.receipt as any).received_at;
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toEqual([]); expect(out.occurrences[0].transferEventId).toBeNull();
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'transfer-invalid', eventIds: [transfer.receipt.id] }));
  });

  it('exact replay is one receipt but distinct UUIDs for the same selector remain a conflict', () => {
    const { input, projection } = projectionFixture(); const transfer = accepted(input);
    projection.transfers = [transfer, structuredClone(transfer)]; expect(projectOccurrenceCarrier(projection).transfers).toHaveLength(1);
    const conflicting = structuredClone(transfer); conflicting.preparation.eventId = uuid(999); conflicting.receipt.id = uuid(999);
    conflicting.receipt.sequence = 30; projection.transfers.push(conflicting);
    const out = projectOccurrenceCarrier(projection); expect(out.transfers).toEqual([]);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'transfer-conflict' }));
  });

  it('distinct events cannot share a server sequence in the same carrier run', () => {
    const { input, projection } = projectionFixture(); projection.transfers = [accepted(input, 1), accepted(input, 2)];
    projection.transfers[1].receipt.sequence = projection.transfers[0].receipt.sequence;
    expect(projectOccurrenceCarrier(projection).transfers).toEqual([]);
    expect(projectOccurrenceCarrier(projection).residuals).toContainEqual(expect.objectContaining({ reason: 'transfer-conflict' }));
  });

  it('retains predecessor run IDs absent from the prefix and does not invent missing native origins', () => {
    const { input, projection } = projectionFixture(true); const native = JSON.parse(input.split.selection.nativeJson);
    native.rounds.push({ round: 2, runId: uuid(999), counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } });
    native.rounds.push({ round: 3, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } });
    const sourceJson = JSON.stringify(native); projection.nativePredecessors = [{ sourceJson }];
    const out = projectOccurrenceCarrier(projection);
    expect(out.residuals).toContainEqual({ reason: 'native-source-unlisted', round: 2, nativeRunId: uuid(999), nativeSha256: sha(sourceJson) });
    expect(out.residuals).toContainEqual({ reason: 'native-run-id-unavailable', round: 3, nativeSha256: sha(sourceJson) });
    expect(projection.nativePredecessors[0].sourceJson).toBe(sourceJson);
  });

  it.each(['incomplete', 'truncated'] as const)('never hides an explicitly %s inventory behind successful transfers', inventoryStatus => {
    const { input, projection } = projectionFixture(); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    projection.inventoryStatus = inventoryStatus; const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toHaveLength(3); expect(out.coverage).toBe('residuals-present');
    expect(out.residuals).toContainEqual({ reason: `inventory-${inventoryStatus}` });
  });

  it('is deterministic under inventory order and never mutates original accounting/evidence', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [accepted(input, 2), accepted(input, 1)];
    const before = JSON.stringify(projection); const first = projectOccurrenceCarrier(projection);
    expect(JSON.stringify(projection)).toBe(before);
    const reordered = structuredClone(projection); reordered.sources.reverse(); reordered.transfers.reverse();
    expect(projectOccurrenceCarrier(reordered)).toEqual(first);
    first.carrier.identity = 'ffffffffffffffff'; expect(projection.carrier.identity).toBe(input.carrierIdentity);
  });

  it('a per-ref historical correction cannot retire a carrier occurrence without a transfer receipt', () => {
    const { projection } = projectionFixture(); correction(projection.sources[0], 1);
    const out = projectOccurrenceCarrier(projection);
    expect(out.occurrences).toHaveLength(3); expect(out.occurrences.every(o => o.transferEventId === null)).toBe(true);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'source-mapping-changed',
      occurrence: expect.objectContaining({ findingRef: 'f001', correctionId: uuid(801) }) }));
  });

  it('new source correction evidence leaves the historical transfer intact but reopens exact source binding', () => {
    const { input, projection } = projectionFixture(); projection.transfers = [accepted(input)];
    correction(projection.sources[0], 1); const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toHaveLength(1); expect(out.occurrences.find(o => o.selector.findingRef === 'f001')!.transferEventId).toBeNull();
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'transfer-source-conflict' }));
  });

  it('missing the entire original run leaves accepted transfers and exact source selectors visible', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [accepted(input)]; projection.sources.shift();
    const out = projectOccurrenceCarrier(projection); expect(out.transfers).toHaveLength(1);
    expect(out.residuals).toContainEqual({ reason: 'source-unlisted', occurrence: out.transfers[0].occurrence });
    expect(out.residuals).toContainEqual({ reason: 'round-missing', round: 1, runIds: [] });
  });

  it.each(['report', 'head', 'classification', 'correction'])('keeps conflicting %s source content residual', drift => {
    const { projection } = projectionFixture(); const row = projection.sources[0];
    if (drift === 'report') row.reportJson += ' ';
    if (drift === 'head') row.selector.headSha = 'b'.repeat(40);
    if (drift === 'classification') row.classifications!.push({ ...row.classifications![0], id: uuid(909) });
    if (drift === 'correction') { correction(row, 1); row.correctionIds = []; }
    const out = projectOccurrenceCarrier(projection); expect(out.coverage).toBe('residuals-present');
    expect(out.residuals).toContainEqual(expect.objectContaining({ source: row.selector,
      reason: drift === 'classification' ? 'classification-conflict' : drift === 'correction' ? 'correction-conflict' : 'source-conflict' }));
  });

  it('conflicting classification event UUIDs across prefix runs cannot prove supplied completeness', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    projection.sources[1].classifications![0].id = projection.sources[0].classifications![0].id;
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toHaveLength(3); expect(out.coverage).toBe('residuals-present');
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'classification-conflict' }));
  });

  it('two correction UUIDs cannot occupy the same per-run sequence', () => {
    const { projection } = projectionFixture(); correction(projection.sources[0], 1); correction(projection.sources[0], 2);
    expect(projectOccurrenceCarrier(projection).residuals).toContainEqual(expect.objectContaining({ reason: 'correction-conflict' }));
  });

  it('the transfer acceptance timestamp cannot precede a selected carrier correction', () => {
    const { input, projection } = projectionFixture(true); const source = laterSource(input, 3);
    source.classification.payload.legacy_pending_identities = [input.carrierIdentity];
    const row = inventory(source); const receipt = correction(row, 1);
    receipt.received_at = '2026-09-22T16:00:00.000001Z'; source.corrections = row.corrections!;
    input.carrier = source; input.carrierContext = { ...row.selector, actorUserId: input.actorUserId, eventSequence: 2 };
    projection.carrier = carrier(source, input.carrierIdentity, 'legacy_pending'); projection.sources[2] = row;
    projection.transfers = [accepted(input)]; const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toEqual([]); expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'transfer-invalid' }));
  });

  it('a transfer UUID colliding with an unrelated prefix event cannot cover the supplied carrier', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    projection.sources[1].classifications![0].id = projection.transfers[0].receipt.id;
    const out = projectOccurrenceCarrier(projection);
    expect(out.coverage).toBe('residuals-present'); expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'transfer-conflict' }));
  });

  it('invalid native lineage stays explicit instead of being used as an absence proof', () => {
    const { projection } = projectionFixture(); const sourceJson = '{"version":3}';
    projection.nativePredecessors = [{ sourceJson }]; const out = projectOccurrenceCarrier(projection);
    expect(out.residuals).toContainEqual({ reason: 'native-source-invalid', nativeSha256: sha(sourceJson) });
  });

  it('caps supplied inventories without silently treating a partial scan as complete', () => {
    const { projection } = projectionFixture(); projection.sources = Array(MAX_CARRIER_INVENTORY + 1).fill(projection.sources[0]);
    const out = projectOccurrenceCarrier(projection);
    expect(out.coverage).toBe('residuals-present'); expect(out.residuals).toEqual([{ reason: 'inventory-limit' }]);
  });

  it('caps legacy numeric prefixes instead of allocating attacker-controlled round counts', () => {
    const { projection } = projectionFixture(true); projection.carrier.round = MAX_CARRIER_PREFIX_ROUNDS + 1;
    const out = projectOccurrenceCarrier(projection); expect(out.inspectedRounds).toHaveLength(3);
    expect(out.residuals).toContainEqual({ reason: 'prefix-limit', round: MAX_CARRIER_PREFIX_ROUNDS + 1 });
  });

  it('does not borrow future rounds for an earlier carrier', () => {
    const { projection } = projectionFixture(true); const future = inventory(roundInput(4).split.source); projection.sources.push(future);
    const out = projectOccurrenceCarrier(projection); expect(out.ignoredSources).toEqual([future.selector]);
    expect(out.occurrences.every(o => o.selector.source.round <= 3)).toBe(true);
  });


  it('two accepted transfers cannot bind different split events to the same split UUID', () => {
    const { input, projection } = projectionFixture(); projection.transfers = [accepted(input, 1), accepted(input, 2)];
    const [first, second] = projection.transfers;
    second.preparation.split.selection.eventId = first.preparation.split.selection.eventId;
    second.preparation.split.receipt.id = first.preparation.split.receipt.id;
    second.receipt.payload.split_event_id = first.preparation.split.receipt.id;
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toEqual([]); expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'transfer-conflict' }));
  });


  it.each(['actor', 'sequence', 'receipt-time', 'payload'])('retains transfers but exposes inventory/proof classification %s conflict', change => {
    const { input, projection } = projectionFixture(); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    const before = projectOccurrenceCarrier(projection); expect(before.residuals).toEqual([]);
    const receipt = projection.sources[0].classifications![0];
    if (change === 'actor') receipt.actor_user_id = uuid(99);
    if (change === 'sequence') receipt.sequence = 2;
    if (change === 'receipt-time') receipt.received_at = '2026-09-22T11:00:00.123457Z';
    if (change === 'payload') (receipt.payload.identities as any[])[0].status = 'repeat';
    const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toEqual(before.transfers); expect(out.coverage).toBe('residuals-present');
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'classification-conflict',
      source: projection.sources[0].selector, eventIds: [receipt.id] }));
  });

  it('also compares the legacy carrier classification against its accepted proof snapshot', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [1, 2, 3].map(ref => accepted(input, ref));
    const before = projectOccurrenceCarrier(projection); const receipt = projection.sources[2].classifications![0];
    receipt.actor_user_id = uuid(99); const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toEqual(before.transfers);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'classification-conflict',
      source: projection.sources[2].selector, eventIds: [receipt.id] }));
  });

  it('compares historical correction receipt content across inventory and accepted proof evidence', () => {
    const { input, projection } = projectionFixture(); const row = projection.sources[0];
    const receipt = correction(row, 3); receipt.payload.matched_identity = input.carrierIdentity;
    receipt.received_at = '2026-09-22T11:30:00.000001Z'; input.split.source.corrections = structuredClone(row.corrections!);
    projection.transfers = [accepted(input)]; const before = projectOccurrenceCarrier(projection);
    expect(before.residuals.some(r => r.reason === 'correction-conflict')).toBe(false);
    receipt.actor_user_id = uuid(99); const out = projectOccurrenceCarrier(projection);
    expect(out.transfers).toEqual(before.transfers);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'correction-conflict',
      source: row.selector, eventIds: [receipt.id] }));
  });

  it('exposes a prefix classification UUID reused by a proof split without erasing prior transfer receipts', () => {
    const { input, projection } = projectionFixture(true); projection.transfers = [accepted(input)];
    const receipt = projection.sources[0].classifications![0]; receipt.id = projection.transfers[0].preparation.split.receipt.id;
    const out = projectOccurrenceCarrier(projection); expect(out.transfers).toHaveLength(1);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'classification-conflict', eventIds: [receipt.id] }));
  });

  it.each(['id', 'sequence'])('exposes an inventory correction colliding with a proof split %s', collision => {
    const { input, projection } = projectionFixture(); projection.transfers = [accepted(input)];
    const split = projection.transfers[0].preparation.split.receipt;
    const receipt = correction(projection.sources[0], 3); receipt.payload.matched_identity = input.carrierIdentity;
    if (collision === 'id') { receipt.id = split.id; projection.sources[0].correctionIds = [receipt.id]; }
    else receipt.sequence = split.sequence;
    const out = projectOccurrenceCarrier(projection); expect(out.transfers).toHaveLength(1);
    expect(out.residuals).toContainEqual(expect.objectContaining({ reason: 'correction-conflict',
      source: projection.sources[0].selector, eventIds: expect.arrayContaining([receipt.id, split.id]) }));
  });

});
