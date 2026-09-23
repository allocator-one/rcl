import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflow = await readFile(
  new URL('../.github/workflows/review_gate.yml', import.meta.url),
  'utf8'
);

describe('Review Council gate workflow', () => {
  it('advertises and validates registered lifecycle attempts before review', () => {
    expect(workflow).toContain('# harness-review-lifecycle: 1');
    expect(workflow).toContain(
      "run-name: Review Council gate · ${{ inputs.attempt_id || 'unregistered' }}"
    );
    expect(workflow).toContain('attempt_id:');
    expect(workflow).toContain('ATTEMPT_ID: ${{ inputs.attempt_id }}');

    const validation = workflow.indexOf('attempt_id must be a lowercase UUID when provided');
    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(workflow.indexOf('mkdir -p "$RCL_GATE_EXPORT"'));
    expect(validation).toBeLessThan(workflow.indexOf('rcl review "$GITHUB_REPOSITORY'));
  });

  it('keeps runner paths at step scope and binds the exact requested head', () => {
    const jobPrefix = workflow.slice(workflow.indexOf('jobs:'), workflow.indexOf('steps:'));
    expect(jobPrefix).not.toContain('${{ runner.temp }}');

    const reviewStep = workflow.slice(
      workflow.indexOf('- name: Attested review'),
      workflow.indexOf('- name: Retain original review evidence')
    );
    expect(reviewStep).toContain('RCL_DATA_DIR: ${{ runner.temp }}/rcl-gate-data');
    expect(reviewStep).toContain('RCL_GATE_EXPORT: ${{ runner.temp }}/rcl-gate-evidence');
    expect(reviewStep).toContain('--expect-head-sha "$HEAD_SHA"');
    expect(workflow).toContain('timeout-minutes: 360');
  });

  it('retains original reports and quarantine material even when review fails', () => {
    const retention = workflow.slice(workflow.indexOf('- name: Retain original review evidence'));
    expect(retention).toContain('if: always()');
    expect(retention).toContain('actions/upload-artifact@');
    expect(retention).toContain('${{ runner.temp }}/rcl-gate-evidence/');
    expect(retention).toContain('${{ runner.temp }}/rcl-gate-data/quarantine/');
    expect(workflow).toContain('--json-file "$RCL_GATE_EXPORT/report.json"');
    expect(workflow).toContain('--markdown "$RCL_GATE_EXPORT/report.md"');
    expect(workflow).toContain('Path(os.environ["RCL_GATE_EXPORT"], "workflow.json")');
  });
});
