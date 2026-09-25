import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/config/defaults.js';
import { MAX_TIMER_DELAY_MS } from '../../src/config/schema.js';
import { resolveGatingConfig } from '../../src/consensus/gating.js';
import type { Role } from '../../src/roles/types.js';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';
import {
  captureAggregationInputs, decodeAggregationInputs, isCapturedAggregationInputs,
  MAX_AGGREGATION_INPUT_BYTES, type CaptureAggregationInput,
} from '../../src/report/aggregation-inputs.js';

const diffSha256 = sha256Hex('original diff');
function role(name: string): Role {
  return { name, systemPrompt: `Exact ${name} prompt\n`, description: `${name} description`, focus: ['correctness', 'tests'], isSpecialized: name !== 'general', severityBias: { important: 1.25, minor: -1 } };
}
function input(): CaptureAggregationInput {
  return { algorithm: { name: 'consensus', version: 1 }, diffSha256, roleMap: new Map([['security', role('security')], ['general', role('general')]]),
    thresholds: { ...DEFAULT_THRESHOLDS }, gating: resolveGatingConfig({ verificationTimeout: 17, verificationPassTimeout: 31 }, ['openai/gpt-6-sol']),
    modelWeights: new Map([['openai/gpt-6-sol', 0.5], ['google/gemini-3.8-flash', 1.5]]), belowThresholdAppendix: true };
}

