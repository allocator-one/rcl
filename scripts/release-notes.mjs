#!/usr/bin/env node
// Print the CHANGELOG.md section for one version, for use as GitHub Release notes.
// Usage: node scripts/release-notes.mjs v3.5.0  (or 3.5.0)
import { readFileSync } from 'node:fs';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: release-notes.mjs <vX.Y.Z>');
  process.exit(2);
}
const version = arg.replace(/^v/, '');
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');

// Headings look like "## 3.5.0 - 2026-09-15", "## 3.2.0 — 2026-09-08", or "## 2.1.4".
const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
if (end === -1) end = lines.length;

const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}
process.stdout.write(body + '\n');
