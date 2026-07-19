#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relay = path.join(root, 'scripts', 'agent-hook.js');
const selected = process.argv.includes('--claude') ? ['claude']
  : process.argv.includes('--codex') ? ['codex']
    : ['claude', 'codex'];
const timeout = Math.ceil(config.approvalTtlMs / 1000) + 15;
const events = {
  claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd'],
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop'],
};

for (const provider of selected) {
  const target = provider === 'claude'
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(os.homedir(), '.codex', 'hooks.json');
  const command = `${shellQuote(process.execPath)} ${shellQuote(relay)} ${provider}`;
  const current = await readObject(target);
  const next = structuredClone(current);
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};

  for (const event of events[provider]) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    next.hooks[event] = removeAgentsView(groups, provider);
    next.hooks[event].push({
      matcher: '',
      hooks: [{ type: 'command', command, timeout }],
    });
  }
  for (const [event, groups] of Object.entries(next.hooks)) {
    next.hooks[event] = removeAgentsView(Array.isArray(groups) ? groups : [], provider);
    if (events[provider].includes(event)) {
      next.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command, timeout }] });
    }
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }

  await atomicInstall(target, current, next);
  console.log(`[AgentsView] ${provider} hooks installed: ${events[provider].length} events in ${target}`);
}

if (selected.includes('codex')) {
  console.log('[AgentsView] Codex security: open /hooks once in a new Codex CLI session and trust the AgentsView user hook.');
}

function removeAgentsView(groups, provider) {
  return groups.map((group) => ({
    ...group,
    hooks: (Array.isArray(group.hooks) ? group.hooks : []).filter((hook) => {
      const command = String(hook?.command || '');
      return !(command.includes(relay) && command.trim().endsWith(provider));
    }),
  })).filter((group) => group.hooks.length > 0);
}

async function readObject(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

async function atomicInstall(file, current, next) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await copyFile(file, `${file}.agentsview-backup-${stamp}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => {});
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
