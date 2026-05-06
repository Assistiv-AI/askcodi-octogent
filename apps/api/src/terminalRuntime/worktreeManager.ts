import { existsSync } from "node:fs";
import { join } from "node:path";

import { listTentacleWorktreesOnDisk } from "../deck/tentacleWorktreesOnDisk";
import type { WorkspaceRepos } from "../workspace/repos";
import {
  TENTACLES_RELATIVE_PATH,
  TENTACLE_INTEGRATION_WORKTREES_SUBDIR,
  TENTACLE_WORKTREE_RELATIVE_PATH,
  tentacleBranchName,
} from "./constants";
import { toErrorMessage } from "./systemClients";
import type { GitClient, PersistedTerminal } from "./types";
import { NoReposRegisteredError, RuntimeInputError } from "./types";

// `workspaceCwd` locates `.octogent/worktrees/`; `workspaceRepos` resolves
// which repo's working tree each git op should target.
type CreateWorktreeManagerOptions = {
  workspaceCwd: string;
  workspaceRepos: WorkspaceRepos;
  gitClient: GitClient;
  terminals: Map<string, PersistedTerminal>;
};

type RemoveTentacleWorktreeOptions = {
  bestEffort?: boolean;
  repoName?: string;
};

type CreateTentacleWorktreeOptions = {
  baseRef?: string;
  repoName?: string;
  /** Override the branch name. Defaults to `octogent/<worktreeId>`. Used by
   * the swarm flow to anchor worker worktrees on `octogent/<tentacleId>/worker-<n>`. */
  branchName?: string;
  /** When non-empty, configure sparse-checkout on the freshly-created
   * worktree to limit on-disk files to these paths (octogent/<...>/cone). */
  sparsePaths?: ReadonlyArray<string>;
};

/** Validates a multi-segment repo-relative path for use with git sparse-checkout.
 * Rejects empty strings, absolute paths, traversal sequences, and leading `-`
 * (which git would interpret as a flag). Distinct from `assertSafePathSegment`
 * above, which validates a single dirname/filename segment. */
const isSafeRelativePath = (path: string): boolean => {
  if (path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (path.startsWith("-")) return false;
  if (path === "..") return false;
  if (path.startsWith("../")) return false;
  if (path.includes("/../") || path.endsWith("/..")) return false;
  return true;
};

type CreateTentacleIntegrationWorktreeOptions = {
  repoName?: string;
  baseRef?: string;
};

type RemoveTentacleIntegrationWorktreeOptions = {
  repoName?: string;
  bestEffort?: boolean;
};

export type TentacleIntegrationWorktreeEntry = {
  repoName: string;
  path: string;
};

const assertSafePathSegment = (label: string, value: string): void => {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new RuntimeInputError(`Invalid ${label}: ${value}`);
  }
};

/** Resolve the effective worktree identifier for a terminal. */
export const getEffectiveWorktreeId = (terminal: PersistedTerminal): string =>
  terminal.worktreeId ?? terminal.tentacleId;

/** Find any terminal whose effective worktree identifier matches. */
const findTerminalForWorktree = (
  terminals: Map<string, PersistedTerminal>,
  worktreeIdentifier: string,
): PersistedTerminal | undefined => {
  for (const terminal of terminals.values()) {
    if (getEffectiveWorktreeId(terminal) === worktreeIdentifier) {
      return terminal;
    }
  }
  return undefined;
};

