#!/usr/bin/env node
// Write npm-shrinkwrap.json for the published tarball (RCL-208): package-lock.json
// without its development-only packages. A shrinkwrap that kept them would make
// every install of rcl fetch vitest, typescript and the rest of the build tools.
// Run by the `prepack` script and removed again by `postpack`, so the working
// tree keeps package-lock.json as its only lockfile for `npm ci`.
import { readFileSync, writeFileSync } from 'node:fs';

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
    if (!entry.link && (!entry.resolved || !entry.integrity)) {
      throw new Error(`${path} has no resolved URL and integrity in package-lock.json`);
    }
    pruned[path] = entry;
  }
  return { ...lock, packages: pruned };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  const shrinkwrap = buildShrinkwrap(read('package-lock.json'), read('package.json'));
  writeFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), `${JSON.stringify(shrinkwrap, null, 2)}\n`);
}
