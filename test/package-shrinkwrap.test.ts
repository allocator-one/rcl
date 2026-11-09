import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildShrinkwrap } from '../scripts/build-shrinkwrap.mjs';

const root = new URL('../', import.meta.url);
const readJson = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8')) as Record<string, any>;

describe('published package pins its dependencies (RCL-208)', () => {
  // npm applies a package's own npm-shrinkwrap.json at install time; package-lock.json is never published.
  let packDir: string;
  let shrinkwrap: Record<string, any>;
  let manifest: Record<string, any>;
  beforeAll(() => {
    packDir = mkdtempSync(join(tmpdir(), 'rcl-208-'));
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [{ filename }] = JSON.parse(out) as Array<{ filename: string }>;
    const extract = (name: string) => JSON.parse(execFileSync('tar', ['-xOf', join(packDir, filename), `package/${name}`], { encoding: 'utf8' }));
    shrinkwrap = extract('npm-shrinkwrap.json');
    manifest = extract('package.json');
  }, 120_000);
  afterAll(() => rmSync(packDir, { recursive: true, force: true }));

  it('ships an npm-shrinkwrap.json that pins every runtime dependency with a registry integrity hash', () => {
    expect(shrinkwrap.name).toBe(manifest.name);
    expect(shrinkwrap.version).toBe(manifest.version);
    expect(shrinkwrap.packages[''].dependencies).toEqual(manifest.dependencies);
    for (const name of Object.keys(manifest.dependencies)) {
      const entry = shrinkwrap.packages[`node_modules/${name}`];
      expect(entry?.resolved, `${name} resolved`).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry?.integrity, `${name} integrity`).toMatch(/^sha512-/);
    }
  });

  it('leaves out development packages, which would make every install fetch the build tools', () => {
    expect(shrinkwrap.packages[''].devDependencies).toBeUndefined();
    const dev = Object.keys(shrinkwrap.packages).filter((path) => shrinkwrap.packages[path].dev);
    expect(dev).toEqual([]);
    for (const name of ['typescript', 'vitest', 'tsx', 'review-council-legacy412']) {
      expect(shrinkwrap.packages[`node_modules/${name}`], name).toBeUndefined();
    }
  });

  it('is a complete tree for the published manifest, so npm resolves nothing outside it', () => {
    const dir = join(packDir, 'tree');
    execFileSync('mkdir', [dir]);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'npm-shrinkwrap.json'), JSON.stringify(shrinkwrap));
    expect(() => execFileSync('npm', ['ls', '--all', '--omit=dev', '--package-lock-only'], { cwd: dir, stdio: 'pipe' })).not.toThrow();
  }, 60_000);

  it('keeps package-lock.json as the repository lockfile and out of the working tree as a shrinkwrap', () => {
    expect(existsSync(new URL('package-lock.json', root))).toBe(true);
    expect(existsSync(new URL('npm-shrinkwrap.json', root))).toBe(false);
  });
});

describe('buildShrinkwrap', () => {
  const lock = {
    name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'x', version: '1.0.0', dependencies: { a: '^1' }, devDependencies: { b: '^1' } },
      'node_modules/a': { version: '1.2.3', resolved: 'https://registry.npmjs.org/a/-/a-1.2.3.tgz', integrity: 'sha512-a' },
      'node_modules/c': { version: '1.0.0', resolved: 'https://registry.npmjs.org/c/-/c-1.0.0.tgz', integrity: 'sha512-c', devOptional: true },
      'node_modules/b': { version: '1.0.0', resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz', integrity: 'sha512-b', dev: true },
    },
  };

  it('keeps what the dependencies reach and drops dev and devOptional packages', () => {
    const result = buildShrinkwrap(lock, { name: 'x', version: '1.0.0' });
    expect(Object.keys(result.packages)).toEqual(['', 'node_modules/a']);
    expect(result.packages[''].devDependencies).toBeUndefined();
  });

  it('refuses a production package that is not pinned by URL and hash', () => {
    const unpinned = structuredClone(lock);
    delete (unpinned.packages['node_modules/a'] as Record<string, unknown>).integrity;
    expect(() => buildShrinkwrap(unpinned, { name: 'x', version: '1.0.0' })).toThrow(/node_modules\/a/);
  });

  it('refuses a lockfile that no longer matches the package version', () => {
    expect(() => buildShrinkwrap(lock, { name: 'x', version: '1.0.1' })).toThrow(/out of date/);
  });
});
