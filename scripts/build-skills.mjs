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
 *   {{#source}}…{{/source}}   kept only in this repository's own copies
 *   {{#vendored}}…{{/vendored}} kept only in copies synced into other repositories
 *
 * `renderVendored` produces the copies that scripts/sync-skills.mjs writes into
 * consumer repositories: rcl-only text (dogfooding this checkout, this repo's
 * own quality gates) is replaced by repository-neutral wording, and the banner
 * names the rcl ref they came from.
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

const BLOCKS = ['claude', 'codex', 'source', 'vendored'];

function applyBlocks(text, keep) {
  // Keep each retained block's body (minus its markers); drop every other
  // block's body and markers entirely.
  let out = text;
  for (const name of BLOCKS) {
    out = keep.has(name)
      ? out.replace(new RegExp(`^\\{\\{#${name}\\}\\}\\n|^\\{\\{/${name}\\}\\}\\n`, 'gm'), '')
      : out.replace(new RegExp(`^\\{\\{#${name}\\}\\}\\n[\\s\\S]*?^\\{\\{/${name}\\}\\}\\n`, 'gm'), '');
  }
  return out;
}

function renderWith(source, { dir, flavor, prefix }, banner, origin) {
  const keep = new Set([flavor === 'claude' ? 'claude' : 'codex', origin]);
  // Frontmatter must stay first, so the provenance banner goes after it.
  const withBanner = source.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${banner}`);
  return applyBlocks(withBanner, keep).replaceAll('{{PREFIX}}', prefix).replaceAll('{{DIR}}', dir);
}

export function render(source, target, skill = 'rcl') {
  const banner =
    `<!-- GENERATED FILE — do not edit. Source: skills/src/${skill}.md\n` +
    '     Edit the source, then run `npm run build:skills`. `npm test` enforces this. -->\n';
  return renderWith(source, target, banner, 'source');
}

/** The copy synced into another repository from rcl at `ref` (a tag or commit). */
export function renderVendored(source, target, skill, ref) {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`unsafe rcl ref: ${ref}`);
  const banner =
    `<!-- VENDORED — do not edit here. Upstream: allocator-one/rcl ${ref}, skills/src/${skill}.md\n` +
    '     rcl\'s sync-skills workflow replaces this file after every release; edit the upstream source. -->\n';
  return renderWith(source, target, banner, 'vendored');
}

export function readSource(skill) {
  return readFileSync(join(ROOT, 'skills', 'src', `${skill}.md`), 'utf8');
}

export function targetPath(skill, dir) {
  return join(ROOT, dir, 'skills', skill, 'SKILL.md');
}

/** Repository-relative paths of every skill file, in render order. */
export function skillPaths() {
  return SKILLS.flatMap((skill) => TARGETS.map((target) => `${target.dir}/skills/${skill}/SKILL.md`));
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
