import {
  createLauncherProject,
  listLauncherProjects,
  openLauncherProject,
  removeLauncherProject,
} from "../launcher/launcherCore";
import type { ApiRouteHandler } from "./routeHelpers";
import { readJsonBodyOrWriteError, writeJson, writeMethodNotAllowed } from "./routeHelpers";

const COLLECTION_PATH = "/api/launcher/projects";
const ITEM_PATH_PATTERN = /^\/api\/launcher\/projects\/([^/]+)$/;
const OPEN_PATH_PATTERN = /^\/api\/launcher\/projects\/([^/]+)\/open$/;

/**
 * GET / POST `/api/launcher/projects`. Mounted in project mode so the in-app
 * project switcher can list and create projects without leaving the running
 * app. The launcher standalone server uses the same `launcherCore` functions
 * via its own bespoke routing.
 */
export const handleLauncherProjectsCollectionRoute: ApiRouteHandler = async ({
  request,
  response,
  requestUrl,
  corsOrigin,
}) => {
  if (requestUrl.pathname !== COLLECTION_PATH) return false;

  if (request.method === "GET") {
    writeJson(response, 200, { projects: listLauncherProjects() }, corsOrigin);
    return true;
  }

  if (request.method === "POST") {
    const bodyResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
    if (!bodyResult.ok) return true;
    const body = (bodyResult.payload ?? {}) as Record<string, unknown>;
    const path = typeof body.path === "string" ? body.path : "";
    const name = typeof body.name === "string" ? body.name : undefined;
    const result = createLauncherProject({ path, ...(name ? { name } : {}) });
    if (result.kind === "ok") {
      writeJson(response, 201, { entry: result.entry }, corsOrigin);
    } else if (result.kind === "missing-folder") {
      writeJson(response, 404, { error: "Folder does not exist." }, corsOrigin);
    } else {
      writeJson(response, 400, { error: result.reason }, corsOrigin);
    }
    return true;
  }

  writeMethodNotAllowed(response, corsOrigin);
  return true;
};

/**
 * POST `/api/launcher/projects/:id/open`. Spawns the project's API process if
 * not running, returns the apiBaseUrl. Same semantics as the launcher server.
 *
 * Must be registered BEFORE handleLauncherProjectItemRoute so the more
 * specific `/open` suffix matches first.
 */
export const handleLauncherProjectOpenRoute: ApiRouteHandler = async ({
  request,
  response,
  requestUrl,
  corsOrigin,
}) => {
  const match = requestUrl.pathname.match(OPEN_PATH_PATTERN);
  if (!match) return false;

  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const projectId = decodeURIComponent(match[1] ?? "");
  const result = await openLauncherProject(projectId);
  if (result.kind === "ok") {
    writeJson(
      response,
      200,
      { apiBaseUrl: result.apiBaseUrl, alreadyRunning: result.alreadyRunning },
      corsOrigin,
    );
  } else if (result.kind === "not-found") {
    writeJson(response, 404, { error: "Project not found." }, corsOrigin);
  } else if (result.kind === "missing-folder") {
    writeJson(response, 404, { error: "Project folder no longer exists." }, corsOrigin);
  } else if (result.kind === "spawn-failed") {
    writeJson(response, 500, { error: `Failed to start project: ${result.reason}` }, corsOrigin);
  } else {
    writeJson(response, 504, { error: "Timed out waiting for project to start." }, corsOrigin);
  }
  return true;
};

/**
 * DELETE `/api/launcher/projects/:id`. Unregisters the project from the
 * global registry. Does not delete the project folder.
 */
export const handleLauncherProjectItemRoute: ApiRouteHandler = async ({
  request,
  response,
  requestUrl,
  corsOrigin,
}) => {
  const match = requestUrl.pathname.match(ITEM_PATH_PATTERN);
  if (!match) return false;

  if (request.method !== "DELETE") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const projectId = decodeURIComponent(match[1] ?? "");
  const result = removeLauncherProject(projectId);
  if (result.kind === "ok") {
    writeJson(response, 200, { ok: true }, corsOrigin);
  } else {
    writeJson(response, 404, { error: "Project not found." }, corsOrigin);
  }
  return true;
};
