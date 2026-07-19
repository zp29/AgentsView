import { appendFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { basenameOnly, boundedText, hashText, isoNow } from './utils.js';

const SECRET_KEY = /(token|secret|password|authorization|cookie|api.?key)/i;

function sanitize(value, key = '') {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return boundedText(value
      .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted-key]')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]')
      .replace(/\b(password|passwd|token|api[_-]?key|secret)(\s*[:=]\s*|\s+)[^\s&;,]+/gi, '$1$2[redacted]'), 300);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  }
  return value;
}

export class AuditLog {
  constructor(dataDir) {
    this.directory = path.join(dataDir, 'audit');
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => {});
  }

  write(action, fields = {}) {
    const entry = sanitize({
      at: isoNow(),
      action: boundedText(action, 80),
      ...fields,
      ...(fields.cwd ? { cwd: basenameOnly(fields.cwd) } : {}),
      ...(fields.summary ? { summaryHash: hashText(fields.summary), summary: boundedText(fields.summary, 120) } : {}),
    });
    const day = entry.at.slice(0, 10);
    const file = path.join(this.directory, `${day}.jsonl`);
    const operation = this.queue.then(async () => {
      await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
