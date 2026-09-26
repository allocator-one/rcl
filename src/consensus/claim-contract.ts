import type { Finding } from './types.js';
import type { ClaimDescriptor } from '../evidence/claim-recovery/validation/claims.js';

/** A deliberately bounded assertion language, not a similarity classifier. */
interface Contract {
  kind: keyof typeof CONTRACTS;
  subject: string[];
  condition: string;
  observations: string[];
}
type ClaimText = Pick<Finding, 'file' | 'title' | 'description' | 'suggestedFix'>;
const PREFIX = 'rcl-claim-contract-v1:';
const CONTRACTS = {
  'embedded-authentication-key': {
    fields: ['authentication purpose', 'constant binding', 'configuration binding'],
    condition: 'The named authentication key is embedded in source instead of loaded from external configuration.',
  },
  'sql-value-interpolation': {
    fields: ['operation binding', 'query action', 'table', 'column', 'operator', 'input binding'],
    condition: 'The named input value is interpolated into SQL syntax instead of passed as a bound parameter.',
  },
  'absent-owner-authorization': {
    fields: ['principal', 'action', 'resource', 'required owner condition'],
    condition: 'Authentication alone permits deletion of another user resource without checking ownership.',
  },
  'unbounded-collection-materialization': {
    fields: ['collection', 'read operation', 'absent bound'],
    condition: 'Reading the named collection materializes all records without a row bound.',
  },
  'label-derived-privilege': {
    fields: ['guard binding', 'principal field', 'comparison operator', 'comparison literal', 'required condition'],
    condition: 'The privilege decision compares the principal username to a label instead of checking role membership.',
  },
  'unguarded-map-field-access': {
    fields: ['helper', 'receiver', 'field', 'guarded sibling fields', 'access operation', 'failure condition'],
    condition: 'Strict map field access without a presence guard raises KeyError when the named key is absent.',
  },
} as const;

function evidence(kind: keyof typeof CONTRACTS, subject: string[]): string {
  return CONTRACTS[kind].fields.map((label, index) => `${label}: ${subject[index]}`).join('; ');
}
const text = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/[.!]$/, '');
const sentences = (value: string) => value.trim().split(/(?<=[.!?])\s+(?=[A-Z])/).map(text);

/**
 * Bounded grammar productions for the same key-externalization predicate.
 * Referents are local to the parsed key. Neither arbitrary explanatory prose
 * nor a consequence involving another token purpose is thrown away.
 */
function keyExternalizationClause(sentence: string, purpose: string): boolean {
  const key = '(?:this(?: (?:key|secret))?|(?:the )?(?:key|secret)s?)';
  const source = '(?:source(?: code)?|code)';
  const external = '(?:(?:an? )?environment variables?|external configuration|a secrets manager)';
  const destination = `${external}(?: or ${external})?`;
  const motivation = '(?: to prevent secret exposure in source control)?';
  const modal = '(?:must|should)';
  const externalize = new RegExp(`^${key} ${modal} (?:never be hardcoded in ${source} and ${modal} )?be loaded from ${destination}${motivation}$`, 'i');
  const imperative = new RegExp(`^(?:load ${key} from ${destination}|use ${destination})$`, 'i');
  if (externalize.test(sentence) || imperative.test(sentence)) return true;
  const actor = '(?:anyone who reads the source code|an attacker with source access)';
  const capability = '(?:can|could|may)';
  const tokens = `(?:${purpose}s|${purpose} tokens)`;
  const forge = new RegExp(`^${actor} ${capability} (?:forge|create) valid ${tokens} and impersonate (?:any user|users)$`, 'i');
  return forge.test(sentence);
}

