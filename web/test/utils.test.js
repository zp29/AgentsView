import assert from 'node:assert/strict';
import test from 'node:test';
import { agentEnvironment, assessRisk } from '../src/utils.js';

test('does not pass AgentsView control secrets into agent processes', () => {
  const previousToken = process.env.AGENTSVIEW_ACCESS_TOKEN;
  const previousHookSecret = process.env.CLAUDE_HOOK_SECRET;
  process.env.AGENTSVIEW_ACCESS_TOKEN = 'private-control-token';
  process.env.CLAUDE_HOOK_SECRET = 'private-hook-secret';
  try {
    const environment = agentEnvironment({ AGENTSVIEW_EXTRA_SECRET: 'also-private', SAFE_VALUE: 'visible' });
    assert.equal(environment.AGENTSVIEW_ACCESS_TOKEN, undefined);
    assert.equal(environment.AGENTSVIEW_EXTRA_SECRET, undefined);
    assert.equal(environment.CLAUDE_HOOK_SECRET, undefined);
    assert.equal(environment.SAFE_VALUE, 'visible');
  } finally {
    if (previousToken == null) delete process.env.AGENTSVIEW_ACCESS_TOKEN;
    else process.env.AGENTSVIEW_ACCESS_TOKEN = previousToken;
    if (previousHookSecret == null) delete process.env.CLAUDE_HOOK_SECRET;
    else process.env.CLAUDE_HOOK_SECRET = previousHookSecret;
  }
});

test('treats command, file and permission requests as at least medium risk', () => {
  for (const kind of ['command', 'file-change', 'permissions']) {
    assert.notEqual(assessRisk(kind, { command: 'npm test' }), 'low');
  }
  assert.equal(assessRisk('command', { command: 'sudo rm -rf /tmp/example' }), 'high');
});
