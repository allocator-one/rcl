import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeClaim, compareClaims } from '../../src/consensus/claim-identity.js';
import { describeContract } from '../../src/consensus/claim-contract.js';
import type { Finding } from '../../src/consensus/types.js';

const fixtures: Finding[] = ['claude', 'gpt', 'gemini'].flatMap(name =>
  JSON.parse(readFileSync(new URL(`../fixtures/review-${name}.json`, import.meta.url), 'utf8')).findings);
const original = (id: string) => fixtures.find(finding => finding.id === id)!;
const mapCorpus: Finding[] = JSON.parse(readFileSync(new URL('../fixtures/undermerge-corpus/ao-7354-r5-trigger-label-nil-name.json', import.meta.url), 'utf8'))
  .reviews.flatMap((review: { findings: Finding[] }) => review.findings);
const mapPair = ['trigger_label mixes Map.get with hard field access', 'Unsafe map field access column.name in trigger_label/1']
  .map(title => mapCorpus.find(finding => finding.title === title)!);
const pairs = [
  ['c001', 'g001'], ['c001', 'gem001'], ['g001', 'gem001'],
  ['c002', 'gem003'], ['c003', 'gem002'],
  ['c004', 'g004'], ['c004', 'gem005'], ['g004', 'gem005'],
  ['g003', 'gem004'], ['c005', 'g005'],
];

