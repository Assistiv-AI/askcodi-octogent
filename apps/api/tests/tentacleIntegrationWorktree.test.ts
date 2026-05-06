import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TENTACLES_RELATIVE_PATH } from "../src/terminalRuntime/constants";
import type { GitClient, PersistedTerminal } from "../src/terminalRuntime/types";
import { RuntimeInputError } from "../src/terminalRuntime/types";
import { createWorktreeManager } from "../src/terminalRuntime/worktreeManager";
import { createWorkspaceRepos } from "../src/workspace/repos";

const initRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  execSync("git init -q -b main", { cwd: path });
  // Need a commit so HEAD resolves.
  execSync(
    'git -c user.email=test@example.com -c user.name=Test commit -q --allow-empty -m "init"',
    {
      cwd: path,
    },
  );
};

type FakeGitClientState = {
  worktrees: Map<string, { cwd: string; branchName: string; baseRef: string }>;
  branches: Set<string>;
  failRemoveWorktree: boolean;
  failRemoveBranch: boolean;
  failOnExistingBranch: boolean;
};

const createFakeGitClient = (
  init: Partial<FakeGitClientState> = {},
): { client: GitClient; state: FakeGitClientState } => {
  const state: FakeGitClientState = {
    worktrees: new Map(),
    branches: new Set(),
    failRemoveWorktree: false,
    failRemoveBranch: false,
    failOnExistingBranch: false,
    ...init,
  };

  const client: GitClient = {
    assertAvailable: () => {},
    isRepository: () => true,
    addWorktree: ({ cwd, path, branchName, baseRef }) => {
      if (state.failOnExistingBranch && state.branches.has(branchName)) {
        throw new Error(`fatal: a branch named '${branchName}' already exists`);
      }
      if (state.worktrees.has(path)) {
        throw new Error(`Worktree already exists: ${path}`);
      }
      mkdirSync(path, { recursive: true });
      state.branches.add(branchName);
      state.worktrees.set(path, { cwd, branchName, baseRef });
    },
    removeWorktree: ({ path }) => {
      if (state.failRemoveWorktree) {
        throw new Error(`Unable to remove worktree: ${path}`);
      }
      state.worktrees.delete(path);
      rmSync(path, { recursive: true, force: true });
    },
    removeBranch: ({ branchName }) => {
      if (state.failRemoveBranch) {
        throw new Error(`Unable to remove branch: ${branchName}`);
      }
      state.branches.delete(branchName);
    },
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

  return { client, state };
};

describe("worktreeManager — tentacle integration worktrees", () => {
  let workspaceCwd: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceCwd = mkdtempSync(join(tmpdir(), "tentacle-integration-"));
    stateDir = join(workspaceCwd, ".octogent");
  });

  afterEach(() => {
    rmSync(workspaceCwd, { recursive: true, force: true });
  });

  describe("createTentacleIntegrationWorktree", () => {
    it("creates a worktree at .octogent/tentacles/<id>/worktrees/<repo>/ on the tentacle branch", () => {
      initRepo(workspaceCwd);
      const { client, state } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      const result = manager.createTentacleIntegrationWorktree("t1");

      // Single-repo workspace: name defaults to basename of workspace dir.
      const repos = workspaceRepos.list();
      expect(repos).toHaveLength(1);
      const repoName = repos[0]?.name as string;
      const expectedPath = join(workspaceCwd, TENTACLES_RELATIVE_PATH, "t1", "worktrees", repoName);
      expect(result.path).toBe(expectedPath);
      expect(result.repoName).toBe(repoName);
      expect(state.branches.has("octogent/t1")).toBe(true);
      expect(state.worktrees.has(expectedPath)).toBe(true);
    });

    it("targets the requested repo when multiple repos are registered", () => {
      initRepo(join(workspaceCwd, "frontend"));
      initRepo(join(workspaceCwd, "backend"));
      const { client, state } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      const result = manager.createTentacleIntegrationWorktree("t1", { repoName: "backend" });

      expect(result.repoName).toBe("backend");
      const recorded = state.worktrees.get(result.path);
      expect(recorded?.cwd).toBe(join(workspaceCwd, "backend"));
    });

    it("uses the provided baseRef when given", () => {
      initRepo(workspaceCwd);
      const { client, state } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      const result = manager.createTentacleIntegrationWorktree("t1", { baseRef: "main" });

      expect(state.worktrees.get(result.path)?.baseRef).toBe("main");
    });

    it("throws RuntimeInputError when the worktree path already exists", () => {
      initRepo(workspaceCwd);
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      manager.createTentacleIntegrationWorktree("t1");

      expect(() => manager.createTentacleIntegrationWorktree("t1")).toThrow(RuntimeInputError);
    });

    it("throws RuntimeInputError when the requested repo is unknown", () => {
      initRepo(join(workspaceCwd, "frontend"));
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      expect(() => manager.createTentacleIntegrationWorktree("t1", { repoName: "ghost" })).toThrow(
        RuntimeInputError,
      );
    });

    it("throws RuntimeInputError when no repo name is given and multiple are registered", () => {
      initRepo(join(workspaceCwd, "frontend"));
      initRepo(join(workspaceCwd, "backend"));
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      expect(() => manager.createTentacleIntegrationWorktree("t1")).toThrow(RuntimeInputError);
    });

    it("surfaces a RuntimeInputError when the branch already exists in git", () => {
      initRepo(workspaceCwd);
      const { client, state } = createFakeGitClient({ failOnExistingBranch: true });
      state.branches.add("octogent/t1");
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      expect(() => manager.createTentacleIntegrationWorktree("t1")).toThrow(RuntimeInputError);
    });

    it("rejects path traversal in tentacleId", () => {
      initRepo(workspaceCwd);
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      expect(() => manager.createTentacleIntegrationWorktree("../escape")).toThrow(
        RuntimeInputError,
      );
      expect(() => manager.createTentacleIntegrationWorktree("a/b")).toThrow(RuntimeInputError);
    });

    it("rejects path traversal in repoName", () => {
      initRepo(join(workspaceCwd, "frontend"));
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      expect(() =>
        manager.createTentacleIntegrationWorktree("t1", { repoName: "../escape" }),
      ).toThrow(RuntimeInputError);
    });
  });

  describe("removeTentacleIntegrationWorktree", () => {
    it("removes both the worktree directory and its branch", () => {
      initRepo(workspaceCwd);
      const { client, state } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      const created = manager.createTentacleIntegrationWorktree("t1");
      manager.removeTentacleIntegrationWorktree("t1");

      expect(state.worktrees.has(created.path)).toBe(false);
      expect(state.branches.has("octogent/t1")).toBe(false);
      expect(existsSync(created.path)).toBe(false);
    });

    it("tolerates a failing git removeWorktree when bestEffort is true", () => {
      initRepo(workspaceCwd);
      const { client, state } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      manager.createTentacleIntegrationWorktree("t1");
      state.failRemoveWorktree = true;

      expect(() =>
        manager.removeTentacleIntegrationWorktree("t1", { bestEffort: true }),
      ).not.toThrow();
    });

    it("throws when the worktree removal fails and bestEffort is false", () => {
      initRepo(workspaceCwd);
      const { client, state } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      manager.createTentacleIntegrationWorktree("t1");
      state.failRemoveWorktree = true;

      expect(() => manager.removeTentacleIntegrationWorktree("t1")).toThrow(RuntimeInputError);
    });

    it("is a no-op when the worktree path does not exist", () => {
      initRepo(workspaceCwd);
      const { client, state } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      // Branch is removed even when no worktree dir exists, matching legacy semantics.
      expect(() => manager.removeTentacleIntegrationWorktree("never-created")).not.toThrow();
      expect(state.branches.has("octogent/never-created")).toBe(false);
    });
  });

  describe("listTentacleIntegrationWorktrees", () => {
    it("returns an empty list when the tentacle has no worktrees subdir", () => {
      initRepo(workspaceCwd);
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      mkdirSync(join(workspaceCwd, TENTACLES_RELATIVE_PATH, "t1"), { recursive: true });
      writeFileSync(join(workspaceCwd, TENTACLES_RELATIVE_PATH, "t1", "CONTEXT.md"), "# t1\n");

      expect(manager.listTentacleIntegrationWorktrees("t1")).toEqual([]);
    });

    it("returns an empty list when the tentacle directory does not exist", () => {
      initRepo(workspaceCwd);
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      expect(manager.listTentacleIntegrationWorktrees("ghost")).toEqual([]);
    });

    it("returns one entry per repo with sorted output", () => {
      initRepo(join(workspaceCwd, "frontend"));
      initRepo(join(workspaceCwd, "backend"));
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      manager.createTentacleIntegrationWorktree("t1", { repoName: "frontend" });
      manager.createTentacleIntegrationWorktree("t1", { repoName: "backend" });

      const entries = manager.listTentacleIntegrationWorktrees("t1");
      expect(entries.map((e) => e.repoName)).toEqual(["backend", "frontend"]);
      expect(entries[0]?.path).toBe(
        join(workspaceCwd, TENTACLES_RELATIVE_PATH, "t1", "worktrees", "backend"),
      );
    });

    it("rejects path traversal in tentacleId", () => {
      initRepo(workspaceCwd);
      const { client } = createFakeGitClient();
      const workspaceRepos = createWorkspaceRepos(stateDir, workspaceCwd);
      const manager = createWorktreeManager({
        workspaceCwd,
        workspaceRepos,
        gitClient: client,
        terminals: new Map<string, PersistedTerminal>(),
      });

      expect(() => manager.listTentacleIntegrationWorktrees("../escape")).toThrow(
        RuntimeInputError,
      );
    });
  });
});
