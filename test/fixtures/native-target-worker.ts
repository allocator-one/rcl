import { processRoundReport } from '../../src/converge/run-state.js';

const [gitCommonDir, target] = process.argv.slice(2);
if (!gitCommonDir || !target) throw new Error('synthetic_arguments_required');
await processRoundReport({ gitCommonDir, target, round: 2, findings: [] });
