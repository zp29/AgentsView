import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/audit.js';

test('redacts common inline credentials from audit entries', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = new AuditLog(directory);
  await audit.init();
  await audit.write('test', {
    detail: 'password=hunter2 token: abcdef123456 secret super-sensitive',
    authorization: 'Bearer should-never-appear',
  });
  const [file] = await readdir(path.join(directory, 'audit'));
  const content = await readFile(path.join(directory, 'audit', file), 'utf8');
  assert.doesNotMatch(content, /hunter2|abcdef123456|super-sensitive|should-never-appear/);
  assert.match(content, /\[redacted\]/);
});
