import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAdapter } from '../src/adapters/codex.js';

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function mockAdapter(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'app-server.mjs');
  await writeFile(fixture, `
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const approvalIds = new Set(['modern-command', 'modern-file', 'permissions', 'legacy-exec', 'legacy-patch']);
    const responses = new Set();
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    input.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'mock', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
      } else if (message.method === 'thread/start') {
        send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      } else if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        setTimeout(() => {
          send({ method: 'item/commandExecution/requestApproval', id: 'modern-command', params: {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-item', startedAtMs: Date.now(),
            command: 'npm install', cwd: '/tmp', reason: 'Needs registry access',
            networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
            additionalPermissions: { network: { enabled: true } }
          } });
          send({ method: 'item/fileChange/requestApproval', id: 'modern-file', params: {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-item', startedAtMs: Date.now(),
            reason: 'Write outside cwd', grantRoot: '/tmp/shared'
          } });
          send({ method: 'item/permissions/requestApproval', id: 'permissions', params: {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'permission-item', startedAtMs: Date.now(), cwd: '/tmp',
            reason: 'Use the internal service', permissions: { network: { domains: ['internal.example'] }, fileSystem: { write: ['/tmp/shared'] } }
          } });
          send({ method: 'execCommandApproval', id: 'legacy-exec', params: {
            conversationId: 'thread-1', callId: 'legacy-command-item', command: ['npm', 'test'], cwd: '/tmp', reason: 'legacy command', parsedCmd: []
          } });
          send({ method: 'applyPatchApproval', id: 'legacy-patch', params: {
            conversationId: 'thread-1', callId: 'legacy-patch-item', reason: 'legacy patch', grantRoot: '/tmp/legacy', fileChanges: { 'a.js': { type: 'add' } }
          } });
          send({ method: 'item/tool/requestUserInput', id: 'unsupported', params: { threadId: 'thread-1', turnId: 'turn-1' } });
        }, 5);
      } else if (approvalIds.has(String(message.id)) || message.id === 'unsupported') {
        send({ method: 'mock/response', params: { threadId: 'thread-1', requestId: message.id, result: message.result, error: message.error } });
        if (approvalIds.has(String(message.id))) responses.add(String(message.id));
        if (responses.size === approvalIds.size) {
          setTimeout(() => {
            send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
            send({ method: 'thread/status/changed', params: { threadId: 'thread-1', status: { type: 'idle' } } });
          }, 5);
        }
      }
    });
  `, { mode: 0o600 });

  const events = [];
  const adapter = new CodexAdapter({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 2_000,
    onEvent: (event) => events.push(event),
  });
  t.after(() => adapter.stop());
  return { adapter, events };
}

test('supports modern, permissions, and legacy approvals with their exact response contracts', async (t) => {
  const { adapter, events } = await mockAdapter(t);
  await adapter.launch({ taskId: 'task-1', title: 'Protocol test', prompt: 'Exercise approvals', cwd: '/tmp' });

  const approvals = await waitFor(
    () => events.filter((event) => event.type === 'approval.requested').length === 5
      ? events.filter((event) => event.type === 'approval.requested')
      : null,
    'approval requests were not received',
  );
  const byRpcId = new Map(approvals.map((approval) => [approval.rpcId, approval]));

  assert.equal(byRpcId.get('modern-command').requestId, 'codex:thread-1:string:modern-command');
  assert.deepEqual(byRpcId.get('modern-command').data.networkApprovalContext, { host: 'registry.npmjs.org', protocol: 'https' });
  assert.equal(byRpcId.get('modern-file').data.grantRoot, '/tmp/shared');
  assert.deepEqual(byRpcId.get('permissions').data.network, { domains: ['internal.example'] });

  await adapter.resolveApproval(byRpcId.get('modern-command').requestId, 'allow');
  await adapter.resolveApproval(byRpcId.get('modern-file').requestId, 'deny');
  await adapter.resolveApproval(byRpcId.get('permissions').requestId, 'allow');
  await adapter.resolveApproval(byRpcId.get('legacy-exec').requestId, 'allow');
  await adapter.resolveApproval(byRpcId.get('legacy-patch').requestId, 'deny');

  const responses = await waitFor(() => {
    const values = events.filter((event) => event.type === 'server.notification' && event.message === 'mock/response');
    return values.length === 6 ? values : null;
  }, 'mock server did not observe every response');
  const responseById = new Map(responses.map((event) => [event.data.requestId, event.data]));

  assert.deepEqual(responseById.get('modern-command').result, { decision: 'accept' });
  assert.deepEqual(responseById.get('modern-file').result, { decision: 'decline' });
  assert.deepEqual(responseById.get('permissions').result, {
    scope: 'turn',
    permissions: { network: { domains: ['internal.example'] }, fileSystem: { write: ['/tmp/shared'] } },
  });
  assert.deepEqual(responseById.get('legacy-exec').result, { decision: 'approved' });
  assert.deepEqual(responseById.get('legacy-patch').result, { decision: 'denied' });
  assert.equal(responseById.get('unsupported').error.code, -32601);

  const completed = await waitFor(() => events.find((event) => event.type === 'task.completed'), 'task did not complete');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterCompletion = events.slice(events.indexOf(completed) + 1);
  assert.equal(afterCompletion.some((event) => event.type === 'task.status'), false);
  await adapter.stop();
  assert.equal(events.slice(events.indexOf(completed) + 1).some((event) => event.type === 'task.error'), false);
});

test('denying a permissions request returns an empty granted subset', async (t) => {
  const { adapter, events } = await mockAdapter(t);
  await adapter.launch({ taskId: 'task-2', title: 'Permission denial', prompt: 'Deny permissions', cwd: '/tmp' });
  const approval = await waitFor(
    () => events.find((event) => event.type === 'approval.requested' && event.rpcId === 'permissions'),
    'permissions request was not received',
  );
  await adapter.resolveApproval(approval.requestId, 'deny');
  const response = await waitFor(
    () => events.find((event) => event.type === 'server.notification' && event.message === 'mock/response' && event.data.requestId === 'permissions'),
    'permissions response was not received',
  );
  assert.deepEqual(response.data.result, { scope: 'turn', permissions: {} });
});
