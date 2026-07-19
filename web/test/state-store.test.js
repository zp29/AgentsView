import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/state-store.js';

async function temporaryStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.init();
  return store;
}

test('derives three root states while preserving outcomes under completed', async (t) => {
  const store = await temporaryStore(t);
  await store.upsertTask({ id: 'running', title: 'Run', agent: 'codex', status: 'running' });
  await store.upsertTask({ id: 'waiting', title: 'Wait', agent: 'claude', status: 'running' });
  await store.createApproval({
    id: 'approval-one', taskId: 'waiting', title: 'Approve', summary: 'npm test',
    adapterRef: { adapter: 'demo', requestId: 'native-one' },
  });
  await store.upsertTask({ id: 'failed', title: 'Fail', agent: 'codex', status: 'completed', outcome: 'failed' });

  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.tasks.map((task) => task.status).sort(), ['completed', 'running', 'waiting_approval']);
  assert.equal(snapshot.tasks.find((task) => task.id === 'failed').outcome, 'failed');
  assert.equal(snapshot.approvals[0].adapterRef, undefined);
});

test('supports multiple approvals for one task and only releases after the last decision', async (t) => {
  const store = await temporaryStore(t);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'running' });
  for (const id of ['a', 'b']) {
    await store.createApproval({
      id, taskId: 'task', title: id, summary: id,
      adapterRef: { adapter: 'demo', requestId: `native-${id}` },
    });
  }
  await store.beginDecision('a', 'allow', 'test');
  await store.completeDecision('a');
  assert.equal(store.getTask('task').status, 'waiting_approval');
  await store.beginDecision('b', 'deny', 'test');
  await store.completeDecision('b');
  assert.equal(store.getTask('task').status, 'running');
});

test('recovers active work as interrupted and expires orphan approvals', async (t) => {
  const store = await temporaryStore(t);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'running' });
  await store.createApproval({
    id: 'approval', taskId: 'task', title: 'Approval', summary: 'Write',
    adapterRef: { adapter: 'codex', requestId: 'rpc-1' },
  });

  const reloaded = new StateStore(store.dataDir);
  await reloaded.init();
  assert.equal(reloaded.getTask('task').status, 'completed');
  assert.equal(reloaded.getTask('task').outcome, 'interrupted');
  assert.equal(reloaded.getApproval('approval').state, 'expired');
});

test('does not resurrect a completed task when a late running status arrives', async (t) => {
  const store = await temporaryStore(t);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'completed', outcome: 'succeeded' });
  await store.upsertTask({ id: 'task', status: 'running', summary: 'late idle event' });
  assert.equal(store.getTask('task').status, 'completed');
  assert.equal(store.getTask('task').outcome, 'succeeded');
});

test('does not reopen a resolved approval when its provider event is replayed', async (t) => {
  const store = await temporaryStore(t);
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'codex', status: 'running' });
  const input = {
    id: 'approval', taskId: 'task', title: 'Approval', summary: 'Write',
    adapterRef: { adapter: 'codex', requestId: 'rpc-1' },
  };
  await store.createApproval(input);
  await store.beginDecision('approval', 'deny', 'test');
  await store.completeDecision('approval');
  const replayed = await store.createApproval({ ...input, id: 'replacement' });
  assert.equal(replayed.id, 'approval');
  assert.equal(replayed.state, 'denied');
  assert.equal(store.snapshot().approvals.length, 1);
});
