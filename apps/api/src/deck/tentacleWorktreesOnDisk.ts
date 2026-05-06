import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  TENTACLES_RELATIVE_PATH,
  TENTACLE_INTEGRATION_WORKTREES_SUBDIR,
} from "../terminalRuntime/constants";

export type TentacleWorktreeOnDisk = {
  repoName: string;
  path: string;
};

const getRoot = (workspaceCwd: string, tentacleId: string): string =>
  join(workspaceCwd, TENTACLES_RELATIVE_PATH, tentacleId, TENTACLE_INTEGRATION_WORKTREES_SUBDIR);

/**
 * Scan the on-disk tentacle integration worktrees for a tentacle. Returns one
 * entry per `<workspaceCwd>/.octogent/tentacles/<tentacleId>/worktrees/<repoName>/`
 * directory found, sorted by repoName.
 *
 * The filesystem is the source of truth for "which worktrees exist now"; deck
 * state is only the createdAt cache. This function is called by both the
 * worktreeManager runtime API and the deck summary loader so they share one
 * scan implementation.
 */
export const listTentacleWorktreesOnDisk = (
  workspaceCwd: string,
  tentacleId: string,
): TentacleWorktreeOnDisk[] => {
  const root = getRoot(workspaceCwd, tentacleId);
  if (!existsSync(root)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: TentacleWorktreeOnDisk[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    results.push({ repoName: entry.name, path: join(root, entry.name) });
  }
  results.sort((a, b) => a.repoName.localeCompare(b.repoName));
  return results;
};