describe('captured aggregation inputs', () => {
  it('captures full actual roles and resolved settings without keeping mutable Maps', () => {
    const original = input(), captured = captureAggregationInputs(original);
    expect(captured.version).toBe(1); expect(captured.algorithm).toEqual({ name: 'consensus', version: 1 });
    expect(captured.roles).toEqual([{ name: 'general', role: role('general') }, { name: 'security', role: role('security') }]);
    expect(captured.thresholds).toEqual(DEFAULT_THRESHOLDS); expect(captured.gating).toEqual(original.gating);
    expect(captured.modelWeights).toEqual([{ model: 'google/gemini-3.8-flash', weight: 1.5 }, { model: 'openai/gpt-6-sol', weight: 0.5 }]);
    expect(captured.bytes).toBe(stableStringify(JSON.parse(captured.bytes)));
    expect(captured.digest).toBe(sha256Hex(captured.bytes));
    expect(decodeAggregationInputs(captured.bytes, diffSha256)).toEqual(captured);
    expect(isCapturedAggregationInputs(captured)).toBe(true); expect(isCapturedAggregationInputs({ ...captured })).toBe(false);
    expect(Object.isFrozen(captured.roles)).toBe(true); expect(Object.isFrozen(captured.roles[0]?.role.focus)).toBe(true);
    expect(Object.isFrozen(captured.roles[0]?.role.severityBias)).toBe(true); expect(Object.isFrozen(captured.gating)).toBe(true);
    expect(Object.isFrozen(captured.modelWeights?.[0])).toBe(true);
  });

  it('preserves old inputs after live role definitions, thresholds, gating and weights change', () => {
    const original = input(), captured = captureAggregationInputs(original), bytes = captured.bytes;
    original.roleMap.get('general')!.focus.push('security'); original.roleMap.get('general')!.systemPrompt = 'later prompt';
    (original.roleMap as Map<string, Role>).set('async-role', role('async-role'));
    original.thresholds.minConfidence = 0.99; original.gating.verificationTimeoutMs = 99;
    (original.modelWeights as Map<string, number>).clear(); original.belowThresholdAppendix = false;
    expect(decodeAggregationInputs(bytes, diffSha256)).toEqual(captured);
    expect(captured.roles).toHaveLength(2); expect(captured.roles[0]?.role.focus).toEqual(['correctness', 'tests']);
    expect(captured.thresholds.minConfidence).toBe(0.2); expect(captured.gating.verificationTimeoutMs).toBe(17);
    expect(captured.modelWeights).toHaveLength(2); expect(captured.belowThresholdAppendix).toBe(true);
  });

  it('canonicalizes map insertion order while retaining absent versus active empty weights', () => {
    const first = input(), second = input();
    second.roleMap = new Map([...second.roleMap].reverse()); second.modelWeights = new Map([...second.modelWeights!].reverse());
    expect(captureAggregationInputs(first).bytes).toBe(captureAggregationInputs(second).bytes);
    delete first.modelWeights; second.modelWeights = new Map();
    const absent = captureAggregationInputs(first), empty = captureAggregationInputs(second);
    expect(absent.modelWeights).toBeUndefined(); expect(Object.hasOwn(JSON.parse(absent.bytes), 'modelWeights')).toBe(false);
    expect(empty.modelWeights).toEqual([]); expect(absent.digest).not.toBe(empty.digest);
  });

  it('retains an unavailable verifier without reselecting current defaults', () => {
    const original = input(); original.gating = resolveGatingConfig(undefined, ['openrouter/moonshotai/kimi-k3']);
    const captured = captureAggregationInputs(original);
    expect(captured.gating.verificationModel).toBeUndefined();
    expect(JSON.parse(captured.bytes).gating.verificationModel).toBeNull();
    expect(decodeAggregationInputs(captured.bytes, diffSha256).gating).toEqual(original.gating);
  });

  it('never silently drops a role severity-bias key while capturing exact definitions', () => {
    const original = input();
    original.roleMap.get('general')!.severityBias = JSON.parse('{"__proto__":1}');
    expect(() => captureAggregationInputs(original)).toThrow('aggregation_invalid_input');
  });

  it.each([0.49, 1.51, NaN, Infinity, -Infinity])('refuses unsupported model weight %s without clamping it', weight => {
    const original = input(); original.modelWeights = new Map([['openai/gpt-6-sol', weight]]);
    expect(() => captureAggregationInputs(original)).toThrow('aggregation_invalid_input');
  });

  it.each(['missing threshold', 'invalid threshold', 'missing deadline', 'unsafe deadline', 'fractional model count', 'wrong role key', 'incomplete role', 'extra role key', 'nonfinite bias', 'fake map', 'credential', 'unknown undefined key', 'unsupported algorithm'])(
    'rejects %s at capture instead of defaulting, stripping or persisting it', mutation => {
      const original: any = input();
      if (mutation === 'missing threshold') delete original.thresholds.minConfidence;
      else if (mutation === 'invalid threshold') original.thresholds.dedupeLineWindow = 0;
      else if (mutation === 'missing deadline') delete original.gating.verificationPassTimeoutMs;
      else if (mutation === 'unsafe deadline') original.gating.verificationTimeoutMs = MAX_TIMER_DELAY_MS + 1;
      else if (mutation === 'fractional model count') original.gating.minModels = 2.5;
      else if (mutation === 'wrong role key') original.roleMap.set('alias', role('general'));
      else if (mutation === 'incomplete role') delete original.roleMap.get('general').systemPrompt;
      else if (mutation === 'extra role key') original.roleMap.get('general').githubToken = 'synthetic';
      else if (mutation === 'nonfinite bias') original.roleMap.get('general').severityBias.important = Infinity;
      else if (mutation === 'fake map') original.roleMap = { entries: () => [] };
      else if (mutation === 'credential') original.githubToken = 'synthetic';
      else if (mutation === 'unknown undefined key') original.ignored = undefined;
      else original.algorithm.version = 2;
      expect(() => captureAggregationInputs(original)).toThrow('aggregation_invalid_input');
    },
  );

  it.each(['unknown document key', 'unknown nested key', 'missing threshold', 'missing verifier', 'duplicate role', 'duplicate model', 'wrong role name', 'role order', 'weight order', 'unknown algorithm name', 'unknown algorithm version', 'unknown document version', 'bad verifier', 'bad weight'])(
    'rejects canonical bytes containing %s', mutation => {
      const wire = JSON.parse(captureAggregationInputs(input()).bytes);
      if (mutation === 'unknown document key') wire.githubToken = 'synthetic';
      else if (mutation === 'unknown nested key') wire.gating.secret = 'synthetic';
      else if (mutation === 'missing threshold') delete wire.thresholds.minConsensusScore;
      else if (mutation === 'missing verifier') delete wire.gating.verificationModel;
      else if (mutation === 'duplicate role') wire.roles.push(wire.roles[0]);
      else if (mutation === 'duplicate model') wire.modelWeights.push(wire.modelWeights[0]);
      else if (mutation === 'wrong role name') wire.roles[0].role.name = 'different';
      else if (mutation === 'role order') wire.roles.reverse();
      else if (mutation === 'weight order') wire.modelWeights.reverse();
      else if (mutation === 'unknown algorithm name') wire.algorithm.name = 'future';
      else if (mutation === 'unknown algorithm version') wire.algorithm.version = 2;
      else if (mutation === 'unknown document version') wire.version = 2;
      else if (mutation === 'bad verifier') wire.gating.verificationModel = 'openrouter/model';
      else wire.modelWeights[0].weight = 0;
      expect(() => decodeAggregationInputs(stableStringify(wire), diffSha256)).toThrow();
    },
  );

  it('binds the expected diff and refuses partial, noncanonical and oversized documents', () => {
    const captured = captureAggregationInputs(input());
    expect(() => decodeAggregationInputs(captured.bytes, sha256Hex('different'))).toThrow('aggregation_diff_mismatch');
    expect(() => decodeAggregationInputs(captured.bytes, 'not a digest')).toThrow('aggregation_invalid_expected_diff');
    expect(() => decodeAggregationInputs(captured.bytes + '\n', diffSha256)).toThrow('aggregation_noncanonical_json');
    expect(() => decodeAggregationInputs(captured.bytes.slice(0, -1), diffSha256)).toThrow('aggregation_invalid_json');
    expect(() => decodeAggregationInputs('x'.repeat(MAX_AGGREGATION_INPUT_BYTES + 1), diffSha256)).toThrow('aggregation_invalid_bytes');
    const oversized = input(); oversized.roleMap.get('general')!.systemPrompt = 'é'.repeat(MAX_AGGREGATION_INPUT_BYTES / 2);
    expect(() => captureAggregationInputs(oversized)).toThrow('aggregation_invalid_bytes');
  });
});
