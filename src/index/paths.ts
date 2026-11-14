import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cache directory per SPEC: $AGENTDESK_CACHE, else the platform default.
 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.AGENTDESK_CACHE;
  if (override) return override;
  const home = homedir();
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agentdesk');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'agentdesk');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'agentdesk');
}

export function defaultDbPath(): string {
  return join(cacheDir(), 'index.db');
}