function hardcodedKey(f: ClaimText): Contract | undefined {
  const title = /^Hardcoded (?:([A-Z][A-Z0-9_]*) )?secret(?: key)?(?: in ([A-Z][A-Z0-9_]*) verification| exposes authentication to attack)?$/.exec(text(f.title));
  if (!title) return;
  const purpose = title[1] ?? title[2];
  if (!purpose) return;
  const binding = /^const ([A-Za-z_$][\w$]*) = process\.env\.([A-Za-z_$][\w$]*)/.exec((f.suggestedFix ?? '').trim());
  if (!binding) return;
  const parts = sentences(f.description);
  const literal = /^A hardcoded secret ('[^']*'|"[^"]*") is used for ([A-Z][A-Z0-9_]*) signing and verification$/.exec(parts[0] ?? '');
  const staticKey = /^The ([A-Z][A-Z0-9_]*)(?: signing)? (?:secret|key) (?:is|was|remains) (?:hardcoded (?:as a string literal|in (?:the )?(?:source|code))|a hardcoded string constant)$/.exec(parts[0] ?? '');
  if ((literal?.[2] ?? staticKey?.[1]) !== purpose) return;
  if (!parts.slice(1).every(part => keyExternalizationClause(part, purpose))) return;
  return { kind: 'embedded-authentication-key', subject: [`${purpose} signing and verification`, binding[1]!, binding[2]!],
    condition: 'The named authentication key is embedded in source instead of loaded from external configuration.',
    // The original finding retains its source observation. A fresh semantic
    // descriptor needs only its presence, never another copy of a credential.
    observations: literal ? ['Source literal observed'] : [] };
}

