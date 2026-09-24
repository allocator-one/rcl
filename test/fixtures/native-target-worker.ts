import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processRoundReport } from '../../src/converge/run-state.js';

const [gitCommonDir, target] = process.argv.slice(2);
if (!gitCommonDir || !target) throw new Error('synthetic_arguments_required');
await writeFile(join(gitCommonDir, 'child-ready'), 'ready\n');
await processRoundReport({ gitCommonDir, target, round: 2, findings: [] });
