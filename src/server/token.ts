import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOKEN_FILE = 'token';
const VALID = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * The access token is kept in `<cacheDir>/token` (mode 0600) so a browser that
 * already holds the cookie keeps working across restarts. A missing or
 * malformed file, or `reset`, generates a new random 32-byte token.
 */
export function loadOrCreateToken(cacheDir: string, reset = false): string {
  const path = join(cacheDir, TOKEN_FILE);
  if (!reset) {
    try {
      const t = readFileSync(path, 'utf8').trim();
      if (VALID.test(t)) {
        chmodSync(path, 0o600); // tighten if someone loosened it
        return t;
      }
    } catch {
      /* missing / unreadable: create below */
    }
  }
  const token = randomBytes(32).toString('base64url');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, token + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return token;
}
