import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ClaudeHookBridge } from '../src/adapters/claude.js';
import { StateStore } from '../src/state-store.js';

test('holds a PermissionRequest and returns the original tool input after approval', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-hooks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.init();
  const bridge = new ClaudeHookBridge({ store, approvalTtlMs: 2_000 });
  t.after(() => bridge.stop());
  const toolInput = { command: 'npm test', description: 'Run tests' };
  const responsePromise = bridge.handle({
    hook_event_name: 'PermissionRequest', session_id: 'session-1', cwd: '/tmp',
    tool_name: 'Bash', tool_input: toolInput,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const approval = store.snapshot().approvals[0];
  const internal = store.getApproval(approval.id);
  await bridge.resolveApproval(internal.adapterRef.requestId, 'allow');
  const response = await responsePromise;
  assert.equal(response.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(response.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(response.hookSpecificOutput.decision.updatedInput, toolInput);
});

test('starts a new task when a completed Claude hook session receives another prompt', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-hooks-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.init();
  const bridge = new ClaudeHookBridge({ store, approvalTtlMs: 2_000 });
  t.after(() => bridge.stop());

  await bridge.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'session-resume', prompt: 'First task' });
  await bridge.handle({ hook_event_name: 'Stop', session_id: 'session-resume', last_assistant_message: 'Done' });
  const completed = store.snapshot().tasks[0];
  await bridge.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'session-resume', prompt: 'Second task' });

  const tasks = store.snapshot().tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((task) => task.id === completed.id).status, 'completed');
  assert.equal(tasks.find((task) => task.id !== completed.id).status, 'running');
});

test('prints a Claude HTTP hook timeout with margin after the approval TTL', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['src/cli.js', 'hooks-print'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_HOOK_SECRET: 'test-hook-secret',
      AGENTSVIEW_APPROVAL_TTL_MINUTES: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.hooks.PermissionRequest[0].hooks[0].timeout, 75);
});
