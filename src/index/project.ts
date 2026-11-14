import { normalize } from 'node:path';

export const NO_FOLDER_KEY = 'nofolder:';

/**
 * Agent-agnostic project key: sessions from any source that ran in the same
 * directory share a project. Claude desktop "no folder" chats run in throwaway
 * dirs under .../Claude/scratch-workspaces/ and are grouped as one project.
 * Without a known path, the adapter's own key is kept.
 */
export function projectKeyFor(projectPath: string | undefined, fallback: string): string {
  if (!projectPath) return fallback;
  if (/[\\/]Claude[\\/]scratch-workspaces[\\/]/.test(projectPath)) return NO_FOLDER_KEY;
  // Windows paths are case-insensitive: treat c:\ and C:\ as the same drive.
  const p = normalize(projectPath).replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
  return `path:${p.length > 1 ? p.replace(/[\\/]+$/, '') : p}`;
}
