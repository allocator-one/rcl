#!/usr/bin/env node
// Write npm-shrinkwrap.json for the published tarball (RCL-208): package-lock.json
// without its development-only packages. A shrinkwrap that kept them would make
// every install of rcl fetch vitest, typescript and the rest of the build tools.
// Run by the `prepack` script and removed again by `postpack`, so the working
// tree keeps package-lock.json as its only lockfile for `npm ci`.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The package a dependency name resolves to from `from`, searching up through node_modules like npm does. */
function resolve(packages, from, name) {
  let base = from;
  for (;;) {
    const path = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[path]) return path;
    if (base === '') return undefined;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

/**
 * The production-only lockfile for a package: only what its dependencies reach,
 * through optional edges and non-optional peers too. This drops `dev` and
 * `devOptional` packages (typescript is an optional peer of cosmiconfig) and the
 * root's devDependencies.
 */
export function buildShrinkwrap(lock, pkg) {
  if (lock.lockfileVersion !== 3) throw new Error(`unsupported lockfileVersion ${lock.lockfileVersion}`);
  if (lock.name !== pkg.name || lock.version !== pkg.version) {
    throw new Error('package-lock.json is out of date: run npm install to sync name and version with package.json');
  }
  const { packages } = lock;
  // The tree below is walked from the lockfile's own root entry, so a dependency package.json gained since
  // the lockfile was written would be left out of the shrinkwrap without any error. peerDependenciesMeta
  // is compared too: it decides which peers the walk follows.
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    const sorted = (deps) => JSON.stringify(Object.entries(deps ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (sorted(packages['']?.[field]) !== sorted(pkg[field])) {
      throw new Error(`package-lock.json is out of date: its ${field} differ from package.json; run npm install`);
    }
  }
  const keep = new Set(['']);
  const queue = [''];
  while (queue.length > 0) {
    const path = queue.pop();
    const entry = packages[path];
    const edges = [
      ...Object.keys(entry.dependencies ?? {}).map((name) => [name, true]),
      ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, false]),
      ...Object.keys(entry.peerDependencies ?? {})
        .filter((name) => !entry.peerDependenciesMeta?.[name]?.optional)
        .map((name) => [name, true]),
    ];
    for (const [name, required] of edges) {
      const target = resolve(packages, path, name);
      if (!target) {
        if (required) throw new Error(`${path || pkg.name} requires ${name}, which package-lock.json does not contain`);
        continue;
      }
      if (!keep.has(target)) {
        keep.add(target);
        queue.push(target);
      }
    }
  }
  const pruned = {};
  for (const path of Object.keys(packages)) {
    if (!keep.has(path)) continue;
    const entry = packages[path];
    if (path === '') {
      const { devDependencies: _dev, ...root } = entry;
      pruned[path] = root;
      continue;
    }
    // A link points at a local directory: no registry URL or hash can pin it, so it is never accepted.
    if (entry.link || !entry.version || !entry.resolved || !entry.integrity) {
      throw new Error(`${path} has no version, resolved URL and integrity in package-lock.json`);
    }
    pruned[path] = entry;
  }
  return { ...lock, packages: pruned };
}

// Compare real paths: a URL pathname is percent-encoded, and argv[1] is not resolved through symlinks. A
// mismatch would skip the write, and prepack would still succeed and pack a tarball without the shrinkwrap.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  const shrinkwrap = buildShrinkwrap(read('package-lock.json'), read('package.json'));
  writeFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), `${JSON.stringify(shrinkwrap, null, 2)}\n`);
}
