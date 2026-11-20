/**
 * Client for the Harness code index API
 * (`/api/v1/code/views/:view_id/{symbols,symbols/:id,affected,context,outline}`,
 * contract 1.3 with the 1.4 outline read).
 *
 * Rules, shared with `config/harness.ts`:
 * - The stored login (or the run-bound credential) is an indivisible
 *   {url, token} pair: the token goes only to the host that minted it, never
 *   to a URL the repository names.
 * - Every failure is a `CodeIndexError` carrying a short `reason`, so the
 *   caller can degrade to a review without the index and say why. The
 *   request runs under a bounded timeout with one retry.
 * - A capped answer is never complete: `complete` is true only when the
 *   server said `meta.truncation.truncated === false`.
 */

import { readLoginCredential } from '../config/harness.js';

const REQUEST_TIMEOUT_MS = 8_000;
const REQUEST_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

export interface CodeIndexCredential {
  url: string;
  token: string;
}

/** What `meta.view.active` says the view currently holds. */
export interface ViewActive {
  version: number;
  base_commit: string;
  overlay_digest: string;
  indexed_at?: string | null;
}

/** `meta.view`: the view's freshness, carried by every answer. */
export interface ViewMeta {
  view_id: string;
  view_key?: string;
  kind?: string;
  repository_id?: string;
  active: ViewActive | null;
  pending?: { version: number; state: string; error?: string | null; progress?: { done: number; total: number } | null } | null;
  last_sync_at?: string | null;
}

export interface Truncation {
  truncated: boolean;
  [detail: string]: unknown;
}

export interface CodeIndexResponse<T> {
  data: T;
  view: ViewMeta;
  truncation: Truncation;
  /** True only when the server reported the answer was not cut. */
  complete: boolean;
  /** Reference kinds the language extractors do not record, when any. */
  notTracked: string[];
  contract: string;
}

/** Why the index could not answer; the report header records it verbatim. */
export type CodeIndexFailureReason =
  | 'no_login'
  | 'code_index_disabled'
  | 'forbidden'
  | 'unauthorized'
  | 'view_not_found'
  | 'not_indexed'
  | 'timeout'
  | 'network_error'
  | 'unrecognized_response'
  | `http_${number}`;

export class CodeIndexError extends Error {
  constructor(readonly reason: CodeIndexFailureReason, message?: string) {
    super(message ?? reason);
    this.name = 'CodeIndexError';
  }
}

export interface CodeIndexClientOptions {
  credential: CodeIndexCredential;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface OutlineSymbol {
  symbol_id: string;
  name: string;
  qualified_name: string;
  kind: string;
  arity?: number | null;
  exported?: boolean;
  container?: string | null;
  start_line: number;
  end_line: number;
  start_byte?: number;
  end_byte?: number;
}

export interface OutlineFile {
  path: string;
  sha256?: string;
  language?: string;
  origin?: 'base' | 'overlay';
  symbols: OutlineSymbol[];
  not_tracked?: string[] | boolean;
}

export interface OutlineData {
  files: OutlineFile[];
  missing: string[];
}

/** An outline request names at most this many paths (IO-23530). */
export const MAX_OUTLINE_PATHS = 50;

type Query = Record<string, string | number | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function reasonFor(status: number, code: string | undefined): CodeIndexFailureReason {
  if (status === 403 && code === 'code_index_disabled') return 'code_index_disabled';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'view_not_found';
  if (status === 400) return 'not_indexed';
  return `http_${status}`;
}

export class CodeIndexClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: CodeIndexClientOptions) {
    this.base = options.credential.url.replace(/\/+$/, '');
    this.token = options.credential.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Symbol search. An empty `q` returns no symbols, only the view's freshness. */
  search(viewId: string, params: { q?: string; kind?: string; pathPrefix?: string; limit?: number } = {}) {
    return this.request<unknown[]>('GET', viewId, 'symbols', {
      q: params.q, kind: params.kind, path_prefix: params.pathPrefix, limit: params.limit,
    });
  }

  /** A symbol's callers and callees. */
  explain(viewId: string, symbolId: string, params: { budgetTokens?: number } = {}) {
    return this.request<Record<string, unknown>>('GET', viewId, `symbols/${encodeURIComponent(symbolId)}`, {
      budget_tokens: params.budgetTokens,
    });
  }

  /** Transitive dependents of symbols or whole paths. */
  affected(viewId: string, body: { symbolIds?: string[]; paths?: string[]; depth?: number; includeAmbiguous?: boolean }) {
    return this.request<Record<string, unknown>>('POST', viewId, 'affected', {}, {
      symbol_ids: body.symbolIds ?? [], paths: body.paths ?? [],
      ...(body.depth !== undefined ? { depth: body.depth } : {}),
      ...(body.includeAmbiguous !== undefined ? { include_ambiguous: body.includeAmbiguous } : {}),
    });
  }

