import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GitClient, PersistedTerminal } from "../src/terminalRuntime/types";
import { createWorktreeManager } from "../src/terminalRuntime/worktreeManager";
import { createWorkspaceRepos } from "../src/workspace/repos";

const initRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  execSync("git init -q -b main", { cwd: path });
  execSync(
    'git -c user.email=test@example.com -c user.name=Test commit -q --allow-empty -m "init"',
    { cwd: path },
  );
};

const stubGitClient: GitClient = {
  assertAvailable: () => {},
  isRepository: () => true,
  addWorktree: () => {},
  removeWorktree: () => {},
  removeBranch: () => {},
  readWorktreeStatus: () => ({
    branchName: "",
    upstreamBranchName: null,
    isDirty: false,
    aheadCount: 0,
    behindCount: 0,
    insertedLineCount: 0,
    deletedLineCount: 0,
    hasConflicts: false,
    changedFiles: [],
    defaultBaseBranchName: "main",
  }),
  commitAll: () => {},
  pushCurrentBranch: () => {},
  syncWithBase: () => {},
  readCurrentBranchPullRequest: () => null,
  createPullRequest: () => null,
  mergeCurrentBranchPullRequest: () => {},
  setSparseCheckout: () => {},
};

const buildSharedTerminal = (
  terminalId: string,
  worktreeRepoName: string | undefined,
): PersistedTerminal => ({
  terminalId,
  tentacleId: terminalId,
  tentacleName: terminalId,
  workspaceMode: "shared",
  ...(worktreeRepoName ? { worktreeRepoName } : {}),
  createdAt: new Date().toISOString(),
});

describe("worktreeManager — shared-mode cwd resolution", () => {
  let workspaceCwd: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceCwd = mkdtempSync(join(tmpdir(), "shared-mode-cwd-"));
    stateDir = join(workspaceCwd, ".octogent");
  });

  afterEach(() => {
    rmSync(workspaceCwd, { recursive: true, force: true });
  });

  it("returns workspaceCwd for a shared terminal without a pinned repo, even when many repos are registered", () => {
    for (const name of ["one", "two", "three", "four", "five"]) {
      initRepo(join(workspaceCwd, name));
    }

    const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
    expect(workspaceRepos.list()).toHaveLength(5);

    const terminals = new Map<string, PersistedTerminal>();
    terminals.set("t-shared", buildSharedTerminal("t-shared", undefined));

    const manager = createWorktreeManager({
      workspaceCwd,
      workspaceRepos,
      gitClient: stubGitClient,
      terminals,
    });

    expect(manager.getTentacleWorkspaceCwd("t-shared")).toBe(workspaceCwd);
  });

  it("still resolves the registered repo when a shared terminal pins worktreeRepoName", () => {
    for (const name of ["alpha", "beta"]) {
      initRepo(join(workspaceCwd, name));
    }

    const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
    const terminals = new Map<string, PersistedTerminal>();
    terminals.set("t-pinned", buildSharedTerminal("t-pinned", "alpha"));

    const manager = createWorktreeManager({
      workspaceCwd,
      workspaceRepos,
      gitClient: stubGitClient,
      terminals,
    });

    expect(manager.getTentacleWorkspaceCwd("t-pinned")).toBe(join(workspaceCwd, "alpha"));
  });

  it("falls back to workspaceCwd in single-repo workspaces (legacy behavior)", () => {
    initRepo(workspaceCwd);

    const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
    expect(workspaceRepos.list()).toHaveLength(1);

    const terminals = new Map<string, PersistedTerminal>();
    terminals.set("t-legacy", buildSharedTerminal("t-legacy", undefined));

    const manager = createWorktreeManager({
      workspaceCwd,
      workspaceRepos,
      gitClient: stubGitClient,
      terminals,
    });

    // Single-repo: resolveRepoCwd returns the only repo's path which equals
    // workspaceCwd when the workspace folder itself is the repo.
    expect(manager.getTentacleWorkspaceCwd("t-legacy")).toBe(workspaceCwd);
  });
});
