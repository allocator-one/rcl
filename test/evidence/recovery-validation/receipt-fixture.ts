import { readFileSync } from 'node:fs';

type ReceiptFixture = {
  scope: { base_url: string; org_id: string; run_id: string; repo: string; pr_number: number };
  eventJson: string;
  receipt: Record<string, any>;
  actorUserId: string;
};

type StoredReceiptFixture = {
  version: 1;
  oracle: string;
  oracle_source: string;
  oracle_source_sha256: string;
  scope: ReceiptFixture['scope'];
  event_json: string;
  receipt: Record<string, any>;
  actor_user_id: string;
};

const ORACLE = '58afdfe4bf1eeba3f5c34d87a4a30948802df629';
const ORACLE_SOURCE = 'test/evidence/recovery-validation/fixtures.ts';
const ORACLE_SOURCE_SHA256 = '64e98226e6eeb5229d0a99ee651d6865933daa94555b50ed1dac4e7c4262deb1';

export function receiptFixture(): ReceiptFixture {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/recovery-receipt.json', import.meta.url), 'utf8')) as StoredReceiptFixture;
  if (fixture.version !== 1 || fixture.oracle !== ORACLE || fixture.oracle_source !== ORACLE_SOURCE ||
      fixture.oracle_source_sha256 !== ORACLE_SOURCE_SHA256) throw new Error('invalid_receipt_fixture_source');
  return { scope: structuredClone(fixture.scope), eventJson: fixture.event_json,
    receipt: structuredClone(fixture.receipt), actorUserId: fixture.actor_user_id };
}
