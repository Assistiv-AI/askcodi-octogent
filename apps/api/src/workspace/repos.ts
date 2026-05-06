import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

// A repo registered in the workspace. `name` is the user-facing identifier
// (defaults to the directory basename) and `path` is the absolute path to the
// repo's working tree root.
export type WorkspaceRepo = {
  name: string;
  path: string;
};

// Persisted registry shape. Lives at `<projectStateDir>/repos.json`.
type WorkspaceReposFile = {
  repos: WorkspaceRepo[];
};

const REPOS_REGISTRY_FILE = "repos.json";

const isGitWorkingTreeRoot = (path: string): boolean => {
  // A git working tree root has either a `.git` directory (normal repo) or a
  // `.git` file (worktree pointing at a parent repo). Both count.
  const dotGit = join(path, ".git");
  if (!existsSync(dotGit)) return false;
  try {
    const stat = lstatSync(dotGit);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
};

// Walk one level deep under `workspaceCwd` to find candidate repos. Symlinks
// and entries that fail to stat are skipped, so a misbehaving entry in the
// workspace folder cannot crash discovery.
const collectCandidates = (workspaceCwd: string): string[] => {
  const candidates: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(workspaceCwd);
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const child = join(workspaceCwd, entry);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(child);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;
    candidates.push(child);
  }

  return candidates;
};

/**
 * Discover repos under a workspace folder.
 *
 * Two cases:
 * - The workspace folder is itself a git repo: return a single repo entry
 *   for it. The name defaults to the folder's basename.
 * - The workspace folder is a parent of repos: return one entry per top-level
 *   child directory that is a git working tree root.
 *
 * Discovery is bounded to one level deep. Symlinks are refused so a loop in
 * the workspace cannot hang the walk. Hidden directories are skipped.
 */
export const discoverRepos = (workspaceCwd: string): WorkspaceRepo[] => {
  const absolute = resolve(workspaceCwd);

  if (isGitWorkingTreeRoot(absolute)) {
    return [{ name: basename(absolute) || "workspace", path: absolute }];
  }

  // Bounded to one level deep on purpose: deeply nested repos are not part of
  // the multi-repo workspace contract; users register them explicitly later.
  const candidates = collectCandidates(absolute);
  const repos: WorkspaceRepo[] = [];

  for (const candidate of candidates) {
    if (!isGitWorkingTreeRoot(candidate)) continue;
    repos.push({ name: basename(candidate), path: candidate });
  }

  // Stable order so callers (and persisted registries) do not see churn.
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
};

const reposRegistryPath = (projectStateDir: string): string =>
  join(projectStateDir, REPOS_REGISTRY_FILE);

const isWorkspaceRepo = (value: unknown): value is WorkspaceRepo => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.path === "string";
};

