import {
  type ExecuteDecisionResult,
  executeOctobossDecision,
  parseOctobossDecision,
} from "../octoboss/router";
import type { ApiRouteHandler } from "./routeHelpers";
import { readJsonBodyOrWriteError, writeJson, writeMethodNotAllowed } from "./routeHelpers";

const OCTOBOSS_ROUTE_PATH = "/api/octoboss/route";

/**
 * Acts on a routing decision produced upstream (e.g. by an octoboss agent
 * reading `prompts/octoboss-router.md`). The endpoint does not call an LLM
 * itself — it parses the LLM's text output, validates the decision shape,
 * and runs the corresponding side effect (create tentacle / append todo /
 * return clarification).
 *
 * Body: `{ userRequest: string, llmOutput: string }`.
 */
export const handleOctobossRouteRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd, projectStateDir },
) => {
  if (requestUrl.pathname !== OCTOBOSS_ROUTE_PATH) return false;
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const bodyResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyResult.ok) return true;
  const body = (bodyResult.payload ?? {}) as Record<string, unknown>;

  const userRequest = typeof body.userRequest === "string" ? body.userRequest.trim() : "";
  if (userRequest.length === 0) {
    writeJson(response, 400, { error: "userRequest is required." }, corsOrigin);
    return true;
  }

  const llmOutput = typeof body.llmOutput === "string" ? body.llmOutput : "";
  const parsed = parseOctobossDecision(llmOutput);
  if (!parsed.ok) {
    writeJson(response, 400, { error: parsed.error }, corsOrigin);
    return true;
  }

  const result = executeOctobossDecision({
    workspaceCwd,
    projectStateDir,
    userRequest,
    decision: parsed.decision,
  });

  writeExecutionResult(response, corsOrigin, result);
  return true;
};

const writeExecutionResult = (
  response: Parameters<ApiRouteHandler>[0]["response"],
  corsOrigin: string | null,
  result: ExecuteDecisionResult,
): void => {
  switch (result.kind) {
    case "routed":
      writeJson(
        response,
        200,
        {
          action: "routed",
          tentacleId: result.tentacleId,
          todoTotal: result.todoTotal,
          todoDone: result.todoDone,
        },
        corsOrigin,
      );
      return;
    case "created":
      writeJson(response, 201, { action: "created", tentacle: result.tentacle }, corsOrigin);
      return;
    case "clarification":
      writeJson(response, 200, { action: "clarification", question: result.question }, corsOrigin);
      return;
    case "not-found":
      writeJson(response, 404, { error: `Tentacle '${result.tentacleId}' not found.` }, corsOrigin);
      return;
    case "create-failed":
      writeJson(response, 400, { error: result.reason }, corsOrigin);
      return;
    case "append-failed":
      writeJson(
        response,
        500,
        { error: `Could not append todo to tentacle '${result.tentacleId}'.` },
        corsOrigin,
      );
      return;
  }
};
