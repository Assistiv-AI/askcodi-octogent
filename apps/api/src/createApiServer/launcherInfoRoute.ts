import { loadProjectConfig } from "../projectPersistence";
import type { ApiRouteHandler } from "./routeHelpers";
import { writeJson, writeMethodNotAllowed } from "./routeHelpers";

const LAUNCHER_INFO_PATH = "/api/launcher/info";

// ProjectConfig is invariant for the server's lifetime (a config change
// requires a server restart). Read once per workspaceCwd, then close over.
type CachedConfig = ReturnType<typeof loadProjectConfig>;
const projectConfigCache = new Map<string, CachedConfig>();
const getProjectConfigCached = (workspaceCwd: string): CachedConfig => {
  if (projectConfigCache.has(workspaceCwd)) {
    return projectConfigCache.get(workspaceCwd) ?? null;
  }
  const config = loadProjectConfig(workspaceCwd);
  projectConfigCache.set(workspaceCwd, config);
  return config;
};

export const handleLauncherInfoRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  if (requestUrl.pathname !== LAUNCHER_INFO_PATH) return false;
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const projectConfig = getProjectConfigCached(workspaceCwd);
  writeJson(
    response,
    200,
    {
      mode: "project",
      cwd: workspaceCwd,
      cwdIsInitialized: projectConfig !== null,
      cwdProjectName: projectConfig?.displayName ?? null,
      cwdProjectId: projectConfig?.projectId ?? null,
    },
    corsOrigin,
  );
  return true;
};
