import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceRepos,
  discoverRepos,
  loadRepoRegistry,
  reconcileRepoRegistry,
  saveRepoRegistry,
} from "../src/workspace/repos";

const initRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  execSync("git init -q", { cwd: path });
};

describe("discoverRepos", () => {
  let workspaceCwd: string;

  beforeEach(() => {
    workspaceCwd = mkdtempSync(join(tmpdir(), "ws-repos-"));
  });

  afterEach(() => {
    rmSync(workspaceCwd, { recursive: true, force: true });
  });

  it("returns one repo when the workspace folder is itself a git repo", () => {
    initRepo(workspaceCwd);

    const repos = discoverRepos(workspaceCwd);

    expect(repos).toHaveLength(1);
    expect(repos[0]?.path).toBe(workspaceCwd);
  });

  it("returns one entry per top-level child repo when the workspace folder is a parent", () => {
    initRepo(join(workspaceCwd, "frontend"));
    initRepo(join(workspaceCwd, "backend"));
    mkdirSync(join(workspaceCwd, "docs"));

    const repos = discoverRepos(workspaceCwd);

    expect(repos.map((r) => r.name).sort()).toEqual(["backend", "frontend"]);
    expect(repos.find((r) => r.name === "frontend")?.path).toBe(join(workspaceCwd, "frontend"));
    expect(repos.find((r) => r.name === "backend")?.path).toBe(join(workspaceCwd, "backend"));
  });

  it("returns an empty list when the workspace has no git repos", () => {
    mkdirSync(join(workspaceCwd, "notes"));
    writeFileSync(join(workspaceCwd, "README.md"), "hi");

    const repos = discoverRepos(workspaceCwd);

    expect(repos).toEqual([]);
  });

  it("does not descend more than one level", () => {
    initRepo(join(workspaceCwd, "outer", "inner"));

    const repos = discoverRepos(workspaceCwd);

    expect(repos).toEqual([]);
  });

  it("ignores symlinked directories so a loop cannot hang the walk", () => {
    initRepo(join(workspaceCwd, "real"));
    symlinkSync(workspaceCwd, join(workspaceCwd, "loop"));

    const repos = discoverRepos(workspaceCwd);

    expect(repos.map((r) => r.name)).toEqual(["real"]);
  });

  it("ignores hidden top-level directories", () => {
    initRepo(join(workspaceCwd, ".hidden-repo"));
    initRepo(join(workspaceCwd, "visible"));

    const repos = discoverRepos(workspaceCwd);

    expect(repos.map((r) => r.name)).toEqual(["visible"]);
  });
});

describe("loadRepoRegistry / saveRepoRegistry", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ws-state-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns null when no registry file exists", () => {
    expect(loadRepoRegistry(stateDir)).toBeNull();
  });

  it("round-trips a registry through save and load", () => {
    const repos = [
      { name: "frontend", path: "/tmp/frontend" },
      { name: "backend", path: "/tmp/backend" },
    ];
    saveRepoRegistry(stateDir, repos);

    expect(loadRepoRegistry(stateDir)).toEqual(repos);
  });

  it("returns null when the registry file is not valid JSON", () => {
    writeFileSync(join(stateDir, "repos.json"), "not json", "utf-8");

    expect(loadRepoRegistry(stateDir)).toBeNull();
  });

  it("creates the state directory on save if it is missing", () => {
    const nested = join(stateDir, "deep", "nested");
    saveRepoRegistry(nested, [{ name: "x", path: "/tmp/x" }]);

    expect(loadRepoRegistry(nested)).toEqual([{ name: "x", path: "/tmp/x" }]);
  });
});

