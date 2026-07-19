import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(projectRoot, '.env'));

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function boolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function adapterMode(name) {
  const value = (process.env[name] || 'auto').toLowerCase();
  return ['true', 'false', 'auto'].includes(value) ? value : 'auto';
}

const configuredDataDir = process.env.AGENTSVIEW_DATA_DIR || './data';

export const config = Object.freeze({
  version: '0.1.0',
  projectRoot,
  publicDir: path.join(projectRoot, 'public'),
  dataDir: path.resolve(projectRoot, configuredDataDir),
  host: process.env.AGENTSVIEW_HOST || '127.0.0.1',
  port: integer('AGENTSVIEW_PORT', 4173, 1, 65535),
  publicOrigins: (process.env.AGENTSVIEW_PUBLIC_ORIGIN || '').split(',').map((item) => item.trim()).filter(Boolean),
  trustProxy: boolean('AGENTSVIEW_TRUST_PROXY', false),
  demoMode: boolean('AGENTSVIEW_DEMO_MODE', true),
  accessToken: process.env.AGENTSVIEW_ACCESS_TOKEN || '',
  sessionTtlMs: integer('AGENTSVIEW_SESSION_TTL_HOURS', 24, 1, 24 * 30) * 60 * 60 * 1000,
  approvalTtlMs: integer('AGENTSVIEW_APPROVAL_TTL_MINUTES', 10, 1, 24 * 60) * 60 * 1000,
  codexMode: adapterMode('CODEX_ENABLED'),
  codexCommand: process.env.CODEX_COMMAND || 'codex',
  claudeMode: adapterMode('CLAUDE_ENABLED'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeHookSecret: process.env.CLAUDE_HOOK_SECRET || '',
  logLevel: process.env.AGENTSVIEW_LOG_LEVEL || 'info',
});
