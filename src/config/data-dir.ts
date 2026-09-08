import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where rcl keeps its per-machine state (model stats, the telemetry outbox,
 * the consent notice): `RCL_DATA_DIR`, or `~/.rcl`. Shared here so no
 * feature module depends on another for the location.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['RCL_DATA_DIR']?.trim();
  return override && override.length > 0 ? override : join(homedir(), '.rcl');
}