describe("reconcileRepoRegistry", () => {
  let workspaceCwd: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceCwd = mkdtempSync(join(tmpdir(), "ws-recon-"));
    stateDir = mkdtempSync(join(tmpdir(), "ws-recon-state-"));
  });

  afterEach(() => {
    rmSync(workspaceCwd, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists newly discovered repos on first run", () => {
    initRepo(join(workspaceCwd, "api"));

    const repos = reconcileRepoRegistry(stateDir, workspaceCwd);

    expect(repos.map((r) => r.name)).toEqual(["api"]);
    expect(loadRepoRegistry(stateDir)).toEqual(repos);
  });

  it("preserves user-renamed repos across reconciles", () => {
    initRepo(join(workspaceCwd, "api"));
    saveRepoRegistry(stateDir, [{ name: "renamed-api", path: join(workspaceCwd, "api") }]);

    const repos = reconcileRepoRegistry(stateDir, workspaceCwd);

    expect(repos).toEqual([{ name: "renamed-api", path: join(workspaceCwd, "api") }]);
  });

  it("drops repos that disappeared from disk", () => {
    saveRepoRegistry(stateDir, [{ name: "ghost", path: join(workspaceCwd, "ghost") }]);

    const repos = reconcileRepoRegistry(stateDir, workspaceCwd);

    expect(repos).toEqual([]);
  });

  it("appends newly added repos while keeping existing ones", () => {
    initRepo(join(workspaceCwd, "old"));
    saveRepoRegistry(stateDir, [{ name: "old-keep", path: join(workspaceCwd, "old") }]);

    initRepo(join(workspaceCwd, "new"));
    const repos = reconcileRepoRegistry(stateDir, workspaceCwd);

    expect(repos.map((r) => r.name).sort()).toEqual(["new", "old-keep"]);
  });

  it("does not write a registry file for an empty workspace with no prior registry", () => {
    // mkdtempSync gives us a non-git, no-children dir.
    reconcileRepoRegistry(stateDir, workspaceCwd);

    // The registry file must not have been created. Brand-new workspaces
    // should stay clean on disk until the user actually has repos to track.
    expect(loadRepoRegistry(stateDir)).toBeNull();
  });

  it("updates an existing registry file even when it becomes empty", () => {
    saveRepoRegistry(stateDir, [{ name: "ghost", path: join(workspaceCwd, "ghost") }]);

    const repos = reconcileRepoRegistry(stateDir, workspaceCwd);

    expect(repos).toEqual([]);
    // The pre-existing file is rewritten to reflect the empty state.
    expect(loadRepoRegistry(stateDir)).toEqual([]);
  });
});

describe("createWorkspaceRepos adapter", () => {
  let workspaceCwd: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceCwd = mkdtempSync(join(tmpdir(), "ws-adapter-"));
    stateDir = mkdtempSync(join(tmpdir(), "ws-adapter-state-"));
  });

  afterEach(() => {
    rmSync(workspaceCwd, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("list and getByName reflect the discovered registry", () => {
    initRepo(join(workspaceCwd, "alpha"));
    initRepo(join(workspaceCwd, "beta"));

    const adapter = createWorkspaceRepos(stateDir, workspaceCwd);

    expect(
      adapter
        .list()
        .map((r) => r.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(adapter.getByName("alpha")?.path).toBe(join(workspaceCwd, "alpha"));
    expect(adapter.getByName("missing")).toBeUndefined();
  });

  it("findByPath matches both exact roots and paths inside a repo", () => {
    initRepo(join(workspaceCwd, "alpha"));
    const adapter = createWorkspaceRepos(stateDir, workspaceCwd);

    expect(adapter.findByPath(join(workspaceCwd, "alpha"))?.name).toBe("alpha");
    expect(adapter.findByPath(join(workspaceCwd, "alpha", "src", "x.ts"))?.name).toBe("alpha");
    expect(adapter.findByPath(join(workspaceCwd, "elsewhere"))).toBeUndefined();
  });

  it("gitRoot() with no argument returns the only repo when there is one", () => {
    initRepo(join(workspaceCwd, "solo"));
    const adapter = createWorkspaceRepos(stateDir, workspaceCwd);

    expect(adapter.gitRoot()).toBe(join(workspaceCwd, "solo"));
  });

  it("gitRoot() with no argument throws when there are zero repos", () => {
    const adapter = createWorkspaceRepos(stateDir, workspaceCwd);

    expect(() => adapter.gitRoot()).toThrow(/No repos registered/);
  });

  it("gitRoot() with no argument throws when there are multiple repos", () => {
    initRepo(join(workspaceCwd, "alpha"));
    initRepo(join(workspaceCwd, "beta"));
    const adapter = createWorkspaceRepos(stateDir, workspaceCwd);

    expect(() => adapter.gitRoot()).toThrow(/explicit repo name/);
  });

  it("gitRoot('name') returns the repo's path or throws on unknown name", () => {
    initRepo(join(workspaceCwd, "alpha"));
    const adapter = createWorkspaceRepos(stateDir, workspaceCwd);

    expect(adapter.gitRoot("alpha")).toBe(join(workspaceCwd, "alpha"));
    expect(() => adapter.gitRoot("ghost")).toThrow(/No repo registered with name 'ghost'/);
  });

  it("refresh picks up repos added after construction", () => {
    initRepo(join(workspaceCwd, "alpha"));
    const adapter = createWorkspaceRepos(stateDir, workspaceCwd);
    expect(adapter.list().map((r) => r.name)).toEqual(["alpha"]);

    initRepo(join(workspaceCwd, "beta"));
    const refreshed = adapter.refresh();

    expect(refreshed.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });
});
