import crypto from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function persistentSecret(dataDir, filename, configuredValue = '') {
  if (configuredValue) return configuredValue;
  const file = path.join(dataDir, filename);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) {
      await chmod(file, 0o600).catch(() => {});
      return existing;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  await writeFile(file, `${secret}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return secret;
}
