import {
  claimConvergeAttempt,
  ConvergeAttemptBudgetExceededError,
} from '../../src/converge/attempt-budget.js';

const [gitCommonDir, target, capValue] = process.argv.slice(2);
if (!gitCommonDir || !target || !capValue) {
  throw new Error('Usage: converge-claim-worker <git-common-dir> <target> <cap>');
}

try {
  const claim = await claimConvergeAttempt({
    gitCommonDir,
    target,
    maxAttempts: Number(capValue),
  });
  process.stdout.write(`${JSON.stringify(claim)}\n`);
} catch (err) {
  if (err instanceof ConvergeAttemptBudgetExceededError) {
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 3;
  }
}
