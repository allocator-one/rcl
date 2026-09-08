import { credentialHost, resolveHarnessCredential, type CredentialResolution, type HarnessCredential } from './credentials.js';
import { HarnessSink } from './sink.js';

/**
 * A sink for reads (evidence status, model stats): the same credential rules
 * as delivery — the stored login or the `HARNESS_API_TOKEN` + `HARNESS_API_URL`
 * pair, the token sent to its own host only — but independent of the
 * telemetry level, so switching delivery off does not blind the reads.
 */

export interface ReadSinkOptions {
  rclVersion: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  /** A credential already in hand — the run-bound one of `--attest` — used instead of resolving one. */
  credential?: HarnessCredential;
}

export type ReadSink = { sink: HarnessSink; host: string; note?: undefined } | { sink: null; host?: undefined; note: string };

export async function openReadSink(options: ReadSinkOptions): Promise<ReadSink> {
  const resolved: CredentialResolution = options.credential
    ? { repoManaged: true, credential: options.credential }
    : await resolveHarnessCredential({
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        ...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}),
        requireRepo: false,
      });
  if (!resolved.credential) return { sink: null, note: resolved.note ?? 'no Harness credential' };
  return {
    sink: new HarnessSink({
      credential: resolved.credential,
      rclVersion: options.rclVersion,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
    host: credentialHost(resolved.credential),
  };
}