describe('bounded semantic contracts', () => {
  it.each(['title', 'description'])('rejects a SELECT remedy contradicting DELETE in the %s regardless of prose case', field => {
    const select = { ...original('c002'), title: 'SQL injection in readRows',
      description: 'User-controlled input is interpolated into a SQL query string.',
      suggestedFix: "Use db.query('SELECT * FROM users WHERE id = $1', [userId]);" };
    const contradictory = field === 'title'
      ? { ...select, title: 'SQL injection in delete endpoint' }
      : { ...select, description: 'User-controlled input is interpolated into a sql delete statement.' };

    expect(describeContract(select)).toBeDefined();
    expect(describeContract(contradictory)).toBeUndefined();
    expect(compareClaims(describeClaim(select), describeClaim(contradictory))).toBeUndefined();
  });

  it('accepts a matching DELETE remedy with mixed-case operation prose', () => {
    const finding = { ...original('c002'), title: 'SQL injection in delete endpoint',
      description: 'User-controlled input is interpolated into a Sql Delete Statement.',
      suggestedFix: "Use db.query('DELETE FROM users WHERE id = $1', [userId]);" };
    expect(describeContract(finding)).toBeDefined();
  });

  it('recognizes the supported plural ownership paraphrase without mixing resources', () => {
    const single = { file: 'src/posts.ts', title: 'Missing authorization check allows any user to delete any post',
      description: "Any authenticated user can delete any other user's post. The endpoint only checks authentication but not authorization." };
    const plural = { ...single,
      description: "Any authenticated user can delete any posts including other users' posts. The endpoint only checks authentication but not authorization." };

    expect(describeContract(single)).toBeDefined();
    expect(describeContract(plural)).toBeDefined();
    expect(compareClaims(describeClaim(single), describeClaim(plural))).toBeDefined();
    expect(describeContract({ ...plural, description: plural.description.replace("users' posts", "users' notes") })).toBeUndefined();
  });

  it('normalizes resource casing across ownership titles and descriptions', () => {
    const finding = { file: 'src/posts.ts', title: 'Missing authorization check allows any user to delete any Post',
      description: "Any authenticated user can delete any other user's POST. There is no check that the requesting user owns the post being deleted." };

    expect(describeContract(finding)).toBeDefined();
  });

  it('normalizes resource casing in unbounded collection contracts', () => {
    const finding = { file: 'src/users.ts', title: 'Missing pagination on Users listing endpoint',
      description: 'The GET /users endpoint fetches all USERS without pagination.' };

    expect(describeContract(finding)).toBeDefined();
  });

  it('recognizes uppercase privilege literals while retaining their exact value', () => {
    const role = (literal: string) => ({ file: 'src/auth.ts', title: 'Admin check uses username instead of role',
      description: `The requireAdmin middleware checks user.username === '${literal}' instead of checking a proper role field.` });

    expect(describeContract(role('admin'))).toBeDefined();
    expect(describeContract(role('Admin'))).toBeDefined();
    expect(compareClaims(describeClaim(role('admin')), describeClaim(role('Admin')))).toBeUndefined();
    expect(compareClaims(describeClaim(role('Admin')),
      describeClaim({ ...role('Admin'), title: 'ADMIN check uses username instead of role' }))).toBeDefined();
  });

  it('rejects a role-field comparison that contradicts the username privilege contract', () => {
    const finding = { file: 'src/auth.ts', title: 'Admin check uses username instead of role',
      description: "The requireAdmin middleware checks user.role === 'admin' instead of checking a proper role field." };

    expect(describeContract(finding)).toBeUndefined();
  });

  it('recognizes complete missing-map-key assertions with named access and presence condition', () => {
    expect(compareClaims(describeClaim(mapPair[0]!), describeClaim(mapPair[1]!))).toBeDefined();
    const rename = (f: Finding) => ({ ...f, title: f.title.replaceAll('trigger_label', 'render_caption').replaceAll('column.name', 'entry.caption'),
      description: f.description.replaceAll('trigger_label', 'render_caption').replaceAll('column', 'entry').replaceAll(':name', ':caption').replaceAll('.name', '.caption') });
    expect(compareClaims(describeClaim(rename(mapPair[0]!)), describeClaim(rename(mapPair[1]!)))).toBeDefined();
  });

  it('retains map access subjects, field names, additional nil conditions, and extra clauses', () => {
    const a = mapPair[1]!;
    for (const b of [
      { ...a, title: a.title.replaceAll('column', 'field'), description: a.description.replaceAll('column', 'field') },
      { ...a, title: a.title.replace('.name', '.label'), description: a.description.replaceAll('.name', '.label').replaceAll(':name', ':label') },
      { ...a, description: a.description.replace('is missing the :name key', 'is missing the :name key or its value is nil') },
      { ...a, description: `${a.description} A nil value also raises FunctionClauseError.` },
    ]) expect(compareClaims(describeClaim(a), describeClaim(b))).toBeUndefined();
  });
  it.each(pairs)('preserves the source-reviewed genuine paraphrase %s / %s', (left, right) => {
    expect(compareClaims(describeClaim(original(left!)), describeClaim(original(right!)))).toBeDefined();
  });

  it.each(['c001', 'c002', 'c003', 'c004', 'c005'])('does not discard an extra independent obligation on %s', id => {
    const a = original(id);
    for (const separator of ['. ', ' and ', '; ']) {
      const b = { ...a, description: a.description.replace(/[.]$/, '') + separator + 'The cache must reject expired entries.' };
      expect(compareClaims(describeClaim(a), describeClaim(b))).toBeUndefined();
    }
  });

  it('retains different key purposes and bindings', () => {
    const a = original('c001');
    const b = { ...a, title: a.title.replace('JWT', 'HMAC'), description: a.description.replaceAll('JWT', 'HMAC'), suggestedFix: a.suggestedFix?.replaceAll('JWT_SECRET', 'HMAC_SECRET') };
    expect(compareClaims(describeClaim(a), describeClaim(b))).toBeUndefined();
  });

  it('retains query resources, compared columns, operators, and bounds', () => {
    const a = original('c002');
    for (const fix of [a.suggestedFix!.replace('users', 'orders'), a.suggestedFix!.replace('id =', 'owner_id ='), a.suggestedFix!.replace('id =', 'id <>'), a.suggestedFix!.replace("$1';", "$1 LIMIT 25';")]) {
      expect(compareClaims(describeClaim(a), describeClaim({ ...a, suggestedFix: fix }))).toBeUndefined();
    }
  });

  it('retains the compared privilege literal', () => {
    const a = original('c003');
    expect(compareClaims(describeClaim(a), describeClaim({ ...a, description: a.description.replaceAll("'admin'", "'owner'") }))).toBeUndefined();
  });

  it('recognizes the same contracts after replacing domain bindings', () => {
    const renamed = (id: string, replacements: [string, string][]) => {
      const value = original(id);
      const rename = (s: string) => replacements.reduce((result, [from, to]) => result.replaceAll(from, to), s);
      return { ...value, file: rename(value.file), title: rename(value.title), description: rename(value.description),
        suggestedFix: value.suggestedFix && rename(value.suggestedFix) };
    };
    for (const [left, right, replacements] of [
      ['c001', 'g001', [['JWT', 'HMAC'], ['SECRET', 'SIGNING_KEY']]],
      ['c002', 'gem003', [['getUserData', 'readInvoice'], ['users', 'invoices'], ['userId', 'invoiceId']]],
      ['c004', 'g004', [['/users', '/documents'], ['account', 'document']]],
      ['c005', 'g005', [['users', 'invoices'], ['user listing', 'invoice listing']]],
      ['c003', 'gem002', [['admin', 'owner'], ['Admin', 'Owner'], ['user.username', 'principal.username']]],
    ] as [string, string, [string, string][]][]) {
      expect(compareClaims(describeClaim(renamed(left, replacements)), describeClaim(renamed(right, replacements)))).toBeDefined();
    }
  });

  it('parses key externalization grammar beyond the recorded reviewer sentences', () => {
    const a = original('c001');
    for (const description of [
      'The JWT key remains hardcoded in source. Load this key from external configuration.',
      'The JWT signing secret was hardcoded as a string literal. The secret must be loaded from an environment variable.',
      'The JWT key is hardcoded in code. An attacker with source access could create valid JWT tokens and impersonate users.',
      'The JWT secret is a hardcoded string constant. Keys should never be hardcoded in source and should be loaded from a secrets manager.',
    ]) expect(compareClaims(describeClaim(a), describeClaim({ ...a, description })), description).toBeDefined();
  });

  it('does not equate other uses or extra conditions in a key externalization assertion', () => {
    const a = original('c001');
    for (const description of [
      'The JWT key remains hardcoded in source. Load this key from external configuration after authenticating the tenant.',
      'The JWT key is hardcoded in code. An attacker with source access could create valid HMAC tokens and impersonate users.',
      'The JWT encryption secret is a hardcoded string constant. Load this key from external configuration.',
    ]) expect(compareClaims(describeClaim(a), describeClaim({ ...a, description }))).toBeUndefined();
  });

  it('retains owner resources, routes, and required conditions', () => {
    const a = original('g004');
    for (const description of [a.description.replaceAll('account', 'organization'), a.description.replace('/users/:id', '/orders/:id'),
      a.description.replace('/users/:id', '/users/:tenant_id'), a.description.replace('not authorization', 'not authentication')]) {
      expect(compareClaims(describeClaim(a), describeClaim({ ...a, description }))).toBeUndefined();
    }
  });

  it('retains collection bindings and additional query conditions', () => {
    const a = original('g005');
    for (const description of [a.description.replace('users', 'orders'), a.description.replace('without a LIMIT clause', 'with a LIMIT 10 clause'),
      a.description.replace('all records', 'all records where archived = false')]) {
      expect(compareClaims(describeClaim(a), describeClaim({ ...a, description }))).toBeUndefined();
    }
  });

  it('refuses malformed contract markers and extra evidence', () => {
    const a = describeClaim(original('c002'));
    for (const b of [
      { ...a, operation: a.operation.replace('sql-value-interpolation', 'unknown-contract') },
      { ...a, invariant: `${a.invariant} The cache must be valid.` },
      { ...a, evidence: [...a.evidence, "Source literal observed: 'different'"] },
      { ...a, evidence: ['Unrelated evidence has sufficient tokens.'] },
    ]) expect(compareClaims(a, b)).toBeUndefined();
  });

  it('does not reinterpret a retained free-text descriptor as a new normalized contract', () => {
    const a = original('c001');
    const retained = { version: 1 as const, operation: `${a.file} :: ${a.title}`, invariant: a.description,
      evidence: [a.title, a.description, a.suggestedFix!] };
    expect(compareClaims(retained, describeClaim(a))).toBeUndefined();
  });
});
