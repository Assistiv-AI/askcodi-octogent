import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  type ProjectRegistryEntry,
  ensureOctogentExcludedFromRepos,
  ensureOctogentGitignoreEntry,
  ensureProjectScaffold,
  loadProjectsRegistry,
  registerProject,
  resolveGlobalProjectDir,
  saveProjectsRegistry,
} from "../projectPersistence";
import { readRuntimeMetadata } from "../runtimeMetadata";
import { discoverRepos } from "../workspace/repos";

export type LauncherProjectEntry = ProjectRegistryEntry & {
  isRunning: boolean;
  apiBaseUrl: string | null;
  exists: boolean;
};

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const decorateEntry = (project: ProjectRegistryEntry): LauncherProjectEntry => {
  const projectStateDir = resolveGlobalProjectDir(project.id);
  const runtime = readRuntimeMetadata(projectStateDir);
  const isRunning = runtime !== null && pidIsAlive(runtime.pid);
  return {
    ...project,
    isRunning,
    apiBaseUrl: isRunning && runtime ? runtime.apiBaseUrl : null,
    exists: existsSync(project.path),
  };
};

const compareByLastOpened = (a: ProjectRegistryEntry, b: ProjectRegistryEntry) => {
  const aTime = new Date(a.lastOpenedAt ?? a.createdAt).getTime();
  const bTime = new Date(b.lastOpenedAt ?? b.createdAt).getTime();
  return bTime - aTime;
};

export const listLauncherProjects = (): LauncherProjectEntry[] => {
  return loadProjectsRegistry().projects.slice().sort(compareByLastOpened).map(decorateEntry);
};

export type CreateLauncherProjectInput = {
  path: string;
  name?: string | undefined;
};

export type CreateLauncherProjectResult =
  | { kind: "ok"; entry: ProjectRegistryEntry }
  | { kind: "invalid-path"; reason: string }
  | { kind: "missing-folder" };

export const createLauncherProject = (
  input: CreateLauncherProjectInput,
): CreateLauncherProjectResult => {
  const trimmedPath = typeof input.path === "string" ? input.path.trim() : "";
  if (trimmedPath.length === 0) {
    return { kind: "invalid-path", reason: "Path is required." };
  }
  if (!isAbsolute(trimmedPath)) {
    return { kind: "invalid-path", reason: "Path must be absolute." };
  }
  const resolvedPath = resolve(trimmedPath);
  if (!existsSync(resolvedPath)) {
    return { kind: "missing-folder" };
  }

  const projectName = input.name?.trim();
  const projectConfig = ensureProjectScaffold(resolvedPath, projectName);
  ensureOctogentGitignoreEntry(resolvedPath);
  ensureOctogentExcludedFromRepos(discoverRepos(resolvedPath));
  const entry = registerProject(resolvedPath, projectConfig.displayName);
  return { kind: "ok", entry };
};

export type RemoveLauncherProjectResult = { kind: "ok" } | { kind: "not-found" };

export const removeLauncherProject = (projectId: string): RemoveLauncherProjectResult => {
  const registry = loadProjectsRegistry();
  const filtered = registry.projects.filter((entry) => entry.id !== projectId);
  if (filtered.length === registry.projects.length) {
    return { kind: "not-found" };
  }
  saveProjectsRegistry({ projects: filtered });
  return { kind: "ok" };
};

export type OpenLauncherProjectOptions = {
  spawnFile?: string | undefined;
  spawnArgs?: readonly string[] | undefined;
  spawnEnv?: NodeJS.ProcessEnv | undefined;
  spawnImpl?: (
    file: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => { unref(): void; on(event: "error", listener: (err: Error) => void): void } | undefined;
  pollIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
};

export type OpenLauncherProjectResult =
  | { kind: "ok"; apiBaseUrl: string; alreadyRunning: boolean }
  | { kind: "not-found" }
  | { kind: "missing-folder" }
  | { kind: "spawn-failed"; reason: string }
  | { kind: "timeout" };

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const openLauncherProject = async (
  projectId: string,
  options: OpenLauncherProjectOptions = {},
): Promise<OpenLauncherProjectResult> => {
  const registry = loadProjectsRegistry();
  const entry = registry.projects.find((p) => p.id === projectId);
  if (!entry) return { kind: "not-found" };
  if (!existsSync(entry.path)) return { kind: "missing-folder" };

  const projectStateDir = resolveGlobalProjectDir(entry.id);

  const existingRuntime = readRuntimeMetadata(projectStateDir);
  if (existingRuntime !== null && pidIsAlive(existingRuntime.pid)) {
    return { kind: "ok", apiBaseUrl: existingRuntime.apiBaseUrl, alreadyRunning: true };
  }

  const file = options.spawnFile ?? process.execPath;
  const fallbackArg = process.argv[1];
  const args = options.spawnArgs ?? (fallbackArg ? [fallbackArg] : []);

  const env: NodeJS.ProcessEnv = {
    ...(options.spawnEnv ?? process.env),
    OCTOGENT_NO_OPEN: "1",
  };
  const spawnOpts: SpawnOptions = {
    cwd: entry.path,
    detached: true,
    stdio: "ignore",
    env,
  };

  let spawnError: string | null = null;
  try {
    const spawnImpl = options.spawnImpl ?? spawn;
    const child = spawnImpl(file, args, spawnOpts);
    if (child) {
      child.on("error", (err: Error) => {
        spawnError = err instanceof Error ? err.message : String(err);
      });
      child.unref();
    }
  } catch (err) {
    return {
      kind: "spawn-failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const maxPollIntervalMs = pollIntervalMs * 8;
  const startedAt = now();
  let interval = pollIntervalMs;

  while (now() - startedAt < timeoutMs) {
    if (spawnError) return { kind: "spawn-failed", reason: spawnError };
    const runtime = readRuntimeMetadata(projectStateDir);
    if (runtime !== null && pidIsAlive(runtime.pid)) {
      return { kind: "ok", apiBaseUrl: runtime.apiBaseUrl, alreadyRunning: false };
    }
    await delay(interval);
    interval = Math.min(interval * 2, maxPollIntervalMs);
  }
  return { kind: "timeout" };
};
