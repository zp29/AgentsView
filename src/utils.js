import crypto from 'node:crypto';
import path from 'node:path';

export const TASK_STATUSES = new Set(['running', 'waiting_approval', 'completed']);
export const APPROVAL_STATES = new Set(['pending', 'submitting', 'approved', 'denied', 'expired', 'cancelled']);
export const DECISIONS = new Set(['allow', 'deny']);

export function isoNow() {
  return new Date().toISOString();
}

export function boundedText(value, maximum = 320, fallback = '') {
  if (value == null) return fallback;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum);
}

export function basenameOnly(value) {
  if (!value || typeof value !== 'string') return '';
  return path.basename(value);
}

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

export function hashText(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 20);
}

export function readJsonBody(request, maximumBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413, code: 'body_too_large' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400, code: 'invalid_json' }));
      }
    });
    request.on('error', reject);
  });
}

export function json(response, statusCode, payload, extraHeaders = {}) {
  const body = payload == null ? '' : JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

export function errorJson(response, statusCode, code, message) {
  json(response, statusCode, { error: { code, message } });
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}

export function commandSummary(toolName, input) {
  if (!input || typeof input !== 'object') return boundedText(toolName, 120, 'Tool request');
  const candidate = input.command ?? input.path ?? input.file_path ?? input.query ?? input.description;
  return boundedText(candidate || `${toolName} request`, 420);
}

export function assessRisk(toolName, input) {
  const name = String(toolName || '').toLowerCase();
  const detail = commandSummary(toolName, input).toLowerCase();
  if (/\b(sudo|rm\s+-rf|mkfs|dd\s+if=|chmod\s+777|git\s+push\s+.*--force|production|prod\b|secret|token|credential)\b/.test(detail)) return 'high';
  if (['bash', 'command', 'exec', 'write', 'edit', 'file-change', 'file_change', 'permission', 'notebookedit', 'exitplanmode'].some((item) => name.includes(item))) return 'medium';
  return 'low';
}

export function agentEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('AGENTSVIEW_') || key === 'CLAUDE_HOOK_SECRET') delete environment[key];
  }
  return environment;
}