/** Read the persisted registry. Returns `null` if it does not exist or is unreadable. */
export const loadRepoRegistry = (projectStateDir: string): WorkspaceRepo[] | null => {
  let raw: string;
  try {
    raw = readFileSync(reposRegistryPath(projectStateDir), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const file = parsed as Partial<WorkspaceReposFile>;
  if (!Array.isArray(file.repos)) return null;
  return file.repos.filter(isWorkspaceRepo);
};

/** Persist the registry. Creates the project state directory if missing. */
export const saveRepoRegistry = (projectStateDir: string, repos: WorkspaceRepo[]): void => {
  if (!existsSync(projectStateDir)) {
    mkdirSync(projectStateDir, { recursive: true });
  }
  const file: WorkspaceReposFile = { repos };
  writeFileSync(reposRegistryPath(projectStateDir), JSON.stringify(file, null, 2), "utf-8");
};

const reposEqual = (a: readonly WorkspaceRepo[], b: readonly WorkspaceRepo[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.name !== right.name || left.path !== right.path) return false;
  }
  return true;
};

/**
 * Reconcile the persisted registry against fresh discovery.
 *
 * Strategy:
 * - Repos whose `path` still exists and is still a git root are kept with
 *   their persisted name (so user-renamed repos survive).
 * - Repos that disappeared on disk are dropped.
 * - Newly discovered repos are appended with their default name.
 *
 * The result is sorted alphabetically by name for stable output.
 *
 * Persistence is lazy: the registry file is written only when there are repos
 * to record, or when an existing registry file is being updated. A workspace
 * with zero discovered repos and no prior registry will not create a file,
 * so brand-new uninitialized workspaces stay clean on disk.
 */
export const reconcileRepoRegistry = (
  projectStateDir: string,
  workspaceCwd: string,
): WorkspaceRepo[] => {
  const discovered = discoverRepos(workspaceCwd);
  const persisted = loadRepoRegistry(projectStateDir);
  const persistedRepos = persisted ?? [];

  const discoveredByPath = new Map(discovered.map((repo) => [repo.path, repo]));
  const persistedByPath = new Map(persistedRepos.map((repo) => [repo.path, repo]));

  const result: WorkspaceRepo[] = [];
  const seenPaths = new Set<string>();

  for (const persistedRepo of persistedRepos) {
    if (discoveredByPath.has(persistedRepo.path)) {
      result.push(persistedRepo);
      seenPaths.add(persistedRepo.path);
    }
  }

  for (const discoveredRepo of discovered) {
    if (seenPaths.has(discoveredRepo.path)) continue;
    if (persistedByPath.has(discoveredRepo.path)) continue;
    result.push(discoveredRepo);
    seenPaths.add(discoveredRepo.path);
  }

  result.sort((a, b) => a.name.localeCompare(b.name));

  // Persist only when the on-disk registry needs updating: skip the write if
  // the result matches what is already persisted, and skip creating a new
  // file for an empty workspace that has no prior registry.
  const persistedFileExists = persisted !== null;
  const needsWrite = persistedFileExists ? !reposEqual(result, persistedRepos) : result.length > 0;
  if (needsWrite) {
    saveRepoRegistry(projectStateDir, result);
  }
  return result;
};

export type WorkspaceRepos = {
  list(): WorkspaceRepo[];
  getByName(name: string): WorkspaceRepo | undefined;
  findByPath(path: string): WorkspaceRepo | undefined;
  /**
   * Resolve a repo's working tree root. With no argument, returns the root of
   * the only repo when there is exactly one. With a name, returns that named
   * repo. Throws if the resolution is ambiguous (no name passed, multiple
   * repos) or unknown (name passed, not registered).
   */
  gitRoot(name?: string): string;
  refresh(): WorkspaceRepo[];
};

/** Build a `WorkspaceRepos` adapter backed by the persisted registry. */
export const createWorkspaceRepos = (
  projectStateDir: string,
  workspaceCwd: string,
): WorkspaceRepos => {
  let repos = reconcileRepoRegistry(projectStateDir, workspaceCwd);

  const list = (): WorkspaceRepo[] => repos.slice();
  const getByName = (name: string): WorkspaceRepo | undefined =>
    repos.find((repo) => repo.name === name);
  const findByPath = (path: string): WorkspaceRepo | undefined => {
    const absolute = resolve(path);
    return repos.find((repo) => {
      if (repo.path === absolute) return true;
      const rel = relative(repo.path, absolute);
      return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
    });
  };
  const gitRoot = (name?: string): string => {
    if (name === undefined) {
      if (repos.length === 1) {
        const only = repos[0];
        if (only) return only.path;
      }
      if (repos.length === 0) {
        throw new Error("No repos registered in this workspace.");
      }
      throw new Error(
        `Workspace has ${repos.length} repos; gitRoot() requires an explicit repo name.`,
      );
    }
    const found = getByName(name);
    if (!found) {
      throw new Error(`No repo registered with name '${name}'.`);
    }
    return found.path;
  };
  const refresh = (): WorkspaceRepo[] => {
    repos = reconcileRepoRegistry(projectStateDir, workspaceCwd);
    return list();
  };

  return { list, getByName, findByPath, gitRoot, refresh };
};
