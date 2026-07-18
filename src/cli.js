import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const [, , command, ...args] = process.argv;

function argument(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

async function accessToken() {
  if (config.accessToken) return config.accessToken;
  try {
    return (await readFile(path.join(config.dataDir, 'access-token'), 'utf8')).trim();
  } catch {
    throw new Error('No access token exists yet. Start AgentsView once first.');
  }
}

async function claudeHookSecret() {
  if (config.claudeHookSecret) return config.claudeHookSecret;
  try {
    return (await readFile(path.join(config.dataDir, 'claude-hook-secret'), 'utf8')).trim();
  } catch {
    throw new Error('No Claude Hook secret exists yet. Start AgentsView once first.');
  }
}

async function createTask() {
  const agent = argument('agent', 'demo');
  const title = argument('title', 'AgentsView task');
  const prompt = argument('prompt');
  const cwd = path.resolve(argument('cwd', process.cwd()));
  if (!prompt) throw new Error('Use --prompt "..." to provide the task request.');
  const baseUrl = argument('url', `http://${config.host}:${config.port}`);
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agent, title, prompt, cwd }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
  console.log(JSON.stringify(result, null, 2));
}

async function printHooks() {
  const hookSecret = await claudeHookSecret();
  const url = argument('url', `http://${config.host}:${config.port}/api/hooks/claude`);
  const hook = {
    type: 'http',
    url,
    headers: { 'X-AgentsView-Hook-Secret': hookSecret },
    // Deny at the AgentsView TTL before Claude Code closes the HTTP request.
    timeout: Math.ceil(config.approvalTtlMs / 1000) + 15,
  };
  const hooks = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd']) {
    hooks[event] = [{ matcher: '*', hooks: [hook] }];
  }
  console.log(JSON.stringify({ hooks }, null, 2));
}

try {
  if (command === 'token') console.log(await accessToken());
  else if (command === 'task') await createTask();
  else if (command === 'hooks-print') await printHooks();
  else {
    console.log([
      'AgentsView CLI',
      '  npm run token',
      '  npm run task -- --agent codex --title "Task" --cwd /absolute/project --prompt "Request"',
      '  npm run hooks:print',
    ].join('\n'));
  }
} catch (error) {
  console.error(`[AgentsView] ${error.message}`);
  process.exitCode = 1;
}
