import { existsSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceRepos } from "../workspace/repos";
import { TENTACLE_WORKTREE_BRANCH_PREFIX, TENTACLE_WORKTREE_RELATIVE_PATH } from "./constants";
import { toErrorMessage } from "./systemClients";
import type { GitClient, PersistedTerminal } from "./types";
import { RuntimeInputError } from "./types";

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
};

/** Resolve the effective worktree identifier for a terminal. */
const getEffectiveWorktreeId = (terminal: PersistedTerminal): string =>
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
  const getTentacleBranchName = (tentacleId: string) =>
    `${TENTACLE_WORKTREE_BRANCH_PREFIX}${tentacleId}`;

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
        branchName: `${TENTACLE_WORKTREE_BRANCH_PREFIX}${tentacleId}`,
        baseRef,
      });
    } catch (error) {
      throw new Error(`Unable to create worktree for ${tentacleId}: ${toErrorMessage(error)}`);
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

  return {
    getTentacleWorkspaceCwd,
    createTentacleWorktree,
    hasTentacleWorktree,
    removeTentacleWorktree,
  };
};