  /** Cited source for a symbol, within a token budget. */
  context(viewId: string, params: { symbolId?: string; q?: string; budgetTokens?: number }) {
    return this.request<Record<string, unknown>>('GET', viewId, 'context', {
      symbol_id: params.symbolId, q: params.q, budget_tokens: params.budgetTokens,
    });
  }

  /** The symbols each path declares, with spans (contract 1.4); at most 50 paths per call. */
  outline(viewId: string, paths: string[]) {
    if (paths.length > MAX_OUTLINE_PATHS) throw new RangeError(`an outline names at most ${MAX_OUTLINE_PATHS} paths`);
    const query = new URLSearchParams();
    for (const path of paths) query.append('path', path);
    return this.request<OutlineData>('GET', viewId, 'outline', {}, undefined, query);
  }

  private async request<T>(
    method: 'GET' | 'POST', viewId: string, route: string, query: Query, body?: unknown, extra?: URLSearchParams
  ): Promise<CodeIndexResponse<T>> {
    const params = extra ?? new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const qs = params.toString();
    const url = `${this.base}/api/v1/code/views/${encodeURIComponent(viewId)}/${route}${qs === '' ? '' : `?${qs}`}`;
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.once<T>(method, url, body);
      if (!('retry' in outcome)) return outcome;
      if (attempt === REQUEST_ATTEMPTS) throw outcome.error;
      await this.sleep(RETRY_DELAY_MS);
    }
  }

  private async once<T>(method: string, url: string, body: unknown): Promise<CodeIndexResponse<T> | { retry: true; error: CodeIndexError }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      return { retry: true, error: new CodeIndexError(timedOut ? 'timeout' : 'network_error') };
    }
    if (!response.ok) {
      let code: string | undefined;
      try {
        const parsed: unknown = await response.json();
        const error = isRecord(parsed) ? parsed['error'] : undefined;
        if (isRecord(error) && typeof error['code'] === 'string') code = error['code'];
        else if (isRecord(parsed) && typeof parsed['code'] === 'string') code = parsed['code'];
      } catch { /* the status alone decides */ }
      const failure = new CodeIndexError(reasonFor(response.status, code));
      return response.status === 429 || response.status >= 500 ? { retry: true, error: failure } : throwNow(failure);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new CodeIndexError('unrecognized_response');
    }
    return parseEnvelope<T>(parsed);
  }
}

function throwNow(error: CodeIndexError): never {
  throw error;
}

/** Validates the envelope; a response that does not read as contract 1.3+ is unusable, never partially trusted. */
export function parseEnvelope<T>(parsed: unknown): CodeIndexResponse<T> {
  const bad = () => new CodeIndexError('unrecognized_response');
  if (!isRecord(parsed) || !isRecord(parsed['meta']) || parsed['data'] === undefined) throw bad();
  const meta = parsed['meta'];
  const view = meta['view'];
  if (!isRecord(view) || typeof view['view_id'] !== 'string') throw bad();
  const active = view['active'];
  if (active !== null && active !== undefined) {
    if (!isRecord(active) || typeof active['version'] !== 'number' || typeof active['base_commit'] !== 'string'
      || typeof active['overlay_digest'] !== 'string') throw bad();
  }
  const contract = typeof meta['contract'] === 'string' ? meta['contract'] : '';
  if (!/^1\.(?:[3-9]|\d{2,})$/.test(contract)) throw bad();
  const truncation = isRecord(meta['truncation']) && typeof meta['truncation']['truncated'] === 'boolean'
    ? (meta['truncation'] as Truncation)
    : undefined;
  const data = parsed['data'];
  // `not_tracked` rides inside data (explain, affected, context) or beside it.
  const rawNotTracked = isRecord(data) && Array.isArray(data['not_tracked']) ? data['not_tracked']
    : Array.isArray(parsed['not_tracked']) ? parsed['not_tracked'] : [];
  return {
    data: data as T,
    view: { ...(view as unknown as ViewMeta), active: (active ?? null) as ViewActive | null },
    // A missing truncation block reads as cut: absence is never completeness.
    truncation: truncation ?? { truncated: true },
    complete: truncation?.truncated === false,
    notTracked: rawNotTracked.filter((item): item is string => typeof item === 'string'),
    contract,
  };
}

export interface ClientCredentialOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** The run-bound credential `--attest` minted; used instead of the stored login. */
  credential?: CodeIndexCredential;
  credentialsPath?: string;
}

/** The login the code index is read with, or `no_login`. */
export async function resolveClientCredential(options: ClientCredentialOptions): Promise<CodeIndexCredential> {
  if (options.credential !== undefined) return options.credential;
  const stored = await readLoginCredential({
    env: options.env, cwd: options.cwd,
    ...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}),
  });
  if (stored === null) throw new CodeIndexError('no_login');
  return stored;
}
