import { join } from 'node:path';
import type { ModelReview } from '../consensus/types.js';
import type { AsyncResultReference } from '../dispatch/async-lane.js';
import { prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { syncDirectory } from '../evidence/original-run/journal.js';
import { writeRecoveryArtifact } from '../telemetry/recovery/files.js';
import { uuidv7 } from '../report/uuid.js';

/** Retain observed results privately on refusal; this is neither a report nor admission evidence. */
export async function retainAssemblyRefusal(dataDir: string, input: {
  run: unknown; chunkReviews: readonly ModelReview[]; asyncArtifacts: readonly AsyncResultReference[];
}): Promise<string> {
  const directory = await prepareLockRoot(join(dataDir, 'assembly-refused'));
  const path = join(directory, `${uuidv7()}.json`);
  await writeRecoveryArtifact(path, { version: 1, status: 'assembly_refused', reason: 'ambiguous_reviewer_identity', ...input });
  await syncDirectory(directory);
  return path;
}
