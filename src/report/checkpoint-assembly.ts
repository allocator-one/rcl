import { assembleCompletedReview, type AssemblyDependencies } from './assembly.js';
import { prepareCheckpointAssembly, type CheckpointAssemblyInput, type CheckpointAssemblyResult } from './checkpoint-consensus.js';
import { deriveCheckpointGating, type SealedVerificationProof } from './checkpoint-gating.js';
export * from './checkpoint-consensus.js';

export interface CheckpointAssemblyDependencies extends AssemblyDependencies {
  /** Sealed current-run verifier evidence, independently checked against the regenerated plan. */
  verificationProof?: SealedVerificationProof;
}

/** Assemble retained output by replaying sealed evidence; this path never launches a verifier. */
export async function assembleCheckpointReview(
  input: CheckpointAssemblyInput,
  dependencies: CheckpointAssemblyDependencies = {},
): Promise<CheckpointAssemblyResult> {
  const gated = deriveCheckpointGating(input, dependencies.verificationProof);
  const { completedInput } = prepareCheckpointAssembly(input);
  const report = await assembleCompletedReview(completedInput, dependencies, {
    consensus: gated.derived.consensus, findings: gated.findings, appendix: gated.appendix,
    ...(gated.verification === undefined ? {} : { verification: gated.verification }),
  });
  return { report, contributions: gated.derived.contributions,
    observations: gated.derived.observations, projection: gated.derived.projection };
}
