#!/usr/bin/env node
/**
 * Generate every SKILL.md from the single source in skills/src/.
 *
 * The six skill files are deliberately not identical — each host differs in
 * how skills are invoked and how a long-running review is backgrounded — so
 * they cannot simply be symlinked. They are rendered instead:
 *
 *   {{PREFIX}}          invocation sigil: "/" for Claude Code, "$" for Codex
 *   {{DIR}}             the tool directory the file lives in
 *   {{#claude}}…{{/claude}}   kept only in the Claude Code variant
 *   {{#codex}}…{{/codex}}     kept only in the .agents / .codex variants
 *
 * Run `npm run build:skills` after editing skills/src/*.md. `npm test` fails
 * if the committed files drift from the source.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SKILLS = ['rcl', 'rcl-converge'];

/** Each target: which tool dir, which flavor, and the invocation sigil. */
export const TARGETS = [
  { dir: '.claude', flavor: 'claude', prefix: '/' },
  { dir: '.agents', flavor: 'codex', prefix: '$' },
  { dir: '.codex', flavor: 'codex', prefix: '$' },
];

function stripBlock(text, keep, drop) {
  // Keep the retained flavor's body (minus its markers), drop the other's
  // body and markers entirely.
  const keepRe = new RegExp(`^\\{\\{#${keep}\\}\\}\\n|^\\{\\{/${keep}\\}\\}\\n`, 'gm');
  const dropRe = new RegExp(`^\\{\\{#${drop}\\}\\}\\n[\\s\\S]*?^\\{\\{/${drop}\\}\\}\\n`, 'gm');
  return text.replace(dropRe, '').replace(keepRe, '');
}

export function render(source, { dir, flavor, prefix }, skill = 'rcl') {
  const keep = flavor === 'claude' ? 'claude' : 'codex';
  const drop = flavor === 'claude' ? 'codex' : 'claude';
  // Frontmatter must stay first, so the provenance banner goes after it.
  const banner =
    `<!-- GENERATED FILE — do not edit. Source: skills/src/${skill}.md\n` +
    '     Edit the source, then run `npm run build:skills`. `npm test` enforces this. -->\n';
  const withBanner = source.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${banner}`);
  return stripBlock(withBanner, keep, drop)
    .replaceAll('{{PREFIX}}', prefix)
    .replaceAll('{{DIR}}', dir);
}

export function readSource(skill) {
  return readFileSync(join(ROOT, 'skills', 'src', `${skill}.md`), 'utf8');
}

export function targetPath(skill, dir) {
  return join(ROOT, dir, 'skills', skill, 'SKILL.md');
}

/** @returns {Array<{path: string, content: string}>} every file to write. */
export function renderAll() {
  const out = [];
  for (const skill of SKILLS) {
    const source = readSource(skill);
    for (const target of TARGETS) {
      out.push({
        path: targetPath(skill, target.dir),
        content: render(source, target, skill),
      });
    }
  }
  return out;
}

// Only write when invoked as a script; importing this module (tests) is pure.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const { path, content } of renderAll()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`generated ${path.replace(`${ROOT}/`, '')}`);
  }
}
