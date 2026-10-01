import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createOrdinaryPendingPackage,
  decodeOrdinaryPendingPackage,
  encodeOrdinaryPendingPackage,
  validateOrdinaryPendingPackage,
} from '../../src/converge/ordinary-pending-package.js';

const identity = {
  target: 'allocator-one-9691',
  headSha: '6'.repeat(40),
  inputSha256: 'b'.repeat(64),
  attempt: 2,
  round: 2,
  attemptCap: 20,
  roundCap: 15,
};

function fixture() {
  return createOrdinaryPendingPackage({
    ...identity,
    baseSha: '4'.repeat(40),
    patch: 'immutable patch',
    spec: 'immutable spec',
    plan: '{"version":2}',
    capturedInputsSha256: 'c'.repeat(64),
    config: '{"models":["openai/fixture"]}',
    roster: '[{"lane":"blocking"}]',
    retainedAsyncSha256: ['d'.repeat(64)],
  });
}

describe('ordinary pending recovery package', () => {
  it('binds the immutable PR9691 A2 identity and original caps', () => {
    const bytes = readFileSync(
      new URL('../fixtures/rcl-154-pr9691-a2.json', import.meta.url), 'utf8');
    const packet = decodeOrdinaryPendingPackage(bytes);
    expect(packet).toMatchObject({
      target: 'allocator-one-9691',
      headSha: '60df6d782f9ef9a255028391595dbbbe92442a57',
      baseSha: '403d4390ea4a0e33b9caa8319600f12633398573',
      inputSha256: 'b1cedd3d7d55720b8efea4474f9cf82e5c8ee7accf6a1f9e0121e7d5ad7ae2db',
      attempt: 2, round: 2, attemptCap: 20, roundCap: 15,
      retainedAsyncSha256: ['92705bdeb895e3bcab6863b5f717262f45fa4a4b6e98853b214677b64771e834'],
    });
    expect(packet.patchSha256).toBe('da34014a5cd6e7fe7bd8abccb834259f9906b3ad150aeae0bfb3d430464ac92e');
    expect(packet.specSha256).toBe('de6e3db4fc6c28f111ca1cd739d94d50c90238aa6e963dfadc0277cea2427e7f');
    expect(validateOrdinaryPendingPackage(packet, {
      target: packet.target, headSha: packet.headSha, inputSha256: packet.inputSha256,
      attempt: packet.attempt, round: packet.round, attemptCap: packet.attemptCap,
      roundCap: packet.roundCap,
    }, packet)).toEqual(packet);
  });

  it('round-trips one canonical reviewed package and exact spent launch identity', () => {
    const packet = fixture();
    expect(decodeOrdinaryPendingPackage(encodeOrdinaryPendingPackage(packet))).toEqual(packet);
    expect(validateOrdinaryPendingPackage(packet, identity, fixture())).toEqual(packet);
  });

  it.each([
    ['patch drift', (packet: any) => { packet.patch = 'drift'; }],
    ['config drift', (packet: any) => { packet.config = '{}'; }],
    ['roster drift', (packet: any) => { packet.roster = '[]'; }],
    ['head drift', (packet: any) => { packet.headSha = 'e'.repeat(40); }],
    ['attempt drift', (packet: any) => { packet.attempt = 3; }],
    ['async drift', (packet: any) => { packet.retainedAsyncSha256 = ['f'.repeat(64)]; }],
  ])('refuses %s', (_label, mutate) => {
    const packet = structuredClone(fixture());
    mutate(packet);
    expect(() => validateOrdinaryPendingPackage(packet, identity)).toThrow('ordinary_pending_package_mismatch');
  });

  it('refuses a reviewed package reconstructed from different immutable bytes', () => {
    const reviewed = fixture();
    const reconstructed = createOrdinaryPendingPackage({
      ...identity,
      baseSha: '4'.repeat(40), patch: 'different patch', spec: 'immutable spec',
      plan: '{"version":2}', capturedInputsSha256: 'c'.repeat(64),
      config: '{"models":["openai/fixture"]}', roster: '[{"lane":"blocking"}]',
      retainedAsyncSha256: ['d'.repeat(64)],
    });
    expect(() => validateOrdinaryPendingPackage(reviewed, identity, reconstructed))
      .toThrow('ordinary_pending_package_mismatch');
  });
});
