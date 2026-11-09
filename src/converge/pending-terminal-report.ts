import { exportCheckpointProof, type CheckpointJournal, type TerminalCheckpointReport } from '../dispatch/checkpoint.js';
import { encodeOriginalLaunch, type OriginalLaunch } from '../dispatch/original-launch.js';
import { inspectReviewerArtifact, type ReviewerArtifact } from '../report/reviewer-artifact.js';

/**
 * Read the terminal pair against its original launch and actual journal.
 * Provider-free and read-only, so preview and apply reject corrupt retained
 * evidence before publishing a new resume owner or delivering anything.
 */
export async function readPendingTerminalReport(journal: CheckpointJournal, launch: OriginalLaunch):
  Promise<{ terminal: TerminalCheckpointReport; artifact: ReviewerArtifact } | undefined> {
  const terminal = await journal.readTerminalReport();
  if (!terminal) return undefined;
  const inspected = inspectReviewerArtifact(terminal.reviewerArtifactBytes, {
    expectedReportBytes: terminal.reportBytes, expectedRunId: launch.runId,
    expectedTarget: launch.target, expectedPlan: journal.getPlan(),
  });
  if (!inspected.launch || encodeOriginalLaunch(inspected.launch) !== encodeOriginalLaunch(launch) ||
      inspected.proof.digest !== (await exportCheckpointProof(journal)).digest) {
    throw new Error('pending_legacy_resume_terminal_mismatch');
  }
  return { terminal, artifact: inspected.artifact };
}
