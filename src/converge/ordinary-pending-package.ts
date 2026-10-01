import { stableStringify } from '../report/run-header.js';
import { sha256 } from '../telemetry/recovery/files.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const MAX_BYTES = 25_000_000;

export interface OrdinaryPendingPackageBody {
  version: 1;
  target: string;
  headSha: string;
  baseSha: string;
  inputSha256: string;
  attempt: number;
  round: number;
  attemptCap: number;
  roundCap: number;
  patch: string;
  patchSha256: string;
  spec: string;
  specSha256: string;
  plan: string;
  planSha256: string;
  capturedInputsSha256: string;
  config: string;
  configSha256: string;
  roster: string;
  rosterSha256: string;
  retainedAsyncSha256: string[];
}

export interface OrdinaryPendingPackage extends OrdinaryPendingPackageBody {
  digest: string;
}

export interface PendingLaunchIdentity {
  target: string;
  headSha: string;
  inputSha256: string;
  attempt: number;
  round: number;
  attemptCap: number;
  roundCap: number;
}

function fail(): never { throw new Error('ordinary_pending_package_mismatch'); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) fail();
}
function validInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_BYTES;
}
function validateBody(value: unknown): OrdinaryPendingPackageBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const body = value as unknown as OrdinaryPendingPackageBody;
  exactKeys(body as unknown as Record<string, unknown>, [
    'version', 'target', 'headSha', 'baseSha', 'inputSha256', 'attempt', 'round',
    'attemptCap', 'roundCap',
    'patch', 'patchSha256', 'spec', 'specSha256', 'plan', 'planSha256',
    'capturedInputsSha256', 'config', 'configSha256', 'roster', 'rosterSha256',
    'retainedAsyncSha256',
  ]);
  if (body.version !== 1 || typeof body.target !== 'string' || !body.target.trim() ||
    body.target.length > 512 || /[\0\r\n]/.test(body.target) || !SHA1.test(body.headSha) ||
    !SHA1.test(body.baseSha) || !SHA256.test(body.inputSha256) ||
    !validInteger(body.attempt) || !validInteger(body.round) ||
    !validInteger(body.attemptCap) || body.attempt > body.attemptCap ||
    !validInteger(body.roundCap) || body.round > body.roundCap ||
    !validText(body.patch) || !validText(body.spec) || !validText(body.plan) ||
    !validText(body.config) || !validText(body.roster) ||
    !SHA256.test(body.patchSha256) || !SHA256.test(body.specSha256) ||
    !SHA256.test(body.planSha256) || !SHA256.test(body.capturedInputsSha256) ||
    !SHA256.test(body.configSha256) || !SHA256.test(body.rosterSha256) ||
    !Array.isArray(body.retainedAsyncSha256) || body.retainedAsyncSha256.length === 0 ||
    body.retainedAsyncSha256.some(item => typeof item !== 'string' || !SHA256.test(item)) ||
    new Set(body.retainedAsyncSha256).size !== body.retainedAsyncSha256.length ||
    sha256(body.patch) !== body.patchSha256 || sha256(body.spec) !== body.specSha256 ||
    sha256(body.plan) !== body.planSha256 || sha256(body.config) !== body.configSha256 ||
    sha256(body.roster) !== body.rosterSha256) fail();
  return Object.freeze({ ...body, retainedAsyncSha256: Object.freeze([...body.retainedAsyncSha256].sort()) }) as OrdinaryPendingPackageBody;
}

/** Build a deterministic operator-reviewable package from already prepared immutable inputs. */
export function createOrdinaryPendingPackage(input: Omit<OrdinaryPendingPackageBody,
  'version' | 'patchSha256' | 'specSha256' | 'planSha256' | 'configSha256' | 'rosterSha256'>): OrdinaryPendingPackage {
  const body = validateBody({
    version: 1,
    ...input,
    retainedAsyncSha256: [...input.retainedAsyncSha256].sort(),
    patchSha256: sha256(input.patch),
    specSha256: sha256(input.spec),
    planSha256: sha256(input.plan),
    configSha256: sha256(input.config),
    rosterSha256: sha256(input.roster),
  });
  return Object.freeze({ ...body, digest: sha256(stableStringify(body)) });
}

export function encodeOrdinaryPendingPackage(value: OrdinaryPendingPackage): string {
  const validated = validateOrdinaryPendingPackage(value, {
    target: value.target, headSha: value.headSha, inputSha256: value.inputSha256,
    attempt: value.attempt, round: value.round, attemptCap: value.attemptCap,
    roundCap: value.roundCap,
  });
  return stableStringify(validated);
}

export function decodeOrdinaryPendingPackage(bytes: string): OrdinaryPendingPackage {
  if (!validText(bytes)) fail();
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { fail(); }
  const candidate = value as OrdinaryPendingPackage;
  const decoded = validateOrdinaryPendingPackage(candidate, {
    target: candidate?.target, headSha: candidate?.headSha, inputSha256: candidate?.inputSha256,
    attempt: candidate?.attempt, round: candidate?.round, attemptCap: candidate?.attemptCap,
    roundCap: candidate?.roundCap,
  });
  if (bytes !== stableStringify(decoded)) fail();
  return decoded;
}

/** Fail closed unless the reviewed package binds the exact spent launch and reconstructed bytes. */
export function validateOrdinaryPendingPackage(value: OrdinaryPendingPackage,
  expected: PendingLaunchIdentity, reconstructed?: OrdinaryPendingPackage): OrdinaryPendingPackage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const { digest, ...candidate } = value;
  exactKeys(value as unknown as Record<string, unknown>, [
    'version', 'target', 'headSha', 'baseSha', 'inputSha256', 'attempt', 'round',
    'attemptCap', 'roundCap',
    'patch', 'patchSha256', 'spec', 'specSha256', 'plan', 'planSha256',
    'capturedInputsSha256', 'config', 'configSha256', 'roster', 'rosterSha256',
    'retainedAsyncSha256', 'digest',
  ]);
  const body = validateBody(candidate);
  if (typeof digest !== 'string' || !SHA256.test(digest) || digest !== sha256(stableStringify(body)) ||
    body.target !== expected.target || body.headSha !== expected.headSha ||
    body.inputSha256 !== expected.inputSha256 || body.attempt !== expected.attempt ||
    body.round !== expected.round || body.attemptCap !== expected.attemptCap ||
    body.roundCap !== expected.roundCap || (reconstructed && digest !== reconstructed.digest)) fail();
  return Object.freeze({ ...body, digest });
}
