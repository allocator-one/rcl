import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveDataDir } from '../../config/data-dir.js';
import { parseRepoName } from '../../resolver/github.js';
import { scrubDeep } from '../scrub.js';
import { fileFailure, hasSyntheticAncestor, platformPath, readStable } from './files.js';
import { parseSource, SHA256, unsupportedSourceDetails, UUID } from './source.js';
import type { DiscoveryOptions, RecoveryInventory, RecoverySource, RepositoryProof } from './types.js';

const execute = promisify(execFile);
const SKIP = new Set(['node_modules', 'deps', '_build', '.next', '.cache', '.ssh', '.aws', 'secrets', 'credentials', 'objects', 'hooks', 'refs', 'logs', 'vendor']);
const RCL_DIRECTORY = /(?:^|[-_.])rcl[-_.](?:converge|reports?|output|data|run)|review-council-output|^outbox$|^scratchpad$/i;
const REPORT_NAME = /(?:report.*\.json|\.json\.tmp|report_json\.json)$/i;
const REFERENCE_NAME = /(?:ledger|converge|handoff|progress|metadata|manifest).*(?:\.md|\.json|\.txt)$/i;

export async function gitMetadata(worktree: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await execute('git', ['-C', worktree, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

export function repositoryFromRemote(remote: string): string | null {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^\s?#]+?)(?:\.git)?$/.exec(remote);
  const parsed = match ? parseRepoName(match[1]!) : null;
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

export function beneath(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function credentialPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => ['secrets', 'credentials', '.ssh', '.aws', '.env'].includes(part)) ||
    /^(?:.*credentials.*|auth|tokens?)\.json$/i.test(basename(path));
}

/** Report references are hints to regular files, never evidence reconstructed from prose. */
export function reportReferences(text: string, from: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split('\n')) {
    if (!/report|json[-_ ]?file|artifact|output|round/i.test(line)) continue;
    for (const match of line.matchAll(/`([^`\n]+\.json(?:\.tmp)?)`|"([^"\n]+\.json(?:\.tmp)?)"|'([^'\n]+\.json(?:\.tmp)?)'|((?:\/|\.\.?\/)[^\s<>`"']+\.json(?:\.tmp)?)/g)) {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4]!;
      if (value.includes('://')) continue;
      const path = platformPath(isAbsolute(value) ? value : resolve(dirname(from), value));
      if (!credentialPath(path)) paths.add(path);
    }
  }
  return [...paths];
}

/** Filename-first discovery. Original report bytes and queues are never modified. */
export async function inventoryRefutations(options: DiscoveryOptions = {}): Promise<RecoveryInventory> {
  const excluded = new Set(options.excludeSha256 ?? []);
  if ([...excluded].some((hash) => !SHA256.test(hash))) throw new Error('invalid_excluded_sha256');
  const inventory: RecoveryInventory = {
    kind: 'rcl-refutation-inventory', version: 1, created_at: new Date().toISOString(),
    coverage: { roots: [], worktrees: [], git_common_dirs: [], references: [], issues: [], excluded_sha256: [], outbox: [] }, reports: [],
  };
  const coverage = inventory.coverage;
  const roots = options.roots ?? [join(homedir(), 'Development'), '/tmp', '/private/tmp', tmpdir(), resolveDataDir()];
  const directories: Array<{ path: string; rcl: boolean; synthetic: boolean }> = [];
  const visited = new Set<string>();
  const candidates = new Map<string, boolean>();
  const referenceFiles = new Set<string>();
  const repositories = new Set<string>();
  const referencedProofs = new Map<string, RepositoryProof[]>();
  const syntheticAncestors = new Map<string, boolean>();
  const containingProofs = (path: string): RepositoryProof[] => {
    const matches = coverage.worktrees.filter((p) => beneath(path, p.worktree)).sort((a, b) => b.worktree.length - a.worktree.length);
    return matches.length ? [matches[0]!] : [];
  };

  const addRoot = async (path: string): Promise<void> => {
    try {
      const canonical = await realpath(path);
      if (!coverage.roots.includes(canonical)) {
        coverage.roots.push(canonical);
        directories.push({ path: canonical, rcl: RCL_DIRECTORY.test(basename(canonical)), synthetic: false });
      }
    } catch (error) { coverage.issues.push({ path: platformPath(path), reason: fileFailure(error) }); }
  };
  for (const path of roots) await addRoot(path);

  const inspectGit = async (path: string): Promise<void> => {
    try {
      const common = await realpath(resolve(path, await gitMetadata(path, ['rev-parse', '--git-common-dir'])));
      if (repositories.has(common)) return;
      repositories.add(common);
      coverage.git_common_dirs.push(common);
      const repo = repositoryFromRemote(await gitMetadata(path, ['config', '--get', 'remote.origin.url']));
      const registered = (await gitMetadata(path, ['worktree', 'list', '--porcelain', '-z']))
        .split('\0').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
      for (const worktree of registered) {
        const canonical = platformPath(worktree);
        if (repo) coverage.worktrees.push({ worktree: canonical, repo });
        else coverage.issues.push({ path: canonical, reason: 'repository_remote_unbound' });
        await addRoot(canonical);
      }
      await addRoot(common);
    } catch { coverage.issues.push({ path, reason: 'git_metadata_unavailable' }); }
  };

  while (directories.length > 0) {
    const directory = directories.pop()!;
    if (visited.has(directory.path)) continue;
    visited.add(directory.path);
    let entries;
    try { entries = await readdir(directory.path, { withFileTypes: true }); }
    catch (error) { coverage.issues.push({ path: directory.path, reason: fileFailure(error) }); continue; }
    const synthetic = directory.synthetic || entries.some((entry) => entry.name === 'SYNTHETIC_TEST_ONLY' && entry.isFile());
    if (entries.some((entry) => entry.name === '.git' && !entry.isSymbolicLink())) await inspectGit(directory.path);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory.path, entry.name);
      if (SKIP.has(entry.name) || entry.name === '.git' || credentialPath(path)) continue;
      if (entry.isSymbolicLink()) {
        if (REPORT_NAME.test(entry.name) || /rcl|review-council/i.test(entry.name)) coverage.issues.push({ path, reason: 'symlink_excluded' });
      } else if (entry.isDirectory()) {
        directories.push({ path, rcl: directory.rcl || RCL_DIRECTORY.test(entry.name), synthetic });
      } else if (entry.isFile() || REPORT_NAME.test(entry.name)) {
        if (REPORT_NAME.test(entry.name) || (directory.rcl && /\.json(?:\.tmp)?$/i.test(entry.name))) candidates.set(path, synthetic);
        if (REFERENCE_NAME.test(entry.name) && !REPORT_NAME.test(entry.name)) referenceFiles.add(path);
      }
    }
    if (visited.size % 1000 === 0) options.progress?.(`Scanned ${visited.size} directories; ${candidates.size} candidate files`);
  }

  for (const path of referenceFiles) {
    try {
      const source = await readStable(path, 2 * 1024 * 1024);
      for (const reference of reportReferences(source.text, path)) {
        if (!coverage.references.includes(reference)) coverage.references.push(reference);
        if (!candidates.has(reference)) candidates.set(reference, false);
        if (REFERENCE_NAME.test(basename(reference)) && !REPORT_NAME.test(basename(reference))) referenceFiles.add(reference);
        const proofs = containingProofs(path).map((p) => ({ ...p, reference_path: path, reference_sha256: source.sha256 }));
        referencedProofs.set(reference, [...(referencedProofs.get(reference) ?? []), ...proofs]);
      }
    } catch (error) { coverage.issues.push({ path, reason: `reference_${fileFailure(error)}` }); }
  }

  const reports = new Map<string, RecoverySource>();
  for (const [path, synthetic] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const file = await readStable(path);
      if (synthetic || await hasSyntheticAncestor(path, syntheticAncestors)) excluded.add(file.sha256);
      let parsed;
      try { parsed = parseSource(file.text); }
      catch (error) {
        const reason = error instanceof Error ? error.message : 'unsupported_report';
        if (reason !== 'not_report') coverage.issues.push({ path, reason });
        if (reason === 'unsupported_report' || reason === 'unsupported_identity_version') {
          // Retain the original digest and disposition even when no transport
          // can safely reconstruct this producer's unsupported shape.
          const existing = reports.get(file.sha256);
          if (existing) existing.paths.push(path);
          else reports.set(file.sha256, {
            sha256: file.sha256, bytes: file.raw.length, paths: [path], mtime: file.mtime,
            format: 'unknown', repository_proofs: [], state: 'unsupported', reason,
            ...unsupportedSourceDetails(file.text),
          });
        }
        if (reason === 'not_report' && basename(path) === 'envelope.json' && path.split('/').includes('outbox')) {
          const envelope = JSON.parse(file.text) as Record<string, unknown>;
          const id = (envelope['run'] as { id?: unknown } | undefined)?.id;
          const declared = Array.isArray(envelope['artifacts_declared'])
            ? envelope['artifacts_declared'].find((a: unknown) => !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'report_json') as { sha256?: unknown } | undefined : undefined;
          const digest = typeof declared?.sha256 === 'string' && SHA256.test(declared.sha256) ? declared.sha256 : null;
          const reportPath = join(dirname(path), 'artifacts', 'report_json.json');
          coverage.outbox.push({ path, sha256: file.sha256, run_id: typeof id === 'string' && UUID.test(id) ? id : null, report_sha256: digest, report_path: reportPath });
          try {
            const original = await readStable(reportPath);
            if (original.sha256 !== digest) coverage.issues.push({ path, reason: 'outbox_original_report_conflict' });
          } catch { coverage.issues.push({ path, reason: 'outbox_original_report_missing' }); }
        }
        continue;
      }
      const existing = reports.get(file.sha256);
      const proofs = [...containingProofs(path), ...(referencedProofs.get(path) ?? [])];
      if (existing) {
        existing.paths.push(path);
        for (const proof of proofs) if (!existing.repository_proofs.some((p) => p.worktree === proof.worktree && p.repo === proof.repo && p.reference_path === proof.reference_path)) existing.repository_proofs.push(proof);
        continue;
      }
      const report = parsed.format === 'modern' ? parsed.report : undefined;
      const target = report ? scrubDeep(report.run.target) : null;
      const source: RecoverySource = {
        sha256: file.sha256, bytes: file.raw.length, paths: [path], mtime: file.mtime, format: parsed.format,
        run_id: report?.run.id ?? null, repo: target?.repo ?? null, target,
        repository_proofs: proofs, state: 'ready', refutations: parsed.refutations,
      };
      if (source.refutations.length === 0) source.state = 'no_refutations';
      else if (parsed.unsafe && parsed.format === 'modern') { source.state = 'unsafe'; source.reason = 'original_artifact_requires_redaction'; }
      reports.set(file.sha256, source);
    } catch (error) { coverage.issues.push({ path, reason: fileFailure(error) }); }
  }
  for (const source of reports.values()) {
    if (excluded.has(source.sha256)) { source.state = 'synthetic'; source.reason = 'explicit_synthetic_exclusion'; }
    else if (source.format === 'legacy' && source.state === 'ready') {
      const repos = new Set(source.repository_proofs.map((proof) => proof.repo.toLowerCase()));
      if (repos.size === 1) source.repo = [...repos][0]!;
      else { source.state = 'unbound'; source.reason = repos.size === 0 ? 'repository_not_proven' : 'ambiguous_repository'; }
    }
  }
  const runDigests = new Map<string, Set<string>>();
  for (const source of reports.values()) if (source.run_id && source.state !== 'synthetic') {
    const hashes = runDigests.get(source.run_id) ?? new Set(); hashes.add(source.sha256); runDigests.set(source.run_id, hashes);
  }
  for (const source of reports.values()) if (source.run_id && (runDigests.get(source.run_id)?.size ?? 0) > 1 && source.state !== 'synthetic') {
    source.state = 'conflict'; source.reason = 'same_original_run_multiple_digests';
  }
  inventory.reports = [...reports.values()];
  coverage.excluded_sha256 = [...excluded].sort();
  coverage.roots.sort(); coverage.git_common_dirs.sort(); coverage.references.sort();
  return inventory;
}
