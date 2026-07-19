#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';

const provider = process.argv[2];
if (!['claude', 'codex'].includes(provider)) {
  console.error('[AgentsView] Hook provider must be claude or codex.');
  process.exitCode = 2;
} else {
  try {
    const input = await readStdin();
    const secret = (await readFile(path.join(config.dataDir, 'claude-hook-secret'), 'utf8')).trim();
    const response = await fetch(`http://${config.host}:${config.port}/api/hooks/${provider}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentsview-hook-secret': secret,
      },
      body: input,
    });
    const output = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    process.stdout.write(output || '{}');
  } catch (error) {
    // A disconnected dashboard must never block the provider's native workflow.
    console.error(`[AgentsView] ${provider} hook unavailable: ${error.message}`);
    process.stdout.write('{}');
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8').trim();
  JSON.parse(body || '{}');
  return body || '{}';
}
