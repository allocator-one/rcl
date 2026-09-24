import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [gitCommonDir, target] = process.argv.slice(2);
if (!gitCommonDir || !target) throw new Error('synthetic_arguments_required');
if (!process.send) throw new Error('ipc_channel_required');

const lockPath = join(gitCommonDir, 'rcl-native-target-locks', `${createHash('sha256').update(target).digest('hex')}.lock`);
const link = fs.link;
fs.link = async (existingPath, newPath) => {
  try {
    return await link(existingPath, newPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && String(newPath) === lockPath) {
      process.send({ type: 'legacy_lock_retry', pid: process.pid });
    }
    throw error;
  }
};
syncBuiltinESMExports();

const { processRoundReport } = await import('../../src/converge/run-state.js');
await processRoundReport({ gitCommonDir, target, round: 2, findings: [] });
process.send({ type: 'ordinary_writer_committed', pid: process.pid });
