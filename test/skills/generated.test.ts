import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM build script, no type declarations
import { renderAll, readSource, render, SKILLS, TARGETS } from '../../scripts/build-skills.mjs';

type Rendered = { path: string; content: string };

// Classify a rendered file by its path inside the repository, never by the
// absolute path: a checkout under `.claude/worktrees/<name>/` would otherwise
// read every Codex file as a Claude one.
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const isClaudeTarget = (path: string): boolean =>
  relative(ROOT, path).replaceAll('\\', '/').startsWith('.claude/');

describe('generated skill files', () => {
  it('match the source templates (run `npm run build:skills` if this fails)', () => {
    const stale: string[] = [];
    for (const { path, content } of renderAll() as Rendered[]) {
      if (readFileSync(path, 'utf8') !== content) stale.push(path);
    }
    expect(stale).toEqual([]);
  });

  it('renders every placeholder — no markers survive into the output', () => {
    for (const { path, content } of renderAll() as Rendered[]) {
      expect(content, path).not.toMatch(/\{\{[#/]?(PREFIX|DIR|claude|codex)\}?\}/);
    }
  });

  it('gives each host its own invocation sigil and self-referencing paths', () => {
    for (const skill of SKILLS as string[]) {
      const source = readSource(skill);
      for (const target of TARGETS as Array<{ dir: string; flavor: string; prefix: string }>) {
        const out = render(source, target) as string;
        // A skill referencing a sibling skill must point at its own tool dir.
        for (const other of ['.claude', '.agents', '.codex'].filter((d) => d !== target.dir)) {
          expect(out, `${skill}/${target.dir}`).not.toContain(`${other}/skills/`);
        }
        expect(out, `${skill}/${target.dir}`).toContain(`\`${target.prefix}rcl`);
      }
    }
  });

  it('uses a supported host handle without an external convergence claim', () => {
    for (const { path, content } of renderAll() as Rendered[]) {
      const convergence = path.replaceAll('\\', '/').includes('/rcl-converge/');
      if (!convergence) {
        expect(content, path).toContain(isClaudeTarget(path) ? 'run_in_background' : 'nohup');
        continue;
      }
      expect(content, path).toContain('rcl review <target> --guarded-converge');
      expect(content, path).not.toContain("rcl converge-attempt --target");
      expect(content, path).not.toContain('nohup');
      expect(content, path).not.toContain('GITHUB_TOKEN=');
      expect(content, path).not.toContain('--round <R> --attempt <ATTEMPT>');
      expect(content, path).toContain(isClaudeTarget(path) ? 'run_in_background: true' : 'persistent exec session');
      expect(content, path).toContain('native admitted state');
      expect(content, path).toContain('stop-upstream');
      expect(content, path).toContain('stop-review');
      expect(content, path).toContain('--retry-reason');
      expect(content, path).toContain('--max-attempts');
      expect(content, path).toContain('--max-rounds');
      expect(content, path).toContain('Exit 2 is the configured consent boundary');
      expect(content, path).toContain('Exit 3 is an accounting/infrastructure failure');
      expect(content, path).toContain('Never terminate a live council');
      expect(content, path).toContain('evidence: pending run=<run id>');
      expect(content, path).toContain('converged-dismissal-only');
    }
  });
});
