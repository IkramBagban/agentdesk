import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cache directory per SPEC: $AGENT_HISTORY_CACHE, else the platform default.
 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.AGENT_HISTORY_CACHE;
  if (override) return override;
  const home = homedir();
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agent-history');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'agent-history');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'agent-history');
}

export function defaultDbPath(): string {
  return join(cacheDir(), 'index.db');
}
