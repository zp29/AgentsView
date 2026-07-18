import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdapterManager } from '../src/adapter-manager.js';
import { StateStore } from '../src/state-store.js';
import { hashText } from '../src/utils.js';

async function managerFixture(t, approvalTtlMs = 5_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.init();
  const auditEntries = [];
  const audit = { write: async (action, fields) => auditEntries.push({ action, ...fields }) };
  const manager = new AdapterManager({
    store,
    audit,
    config: {
      demoMode: false,
      codexMode: 'false',
      codexCommand: 'codex',
      claudeMode: 'false',
      anthropicApiKey: '',
      claudeHookSecret: '',
      approvalTtlMs,
      version: 'test',
    },
  });
  t.after(() => manager.stop());
  return { manager, store, auditEntries };
}

test('uses stable approval ids, retains network/grant-root context, and hashes audit summaries', async (t) => {
  const { manager, store, auditEntries } = await managerFixture(t);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'running' });
  const event = {
    type: 'approval.requested', provider: 'codex', taskId: 'task', requestId: 'native-1',
    approvalKind: 'command', summary: 'npm install private-package', at: new Date().toISOString(),
    data: { reason: 'Needs access', network: { host: 'registry.example' }, grantRoot: '/tmp/shared' },
  };
  await manager.handleEvent(event);
  await manager.handleEvent(event);

  const approvals = store.snapshot().approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, `approval-${hashText('codex\u0000native-1')}`);
  assert.match(approvals[0].details, /registry\.example/);
  assert.match(approvals[0].details, /\/tmp\/shared/);
  const requested = auditEntries.filter((entry) => entry.action === 'approval.requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0].summaryHash, hashText('npm install private-package'));
  assert.equal('summary' in requested[0], false);
});

test('normalizes nested Codex totals and ignores terminal-state idle/exit errors', async (t) => {
  const { manager, store } = await managerFixture(t);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'running', summary: 'working' });
  await manager.handleEvent({
    type: 'token.usage', provider: 'codex', taskId: 'task',
    data: { total: { inputTokens: 21, outputTokens: 8, totalTokens: 29 }, last: { totalTokens: 3 } },
  });
  assert.deepEqual(store.getTask('task').tokens, { input: 21, output: 8, total: 29 });

  await manager.handleEvent({ type: 'task.completed', provider: 'codex', taskId: 'task', outcome: 'completed', message: 'done' });
  await manager.handleEvent({ type: 'task.status', provider: 'codex', taskId: 'task', status: 'idle', message: 'late idle' });
  await manager.handleEvent({ type: 'task.error', provider: 'codex', taskId: 'task', message: 'app-server exited' });
  const task = store.getTask('task');
  assert.equal(task.status, 'completed');
  assert.equal(task.outcome, 'success');
  assert.equal(task.summary, 'done');
});

test('treats a provider system error as a failed terminal task', async (t) => {
  const { manager, store } = await managerFixture(t);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'running' });
  await manager.handleEvent({ type: 'task.status', provider: 'codex', taskId: 'task', status: 'error' });
  assert.equal(store.getTask('task').status, 'completed');
  assert.equal(store.getTask('task').outcome, 'failed');
});

test('refreshes showcase tasks without accumulating stale demo history', async (t) => {
  const { manager, store } = await managerFixture(t);
  manager.config.demoMode = true;
  await manager.start();
  const first = store.snapshot();
  assert.deepEqual(
    first.tasks.reduce((counts, task) => ({ ...counts, [task.status]: (counts[task.status] || 0) + 1 }), {}),
    { running: 3, waiting_approval: 2, completed: 1 },
  );
  await store.upsertTask({ id: 'demo-showcase-payment', status: 'completed', outcome: 'interrupted' });
  await manager.start();
  const second = store.snapshot();
  assert.equal(second.tasks.filter((task) => task.id.startsWith('demo-showcase-')).length, 6);
  assert.equal(second.tasks.find((task) => task.id === 'demo-showcase-payment').status, 'running');
});

test('runs the registered expiry handler when an approval reaches its deadline', async (t) => {
  const { manager, store } = await managerFixture(t, 25);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'running' });
  let expiredId = null;
  manager.setApprovalExpiryHandler(async (id) => {
    expiredId = id;
    await store.expireApproval(id);
    return true;
  });
  await manager.handleEvent({
    type: 'approval.requested', provider: 'codex', taskId: 'task', requestId: 'expires',
    approvalKind: 'file-change', summary: 'write file', at: new Date().toISOString(), data: { grantRoot: '/tmp' },
  });
  const approval = store.snapshot().approvals[0];
  const deadline = Date.now() + 1_000;
  while (!expiredId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(expiredId, approval.id);
  assert.equal(store.getApproval(approval.id).state, 'expired');
});

test('task queue audit stores only the prompt hash', async (t) => {
  const { manager, auditEntries } = await managerFixture(t);
  manager.demo = { isReady: () => true, launch: async () => ({ taskId: 'ok' }), stop: async () => {} };
  const prompt = 'Sensitive implementation instructions';
  await manager.launch({ agent: 'demo', title: 'Task', prompt, cwd: '/tmp' });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = auditEntries.find((entry) => entry.action === 'task.queued');
  assert.equal(queued.promptHash, hashText(prompt));
  assert.equal('prompt' in queued, false);
  assert.equal('summary' in queued, false);
});