export const createWorktreeManager = ({
  workspaceCwd,
  workspaceRepos,
  gitClient,
  terminals,
}: CreateWorktreeManagerOptions) => {
  const getTentacleWorktreePath = (tentacleId: string) =>
    join(workspaceCwd, TENTACLE_WORKTREE_RELATIVE_PATH, tentacleId);
  const getTentacleBranchName = tentacleBranchName;

  // Resolve the repo working tree root the git operation should target.
  //
  // - With `repoName`: returns that registered repo, or throws if unknown.
  // - Without `repoName`, exactly one repo registered: returns that repo.
  // - Without `repoName`, zero repos registered: falls back to `workspaceCwd`.
  //   This preserves legacy single-repo behavior where the workspace folder
  //   itself is the git repo. The actual `gitClient.isRepository` check
  //   downstream still gates whether worktree ops are allowed.
  // - Without `repoName`, multiple repos registered: throws (ambiguous).
  const resolveRepoCwd = (repoName?: string): string => {
    if (repoName === undefined && workspaceRepos.list().length === 0) {
      return workspaceCwd;
    }
    try {
      return workspaceRepos.gitRoot(repoName);
    } catch (error) {
      throw new RuntimeInputError(toErrorMessage(error));
    }
  };

  const getTentacleWorkspaceCwd = (worktreeIdentifier: string) => {
    const terminal = findTerminalForWorktree(terminals, worktreeIdentifier);
    if (!terminal) {
      throw new Error(`No terminal found for worktree: ${worktreeIdentifier}`);
    }

    if (terminal.workspaceMode === "worktree") {
      return getTentacleWorktreePath(worktreeIdentifier);
    }

    // Shared-mode terminals without a pinned repo live at the workspace root.
    // In multi-repo workspaces this lets the user `cd` between sibling repos
    // from a single shell instead of forcing a repo choice up front.
    if (terminal.worktreeRepoName === undefined) {
      return workspaceCwd;
    }

    return resolveRepoCwd(terminal.worktreeRepoName);
  };

  const assertWorktreeCreationSupported = (repoName?: string) => {
    gitClient.assertAvailable();
    const repoCwd = resolveRepoCwd(repoName);
    if (!gitClient.isRepository(repoCwd)) {
      throw new RuntimeInputError(
        "Worktree terminals require a git repository at the workspace root.",
      );
    }
  };

  const createTentacleWorktree = (
    tentacleId: string,
    options: CreateTentacleWorktreeOptions = {},
  ) => {
    const baseRef = options.baseRef ?? "HEAD";
    const branchName = options.branchName ?? getTentacleBranchName(tentacleId);

    assertWorktreeCreationSupported(options.repoName);
    const worktreePath = getTentacleWorktreePath(tentacleId);
    if (existsSync(worktreePath)) {
      throw new RuntimeInputError(`Worktree path already exists: ${worktreePath}`);
    }

    const repoCwd = resolveRepoCwd(options.repoName);
    try {
      gitClient.addWorktree({
        cwd: repoCwd,
        path: worktreePath,
        branchName,
        baseRef,
      });
    } catch (error) {
      throw new Error(`Unable to create worktree for ${tentacleId}: ${toErrorMessage(error)}`);
    }

    if (options.sparsePaths && options.sparsePaths.length > 0) {
      for (const path of options.sparsePaths) {
        if (!isSafeRelativePath(path)) {
          throw new RuntimeInputError(`Invalid sparse path: ${path}`);
        }
      }
      try {
        gitClient.setSparseCheckout({ cwd: worktreePath, paths: options.sparsePaths });
      } catch (error) {
        throw new Error(
          `Unable to apply sparse-checkout to ${worktreePath}: ${toErrorMessage(error)}`,
        );
      }
    }
  };

  const hasTentacleWorktree = (tentacleId: string): boolean =>
    existsSync(getTentacleWorktreePath(tentacleId));

  const removeTentacleWorktree = (
    tentacleId: string,
    options: RemoveTentacleWorktreeOptions = {},
  ) => {
    const { bestEffort = false, repoName } = options;
    const worktreePath = getTentacleWorktreePath(tentacleId);
    const branchName = getTentacleBranchName(tentacleId);
    const repoCwd = resolveRepoCwd(repoName);

    if (existsSync(worktreePath)) {
      try {
        gitClient.removeWorktree({
          cwd: repoCwd,
          path: worktreePath,
        });
      } catch (error) {
        if (bestEffort) {
          return;
        }
        throw new RuntimeInputError(
          `Unable to remove worktree for ${tentacleId}: ${toErrorMessage(error)}`,
        );
      }
    }

    try {
      gitClient.removeBranch({
        cwd: repoCwd,
        branchName,
      });
    } catch (error) {
      if (bestEffort) {
        return;
      }
      throw new RuntimeInputError(
        `Unable to remove branch for ${tentacleId}: ${toErrorMessage(error)}`,
      );
    }
  };

  // Tentacle-scoped worktrees live at:
  //   <workspaceCwd>/.octogent/tentacles/<tentacleId>/worktrees/<repoName>/
  // on branch `octogent/<tentacleId>` per repo. Each repo has its own git
  // history, so the shared branch name does not collide across repos — it is
  // a convention, not a coordinated state.
  const getTentacleIntegrationWorktreesRoot = (tentacleId: string): string => {
    assertSafePathSegment("tentacleId", tentacleId);
    return join(
      workspaceCwd,
      TENTACLES_RELATIVE_PATH,
      tentacleId,
      TENTACLE_INTEGRATION_WORKTREES_SUBDIR,
    );
  };

  const getTentacleIntegrationWorktreePath = (tentacleId: string, repoName: string): string => {
    assertSafePathSegment("repoName", repoName);
    return join(getTentacleIntegrationWorktreesRoot(tentacleId), repoName);
  };

  const resolveIntegrationRepoName = (repoName?: string): string => {
    if (repoName !== undefined) return repoName;
    const repos = workspaceRepos.list();
    if (repos.length === 1 && repos[0]) return repos[0].name;
    if (repos.length === 0) {
      throw new NoReposRegisteredError(
        "No repos registered in this workspace; cannot create tentacle integration worktree.",
      );
    }
    throw new RuntimeInputError(
      `Workspace has ${repos.length} repos; integration worktree creation requires an explicit repoName.`,
    );
  };

  const createTentacleIntegrationWorktree = (
    tentacleId: string,
    options: CreateTentacleIntegrationWorktreeOptions = {},
  ) => {
    const resolvedRepoName = resolveIntegrationRepoName(options.repoName);
    const baseRef = options.baseRef ?? "HEAD";
    // Path helpers validate both tentacleId and repoName as path segments.
    const worktreePath = getTentacleIntegrationWorktreePath(tentacleId, resolvedRepoName);

    assertWorktreeCreationSupported(resolvedRepoName);
    if (existsSync(worktreePath)) {
      throw new RuntimeInputError(`Tentacle integration worktree already exists: ${worktreePath}`);
    }

    const repoCwd = resolveRepoCwd(resolvedRepoName);
    try {
      gitClient.addWorktree({
        cwd: repoCwd,
        path: worktreePath,
        branchName: getTentacleBranchName(tentacleId),
        baseRef,
      });
    } catch (error) {
      throw new RuntimeInputError(
        `Unable to create tentacle integration worktree for ${tentacleId} (${resolvedRepoName}): ${toErrorMessage(error)}`,
      );
    }

    return { repoName: resolvedRepoName, path: worktreePath };
  };

  const removeTentacleIntegrationWorktree = (
    tentacleId: string,
    options: RemoveTentacleIntegrationWorktreeOptions = {},
  ) => {
    const { bestEffort = false } = options;
    const resolvedRepoName = resolveIntegrationRepoName(options.repoName);
    const worktreePath = getTentacleIntegrationWorktreePath(tentacleId, resolvedRepoName);
    const branchName = getTentacleBranchName(tentacleId);
    const repoCwd = resolveRepoCwd(resolvedRepoName);

    if (existsSync(worktreePath)) {
      try {
        gitClient.removeWorktree({ cwd: repoCwd, path: worktreePath });
      } catch (error) {
        if (!bestEffort) {
          throw new RuntimeInputError(
            `Unable to remove tentacle integration worktree for ${tentacleId} (${resolvedRepoName}): ${toErrorMessage(error)}`,
          );
        }
      }
    }

    try {
      gitClient.removeBranch({ cwd: repoCwd, branchName });
    } catch (error) {
      if (!bestEffort) {
        throw new RuntimeInputError(
          `Unable to remove tentacle integration branch for ${tentacleId} (${resolvedRepoName}): ${toErrorMessage(error)}`,
        );
      }
    }
  };

  const listTentacleIntegrationWorktrees = (
    tentacleId: string,
  ): TentacleIntegrationWorktreeEntry[] => {
    assertSafePathSegment("tentacleId", tentacleId);
    return listTentacleWorktreesOnDisk(workspaceCwd, tentacleId);
  };

  return {
    getTentacleWorkspaceCwd,
    createTentacleWorktree,
    hasTentacleWorktree,
    removeTentacleWorktree,
    createTentacleIntegrationWorktree,
    removeTentacleIntegrationWorktree,
    listTentacleIntegrationWorktrees,
  };
};
