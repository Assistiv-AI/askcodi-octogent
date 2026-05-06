import { planSwarm } from "../swarmPlanner";
import { loadSwarmPlanInputs } from "../swarmPlanner/inputs";
import { MAX_CHILDREN_PER_PARENT } from "../terminalRuntime";
import type { ApiRouteHandler } from "./routeHelpers";
import { readJsonBodyOrWriteError, writeJson, writeMethodNotAllowed } from "./routeHelpers";

const SWARM_PLAN_PREVIEW_PATH = "/api/swarm-plans";

/**
 * Preview endpoint: given a tentacle and request shape identical to the
 * spawn endpoint, return what the swarm planner would produce without
 * actually creating any terminals.
 *
 * Differences from `POST /api/deck/tentacles/<id>/swarm`:
 * - Does NOT check for existing swarm (this is a preview, not a spawn)
 * - Does NOT create any terminals
 * - Does NOT resolve prompt templates (returns raw promptTemplate name +
 *   promptVariables so the caller can resolve them later if needed)
 * - Reads `tentacleId` from the request body, not the URL
 */
export const handleSwarmPlanPreviewRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir, getApiPort },
) => {
  if (requestUrl.pathname !== SWARM_PLAN_PREVIEW_PATH) return false;

  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyReadResult.ok) return true;
  const body = (bodyReadResult.payload ?? {}) as Record<string, unknown>;

  const tentacleId = typeof body.tentacleId === "string" ? body.tentacleId.trim() : "";
  if (!tentacleId) {
    writeJson(response, 400, { error: "tentacleId is required." }, corsOrigin);
    return true;
  }

  const loaded = loadSwarmPlanInputs({
    workspaceCwd,
    projectStateDir,
    listTerminalSnapshots: () => runtime.listTerminalSnapshots(),
    body,
    tentacleId,
  });
  if (!loaded.ok) {
    writeJson(response, loaded.status, { error: loaded.error }, corsOrigin);
    return true;
  }

  const plan = planSwarm({
    tentacleId,
    tentacleName: loaded.inputs.tentacleName,
    tentacleContextPath: loaded.inputs.tentacleContextPath,
    todos: loaded.inputs.targetItems,
    workerWorkspaceMode: loaded.inputs.workerWorkspaceMode,
    baseRef: loaded.inputs.baseRef,
    parentBaseBranch: loaded.inputs.parentBaseBranch,
    apiPort: getApiPort(),
    maxChildrenPerParent: MAX_CHILDREN_PER_PARENT,
  });

  writeJson(response, 200, plan, corsOrigin);
  return true;
};
