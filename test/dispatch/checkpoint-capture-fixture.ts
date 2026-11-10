import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { freezeCheckpointPlan, type CheckpointPlanInput } from '../../src/dispatch/checkpoint.js';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';

/** Bind real bytes, preserving existing seats and adding an unattempted seat when required. */
export function minimalCheckpointCapture(input: CheckpointPlanInput) {
  const patchBytes = 'patch', specBytes = 'spec', contextBytes = '[]';
  const configBytes = stableStringify({ quorumFraction: 2 / 3 });
  const toolsBytes = stableStringify({ parser: input.parser, aggregation: { name: 'consensus', version: 2 } });
  const chunkBytes = input.chunks.map(chunk => `chunk-${chunk.index}`);
  // Captures require a council of at least two seats. The extra seat has no
  // intent or result, so verifier fixtures retain their original call history.
  const roster = input.roster.length === 1
    ? [...input.roster, { ...input.roster[0]!, seat: `${input.roster[0]!.seat}-unattempted` }]
    : input.roster;
  const plan = freezeCheckpointPlan({ ...input, roster,
    patchSha256: sha256Hex(patchBytes), specSha256: sha256Hex(specBytes), contextSha256: sha256Hex(contextBytes),
    configSha256: sha256Hex(configBytes), toolsSha256: sha256Hex(toolsBytes),
    chunks: input.chunks.map((chunk, index) => ({ ...chunk, digest: sha256Hex(chunkBytes[index]!) })),
    prompts: roster.flatMap(({ seat }) => input.chunks.map(({ index }) => ({ seat, chunk: index,
      systemSha256: sha256Hex(`${seat}-system`), userSha256: sha256Hex(`${seat}-${index}`) }))),
  });
  return captureReviewerInputs({ plan, policy: { version: 1, fraction: 2 / 3 },
    patchBytes, configBytes, specBytes, contextBytes, toolsBytes, chunkBytes,
    assignments: plan.cells.map(cell => ({ model: cell.model, provider: cell.route,
      role: { name: cell.role, systemPrompt: 'role', focus: [], description: 'Test', isSpecialized: false } })),
    prompts: plan.cells.map(cell => ({ systemPrompt: `${cell.seat}-system`, userPrompt: `${cell.seat}-${cell.chunk}` })),
  });
}