/** Accept a direct query argument or an immediately used immutable binding. */
function sqlParameter(fix: string, query: RegExpExecArray): string | undefined {
  const before = fix.slice(0, query.index);
  const after = fix.slice(query.index + query[0].length);
  const call = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*';
  if (before.trimEnd().endsWith('(')) {
    return /^\s*,\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*\)/.exec(after)?.[1];
  }
  const statement = before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1);
  const declaration = /^\s*const ([A-Za-z_$][\w$]*)\s*=\s*$/.exec(statement);
  if (!declaration) return;
  const binding = declaration[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*;\\s*(?:return\\s+|await\\s+)?${call}\\(\\s*${binding}\\s*,\\s*\\[\\s*([A-Za-z_$][\\w$]*)\\s*\\]\\s*\\)(?:\\s*;)?$`).exec(after.trimEnd())?.[1];
}

function sqlInterpolation(f: ClaimText): Contract | undefined {
  const title = /^SQL injection(?: vulnerability)? (?:in|via string interpolation in) ([A-Za-z_$][\w$]*|DELETE endpoint)$/i.exec(text(f.title));
  if (!title) return;
  const fix = f.suggestedFix ?? '';
  const queries = [...fix.matchAll(/(['"])(SELECT \* FROM ([A-Za-z_][\w]*) WHERE ([A-Za-z_][\w]*) = (?:\$1|\?)|DELETE FROM ([A-Za-z_][\w]*) WHERE ([A-Za-z_][\w]*) = \$1)\1/gi)];
  if (queries.length !== 1) return;
  const query = queries[0]!;
  const parameter = sqlParameter(fix, query);
  if (!parameter) return;
  const operation = query[3] ? 'SELECT' : 'DELETE';
  const table = query[3] ?? query[5]!;
  const column = query[4] ?? query[6]!;
  const parts = sentences(f.description);
  const core = /^(User-controlled input|The ([A-Za-z_$][\w$]*) parameter|The user ID from the URL parameter|The ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+) value) is (?:directly )?interpolated(?: directly)? into (?:a |the )?(SQL query string|SQL string|SQL query|SQL DELETE statement)(?: without sanitization(?: or parameterization)?)?$/i.exec(parts[0] ?? '');
  if (!core) return;
  const namedSource = core[2] ?? core[3]?.split('.').at(-1);
  if (namedSource && namedSource !== parameter) return;
  if (core[4]?.toUpperCase() === 'SQL DELETE STATEMENT' && operation !== 'DELETE') return;
  if (title[1]?.toUpperCase() === 'DELETE ENDPOINT' && operation !== 'DELETE') return;
  if (!parts.slice(1).every(part => /^This (?:is a (?:classic|textbook) SQL injection vulnerability|allows SQL injection attacks)$/i.test(part))) return;
  return { kind: 'sql-value-interpolation', subject: [title[1]!, operation, table, column, '=', parameter],
    condition: 'The named input value is interpolated into SQL syntax instead of passed as a bound parameter.', observations: [] };
}

function ownerAuthorization(f: ClaimText): Contract | undefined {
  const title = /^(?:IDOR: missing authorization on DELETE endpoint|Missing authorization check allows any user to delete any ([a-z]+)|IDOR vulnerability [—–-] missing ownership check on delete)$/i.exec(text(f.title));
  if (!title) return;
  const parts = sentences(f.description);
  let deletion = false;
  let ownership = false;
  let resource: string | undefined;
  // A named route is supported only when it names this file's resource and
  // its sole parameter is the target id. Other routes/conditions stay raw.
  const fileResource = f.file.split('/').at(-1)?.replace(/\.[^.]+$/, '').toLowerCase();
  for (const part of parts) {
    const effect = /^Any authenticated user can delete any (?:other user's ([a-z]+)(?: by supplying a different user ID in the URL)?|([a-z]+) including other users' ([a-z]+)s)$/i.exec(part);
    if (effect) {
      const target = (effect[1] ?? effect[3]!).toLowerCase();
      const namedResource = effect[2]?.toLowerCase();
      if (resource && resource !== target ||
          namedResource && namedResource !== target && namedResource !== `${target}s`) return;
      resource = target;
      deletion = true;
    } else if (/^The endpoint only (?:checks|validates) authentication but not authorization$/i.test(part)) {
      ownership = true;
    } else {
      const route = /^The DELETE \/([A-Za-z_][\w]*)\/:id endpoint only (?:checks|validates) authentication but not authorization$/i.exec(part);
      if (route) {
        if (route[1]!.toLowerCase() !== fileResource) return;
        ownership = true;
        continue;
      }
      const owner = /^There is no check that the requesting user owns the ([a-z]+) being deleted$/i.exec(part);
      const ownerResource = owner?.[1]?.toLowerCase();
      if (!ownerResource || resource && resource !== ownerResource) return;
      resource = ownerResource;
      ownership = true;
    }
  }
  if (!deletion || !ownership || !resource || title[1] && title[1].toLowerCase() !== resource) return;
  return { kind: 'absent-owner-authorization', subject: ['authenticated user', 'DELETE', resource, 'requesting user owns target resource'],
    condition: 'Authentication alone permits deletion of another user resource without checking ownership.', observations: [] };
}

function unboundedCollection(f: ClaimText): Contract | undefined {
  const title = /^(?:Missing pagination on ([A-Za-z_][\w]*) listing endpoint|Unbounded query on ([A-Za-z_][\w]*) table)$/i.exec(text(f.title));
  if (!title) return;
  const parts = sentences(f.description);
  const route = /^The GET \/([A-Za-z_][\w]*) endpoint fetches all ([A-Za-z_][\w]*) without pagination$/i.exec(parts[0] ?? '');
  const sql = /^SELECT \* FROM ([A-Za-z_][\w]*) without a LIMIT clause will return all records$/i.exec(parts[0] ?? '');
  if (!route && !sql) return;
  if (route && route[1]!.toLowerCase() !== route[2]!.toLowerCase()) return;
  const resource = (route?.[1] ?? sql![1]!).toLowerCase();
  if ((title[1] ?? title[2])!.toLowerCase().replace(/s$/, '') !== resource.replace(/s$/, '')) return;
  if (!parts.slice(1).every(part => /^(?:This will cause performance issues and excessive memory usage at scale|Add pagination to prevent memory exhaustion)$/i.test(part))) return;
  return { kind: 'unbounded-collection-materialization', subject: [resource, 'read all records', 'no pagination or row limit'],
    condition: 'Reading the named collection materializes all records without a row bound.', observations: [] };
}

function labelPrivilege(f: ClaimText): Contract | undefined {
  const title = /^(?:([a-z]+) check uses username instead of role|Broken ([a-z]+) role check [—–-] compares username instead of role)$/i.exec(text(f.title));
  if (!title) return;
  const parts = sentences(f.description);
  const core = /^The ([A-Za-z_$][\w$]*) (?:middleware|guard) checks (?:if )?([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*) === ('[^']*'|"[^"]*") (?:instead of checking a proper role field|which is a broken security check)$/i.exec(parts[0] ?? '');
  if (!core) return;
  if (core[2]!.split('.').at(-1)?.toLowerCase() !== 'username') return;
  const literal = core[3]!.slice(1, -1);
  if ((title[1] ?? title[2])!.toLowerCase() !== literal.toLowerCase()) return;
  // The effects and remedy must refer to the same privilege named in the
  // compared literal. Other principals, conditions, or extra duties refuse.
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const effects = new RegExp(`^Any user named ['"]${escaped}['"] would get ${escaped} access, and actual ${escaped}s with different usernames would be denied$`, 'i');
  const flag = `is${literal[0]!.toUpperCase()}${literal.slice(1)}`;
  if (!parts.slice(1).every(part => effects.test(part) || part === `It should verify a roles array or an ${flag} flag`)) return;
  return { kind: 'label-derived-privilege', subject: [core[1]!, core[2]!, '===', literal, 'role membership'],
    condition: 'The privilege decision compares the principal username to a label instead of checking role membership.', observations: [] };
}

/** Parse the access and its absent-key precondition, including contextual guards. */
function mapFieldAccess(f: ClaimText): Contract | undefined {
  if ((f.description.match(/`/g) ?? []).length % 2 !== 0) return;
  const parts = sentences(f.description.replaceAll('`', ''));
  if (parts.length !== 2) return;
  const first = /^([A-Za-z_][\w]*(?:\/\d+)?) safely Map\.gets :([A-Za-z_][\w]*) \/ :([A-Za-z_][\w]*), then uses ([A-Za-z_][\w]*)\.([A-Za-z_][\w]*) with dot access for the final fallback$/.exec(parts[0]!) ??
    /^([A-Za-z_][\w]*(?:\/\d+)?) retrieves :([A-Za-z_][\w]*) and :([A-Za-z_][\w]*) defensively using Map\.get\/2, but accesses ([A-Za-z_][\w]*)\.([A-Za-z_][\w]*) using dot syntax$/.exec(parts[0]!);
  if (!first) return;
  const [, helper, guardedA, guardedB, receiver, field] = first;
  const title = /^([A-Za-z_][\w]*(?:\/\d+)?) mixes Map\.get with hard field access$/.exec(text(f.title));
  const accessTitle = /^Unsafe map field access ([A-Za-z_][\w]*)\.([A-Za-z_][\w]*) in ([A-Za-z_][\w]*(?:\/\d+)?)$/.exec(text(f.title));
  if (!title && !accessTitle) return;
  const titleHelper = title?.[1] ?? accessTitle![3]!;
  if (titleHelper.includes('/') ? titleHelper !== helper : titleHelper !== helper!.split('/')[0]) return;
  if (accessTitle && (accessTitle[1] !== receiver || accessTitle[2] !== field)) return;
  const absent = /^A bare ([A-Za-z_][\w]*) map missing :([A-Za-z_][\w]*) will raise KeyError(?: despite the comment that this ("[^"]+"|“[^”]+”))?$/.exec(parts[1]!);
  const conditional = /^If ([A-Za-z_][\w]*) is missing the :([A-Za-z_][\w]*) key, evaluating ([A-Za-z_][\w]*)\.([A-Za-z_][\w]*) will raise a KeyError$/.exec(parts[1]!);
  if (!absent && !conditional) return;
  if ((absent?.[1] ?? conditional![1]) !== receiver || (absent?.[2] ?? conditional![2]) !== field) return;
  if (conditional && (conditional[3] !== receiver || conditional[4] !== field)) return;
  return { kind: 'unguarded-map-field-access', subject: [helper!, receiver!, field!, [guardedA, guardedB].sort().join(','), 'strict dot access', 'absent key raises KeyError'],
    condition: CONTRACTS['unguarded-map-field-access'].condition,
    // A quoted comment is attributed context, not an asserted extra runtime
    // obligation. Preserve it verbatim in its immutable sighting descriptor.
    observations: absent?.[3] ? [`Quoted comment observed: ${absent[3]}`] : [] };
}

/** Every accepted sentence is parsed; no subset of a compound claim qualifies. */
export function describeContract(f: ClaimText): ClaimDescriptor | undefined {
  const contract = hardcodedKey(f) ?? sqlInterpolation(f) ?? ownerAuthorization(f) ?? unboundedCollection(f) ?? labelPrivilege(f) ?? mapFieldAccess(f);
  if (!contract) return;
  const descriptor: ClaimDescriptor = {
    version: 1,
    operation: `${f.file} :: ${PREFIX}${JSON.stringify([contract.kind, contract.subject])}`,
    invariant: contract.condition,
    evidence: [evidence(contract.kind, contract.subject), ...contract.observations],
  };
  if ([descriptor.operation, descriptor.invariant, ...descriptor.evidence].some(value => [...value].length > 500)) return;
  return descriptor;
}

export function isContractDescriptor(descriptor: ClaimDescriptor): boolean {
  return descriptor.operation.includes(` :: ${PREFIX}`);
}

/** Applies only to explicitly generated contracts, never to retained free text. */
export function compareContractDescriptors(a: ClaimDescriptor, b: ClaimDescriptor): 'exact_descriptor' | 'supported_paraphrase' | undefined {
  const parse = (descriptor: ClaimDescriptor): keyof typeof CONTRACTS | undefined => {
    const marker = descriptor.operation.indexOf(` :: ${PREFIX}`);
    if (marker <= 0) return;
    try {
      const parsed: unknown = JSON.parse(descriptor.operation.slice(marker + ` :: ${PREFIX}`.length));
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' ||
          !Object.hasOwn(CONTRACTS, parsed[0]) || !Array.isArray(parsed[1])) return;
      const kind = parsed[0] as keyof typeof CONTRACTS;
      const subject: unknown[] = parsed[1];
      if (subject.length !== CONTRACTS[kind].fields.length || !subject.every(value => typeof value === 'string' && value.length > 0)) return;
      if (descriptor.invariant !== CONTRACTS[kind].condition || descriptor.evidence[0] !== evidence(kind, subject as string[])) return;
      if (!['embedded-authentication-key', 'unguarded-map-field-access'].includes(kind) && descriptor.evidence.length !== 1) return;
      if (descriptor.evidence.length > 2) return;
      return kind;
    } catch { return; }
  };
  const kind = parse(a);
  if (!kind || parse(b) !== kind) return;
  if (a.operation !== b.operation || a.invariant !== b.invariant || a.evidence[0] !== b.evidence[0]) return;
  // Embedding any literal violates this contract. New descriptors retain only
  // the observation's presence; historical literal observations stay readable
  // and are compared without rewriting their immutable descriptor bytes.
  const observation = kind === 'unguarded-map-field-access'
    ? /^Quoted comment observed: ("[^"]+"|“[^”]+”)$/
    : /^Source literal observed(?:: ('[^']*'|"[^"]*"))?$/;
  if (![...a.evidence.slice(1), ...b.evidence.slice(1)].every(value => observation.test(value))) return;
  return JSON.stringify(a.evidence) === JSON.stringify(b.evidence) ? 'exact_descriptor' : 'supported_paraphrase';
}
