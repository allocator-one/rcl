import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
const [root, identity, stage] = process.argv.slice(2);
const pause = async (at: string) => {
  if (at === stage) { process.send!({ stage }); await new Promise<void>(() => { setInterval(() => undefined, 1000); }); }
};
await withRecoveryLock(root!, identity!, () => pause('work'), { onEvent: event => pause(event.stage) });
