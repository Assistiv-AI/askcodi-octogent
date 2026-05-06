import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLauncherProject,
  listLauncherProjects,
  openLauncherProject,
  removeLauncherProject,
} from "../src/launcher/launcherCore";
import {
  loadProjectsRegistry,
  registerProject,
  resolveGlobalProjectDir,
} from "../src/projectPersistence";
import { writeRuntimeMetadata } from "../src/runtimeMetadata";

let originalHome: string | undefined;
let homeRoot: string;
let workRoot: string;

beforeEach(() => {
  homeRoot = mkdtempSync(join(tmpdir(), "octogent-launcher-home-"));
  workRoot = mkdtempSync(join(tmpdir(), "octogent-launcher-work-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeRoot;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    process.env.HOME = undefined;
  }
  rmSync(homeRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

describe("createLauncherProject", () => {
  it("rejects empty paths", () => {
    expect(createLauncherProject({ path: "" })).toEqual({
      kind: "invalid-path",
      reason: "Path is required.",
    });
    expect(createLauncherProject({ path: "   " })).toEqual({
      kind: "invalid-path",
      reason: "Path is required.",
    });
  });

  it("rejects relative paths", () => {
    expect(createLauncherProject({ path: "./relative" })).toEqual({
      kind: "invalid-path",
      reason: "Path must be absolute.",
    });
  });

  it("returns missing-folder when the folder doesn't exist", () => {
    const ghost = join(workRoot, "does-not-exist");
    expect(createLauncherProject({ path: ghost })).toEqual({ kind: "missing-folder" });
  });

  it("scaffolds and registers an existing folder", () => {
    const projectPath = join(workRoot, "alpha");
    mkdirSync(projectPath, { recursive: true });

    const result = createLauncherProject({ path: projectPath, name: "Alpha Project" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.entry.path).toBe(projectPath);
    expect(result.entry.name).toBe("Alpha Project");
    expect(existsSync(join(projectPath, ".octogent", "project.json"))).toBe(true);
    expect(existsSync(join(projectPath, ".octogent", "tentacles"))).toBe(true);

    const registry = loadProjectsRegistry();
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]?.path).toBe(projectPath);
  });
});

describe("listLauncherProjects", () => {
  it("returns projects sorted by lastOpenedAt descending", () => {
    const a = join(workRoot, "a");
    const b = join(workRoot, "b");
    mkdirSync(a);
    mkdirSync(b);

    registerProject(a, "Older");
    // Force a different timestamp so ordering is deterministic
    const registry = loadProjectsRegistry();
    const olderEntry = registry.projects.find((p) => p.path === a);
    if (olderEntry) {
      olderEntry.lastOpenedAt = "2020-01-01T00:00:00.000Z";
    }
    writeFileSync(
      join(homeRoot, ".octogent", "projects.json"),
      `${JSON.stringify(registry, null, 2)}\n`,
    );

    registerProject(b, "Newer");

    const projects = listLauncherProjects();
    expect(projects.map((p) => p.name)).toEqual(["Newer", "Older"]);
    for (const p of projects) {
      expect(p.isRunning).toBe(false);
      expect(p.exists).toBe(true);
    }
  });

  it("flags missing folders with exists=false", () => {
    const projectPath = join(workRoot, "ghost");
    mkdirSync(projectPath);
    registerProject(projectPath, "Ghost");
    rmSync(projectPath, { recursive: true, force: true });

    const projects = listLauncherProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.exists).toBe(false);
  });

  it("marks projects as running when runtime metadata pid is alive", () => {
    const projectPath = join(workRoot, "runner");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "Runner");
    const stateDir = resolveGlobalProjectDir(entry.id);
    mkdirSync(join(stateDir, "state"), { recursive: true });
    writeRuntimeMetadata(stateDir, {
      apiBaseUrl: "http://127.0.0.1:9999",
      host: "127.0.0.1",
      port: 9999,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      workspaceCwd: projectPath,
    });

    const projects = listLauncherProjects();
    expect(projects[0]?.isRunning).toBe(true);
    expect(projects[0]?.apiBaseUrl).toBe("http://127.0.0.1:9999");
  });
});

describe("removeLauncherProject", () => {
  it("removes a registered project", () => {
    const projectPath = join(workRoot, "to-remove");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "To Remove");

    expect(removeLauncherProject(entry.id)).toEqual({ kind: "ok" });
    expect(loadProjectsRegistry().projects).toHaveLength(0);
  });

  it("returns not-found for unknown ids", () => {
    expect(removeLauncherProject("nope")).toEqual({ kind: "not-found" });
  });
});

describe("openLauncherProject", () => {
  it("returns not-found for unknown projects", async () => {
    const result = await openLauncherProject("missing");
    expect(result).toEqual({ kind: "not-found" });
  });

  it("returns missing-folder when path is gone", async () => {
    const projectPath = join(workRoot, "vanished");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "Vanished");
    rmSync(projectPath, { recursive: true, force: true });

    const result = await openLauncherProject(entry.id);
    expect(result).toEqual({ kind: "missing-folder" });
  });

  it("returns the existing apiBaseUrl when already running", async () => {
    const projectPath = join(workRoot, "live");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "Live");
    const stateDir = resolveGlobalProjectDir(entry.id);
    mkdirSync(join(stateDir, "state"), { recursive: true });
    writeRuntimeMetadata(stateDir, {
      apiBaseUrl: "http://127.0.0.1:8080",
      host: "127.0.0.1",
      port: 8080,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      workspaceCwd: projectPath,
    });

    const result = await openLauncherProject(entry.id);
    expect(result).toEqual({
      kind: "ok",
      apiBaseUrl: "http://127.0.0.1:8080",
      alreadyRunning: true,
    });
  });

  it("returns ok when spawn produces a runtime file", async () => {
    const projectPath = join(workRoot, "spawnable");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "Spawnable");
    const stateDir = resolveGlobalProjectDir(entry.id);

    const spawnImpl = vi.fn(() => {
      // Simulate the child writing runtime.json after a moment
      setTimeout(() => {
        mkdirSync(join(stateDir, "state"), { recursive: true });
        writeRuntimeMetadata(stateDir, {
          apiBaseUrl: "http://127.0.0.1:8181",
          host: "127.0.0.1",
          port: 8181,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          workspaceCwd: projectPath,
        });
      }, 5);
      return {
        unref: () => {},
        on: () => {},
      };
    });

    const result = await openLauncherProject(entry.id, {
      spawnImpl,
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });

    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: "ok",
      apiBaseUrl: "http://127.0.0.1:8181",
      alreadyRunning: false,
    });
  });

  it("returns timeout when runtime never appears", async () => {
    const projectPath = join(workRoot, "stuck");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "Stuck");

    const result = await openLauncherProject(entry.id, {
      spawnImpl: () => ({ unref: () => {}, on: () => {} }),
      pollIntervalMs: 5,
      timeoutMs: 25,
    });

    expect(result).toEqual({ kind: "timeout" });
  });

  it("returns spawn-failed when spawnImpl throws", async () => {
    const projectPath = join(workRoot, "boom");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "Boom");

    const result = await openLauncherProject(entry.id, {
      spawnImpl: () => {
        throw new Error("ENOENT: octogent");
      },
      pollIntervalMs: 5,
      timeoutMs: 25,
    });

    expect(result).toEqual({ kind: "spawn-failed", reason: "ENOENT: octogent" });
  });
});
