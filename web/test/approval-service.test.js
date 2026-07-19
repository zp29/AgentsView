import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApprovalService } from '../src/approval-service.js';
import { AuditLog } from '../src/audit.js';
import { StateStore } from '../src/state-store.js';

async function fixture(t, resolveApproval = async () => ({ delivered: true }), auditOverride = null) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-approval-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const audit = new AuditLog(directory);
  await store.init();
  await audit.init();
  await store.upsertTask({ id: 'task', title: 'Task', agent: 'demo', status: 'running' });
  await store.createApproval({
    id: 'approval', taskId: 'task', title: 'Run tests', summary: 'npm test',
    adapterRef: { adapter: 'demo', requestId: 'native' },
  });
  const service = new ApprovalService({ store, audit: auditOverride || audit, adapters: { resolveApproval } });
  return { store, service };
}

test('delivers once and treats the same repeated decision as idempotent', async (t) => {
  let deliveries = 0;
  const { service } = await fixture(t, async () => { deliveries += 1; });
  const first = await service.decide('approval', 'allow', 'test');
  const repeated = await service.decide('approval', 'allow', 'test');
  assert.equal(first.idempotent, false);
  assert.equal(repeated.idempotent, true);
  assert.equal(deliveries, 1);
});

test('serializes simultaneous decisions and rejects the conflicting one', async (t) => {
  const { service } = await fixture(t, () => new Promise((resolve) => setTimeout(resolve, 20)));
  const allow = service.decide('approval', 'allow', 'phone-a');
  const deny = service.decide('approval', 'deny', 'phone-b');
  await allow;
  await assert.rejects(deny, (error) => error.code === 'decision_conflict' && error.statusCode === 409);
});

test('rolls a failed delivery back to pending', async (t) => {
  const { store, service } = await fixture(t, async () => { throw new Error('adapter offline'); });
  await assert.rejects(service.decide('approval', 'allow'), (error) => error.code === 'delivery_failed');
  assert.equal(store.getApproval('approval').state, 'pending');
});

test('rolls back before delivery when the audit trail is unavailable', async (t) => {
  let deliveries = 0;
  const audit = { write: async () => { throw new Error('disk full'); } };
  const { store, service } = await fixture(t, async () => { deliveries += 1; }, audit);
  await assert.rejects(service.decide('approval', 'allow'), (error) => error.code === 'audit_unavailable' && error.statusCode === 503);
  assert.equal(deliveries, 0);
  assert.equal(store.getApproval('approval').state, 'pending');
});

test('actively denies an expired approval and leaves another pending request waiting', async (t) => {
  const decisions = [];
  const { store, service } = await fixture(t, async (_approval, decision) => { decisions.push(decision); });
  await store.createApproval({
    id: 'approval-two', taskId: 'task', title: 'Second request', summary: 'write file',
    adapterRef: { adapter: 'demo', requestId: 'native-two' },
  });
  const approval = store.getApproval('approval');
  approval.expiresAt = new Date(Date.now() - 1_000).toISOString();

  await assert.rejects(service.decide('approval', 'allow'), (error) => error.code === 'approval_stale' && error.statusCode === 410);
  assert.deepEqual(decisions, ['deny']);
  assert.equal(store.getApproval('approval').state, 'expired');
  assert.equal(store.getTask('task').status, 'waiting_approval');
});
