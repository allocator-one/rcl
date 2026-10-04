import { describe,expect,it } from 'vitest';
import type { ClaimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { assertHistoryExtension } from '../../src/evidence/claim-recovery/public-model.js';

function history(receipts: Array<{id:string;sequence:number}>): ClaimHistoryContent {
  return {
    actorUserId: 'actor',
    readWindow: { startedAt: '2026-10-04T00:00:00.000Z',completedAt: '2026-10-04T00:00:01.000Z' },
    sources: [],
    histories: [{ runId: 'run',eventSequence: receipts.length,receipts: receipts as ClaimHistoryContent['histories'][number]['receipts'] }]
  };
}

describe('claim history extension', () => {
  it('compares unchanged receipts through indexes', () => {
    const receipts=Array.from({ length: 200 },(_,sequence) => ({ id: `receipt-${sequence}`,sequence }));
    const before=history(receipts);
    const after=history(structuredClone(receipts));
    const oldReceipts=before.histories[0]!.receipts;
    const currentReceipts=after.histories[0]!.receipts;

    Object.defineProperty(currentReceipts,'find',{ value: () => { throw new Error('linear current receipt search'); } });
    Object.defineProperty(oldReceipts,'some',{ value: () => { throw new Error('linear old receipt search'); } });

    expect(() => assertHistoryExtension(before,after,new Map())).not.toThrow();
  });
});
