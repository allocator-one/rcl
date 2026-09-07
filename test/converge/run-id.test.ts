import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConvergeRunState, processRoundReport, roundRunId } from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';

describe('converge run state remembers each round\'s run id', () => {
  let gitCommonDir: string;

  beforeEach(async () => {
    gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-run-id-'));
  });

  afterEach(async () => {
    await rm(gitCommonDir, { recursive: true, force: true });
  });

  it('persists the report run id per round and answers it back', async () => {
    await processRoundReport({ gitCommonDir, target: 't', round: 1, findings: [sampleFinding()], runId: 'run-round-1' });
    await processRoundReport({ gitCommonDir, target: 't', round: 2, findings: [sampleFinding()] });

    const state = await loadConvergeRunState(gitCommonDir, 't');
    expect(roundRunId(state, 1)).toBe('run-round-1');
    expect(roundRunId(state, 2)).toBeUndefined();
    expect(roundRunId(undefined, 1)).toBeUndefined();

    // A re-run of a round replaces its record, run id included.
    await processRoundReport({ gitCommonDir, target: 't', round: 2, findings: [sampleFinding()], runId: 'run-round-2b' });
    expect(roundRunId(await loadConvergeRunState(gitCommonDir, 't'), 2)).toBe('run-round-2b');
  });
});
