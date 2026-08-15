import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- plain ESM build script, no type declarations
import { renderAll, readSource, render, SKILLS, TARGETS } from '../../scripts/build-skills.mjs';

type Rendered = { path: string; content: string };

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

  it('keeps each host on its own backgrounding mechanism', () => {
    const bySkillDir = new Map(
      (renderAll() as Rendered[]).map((r) => [r.path, r.content])
    );
    for (const [path, content] of bySkillDir) {
      if (path.includes('/.claude/')) {
        // Claude Code has a first-class background facility; the nohup/PID
        // dance is Codex-only and would be unrunnable guidance here.
        expect(content, path).toContain('run_in_background');
        expect(content, path).not.toContain('nohup');
      } else {
        expect(content, path).toContain('nohup');
      }
    }
  });

  it('machine-claims every convergence attempt before launching a review', () => {
    const convergeSkills = (renderAll() as Rendered[]).filter(({ path }) =>
      path.includes('/rcl-converge/')
    );
    expect(convergeSkills.length).toBeGreaterThan(0);

    for (const { path, content } of convergeSkills) {
      const claimCommand = "rcl converge-attempt --target '<TARGET>' <ATTEMPT_CAP_ARG>";
      const claimCount = content.split(claimCommand).length - 1;
      const claim = content.indexOf(claimCommand);
      const launch = content.indexOf('rcl review <target>');
      expect(claimCount, path).toBe(1);
      expect(claim, path).toBeGreaterThan(-1);
      expect(launch, path).toBeGreaterThan(claim);
      expect(content, path).toContain('Bash(rcl converge-attempt:*)');
      expect(content, path).toContain('every review attempt counts toward the configured cap');
      expect(content, path).toContain('machine-enforced cost cap defaults to 7');
      expect(content, path).toContain('legacy `--max-rounds` flag remains a separate evidence-round limit');
      expect(content, path).toContain('`--max-attempts <N>`');
      expect(content, path).toContain('ask the user whether to stop for human review or continue');
      expect(content, path).toContain('Never invent a higher value on the user\'s behalf');
      expect(content, path).toContain('Exit 2 is the configured consent boundary');
      expect(content, path).toContain('Exit 3 is an accounting/infrastructure failure');
      expect(content, path).toContain('exit "$ATTEMPT_STATUS"');
      expect(content, path).toContain('Run the command block below exactly once');
      expect(content, path).toContain('Never terminate a live council merely because');
      if (path.includes('/.codex/') || path.includes('/.agents/')) {
        expect(content, path).toContain('echo "$$" > <RCL_TMP>/rcl-converge-<TARGET>-r<R>.pid');
      }
    }
  });
});
