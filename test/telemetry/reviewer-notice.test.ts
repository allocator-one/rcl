import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureNoticeShown, noticeText, NOTICE_FILE } from '../../src/telemetry/notice.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('ordinary acknowledgment does not acknowledge private prompts/results and each scope shows once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-private-notice-')); roots.push(root);
  const lines: string[] = [], write = (text: string) => { lines.push(text); }, host = 'harness.example.test';
  expect(await ensureNoticeShown(host, root, write)).toBe(true);
  expect(await ensureNoticeShown(host, root, write, 'private-reviewers')).toBe(true);
  expect(await ensureNoticeShown(host, root, write, 'private-reviewers')).toBe(false);
  expect(await ensureNoticeShown(host, root, write)).toBe(false);
  expect(lines[0]).toBe(noticeText(host));
  expect(lines[1]).toContain('captured prompts and raw reviewer results');
  expect(lines[1]).toContain('original owner or an explicitly authorized recovery run');
  expect(lines[1]).not.toContain('Never sent');
  const record = JSON.parse(await readFile(join(root, NOTICE_FILE), 'utf8'));
  expect(Object.keys(record.shown)).toEqual([host, `private-reviewers:${host}`]);
});
it('private acknowledgment never suppresses the unchanged ordinary notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-private-notice-')); roots.push(root);
  const lines: string[] = [], write = (text: string) => { lines.push(text); };
  expect(await ensureNoticeShown('harness.example.test', root, write, 'private-reviewers')).toBe(true);
  expect(await ensureNoticeShown('harness.example.test', root, write)).toBe(true);
  expect(lines[1]).toContain('Never sent: API keys, tokens, prompts');
});
