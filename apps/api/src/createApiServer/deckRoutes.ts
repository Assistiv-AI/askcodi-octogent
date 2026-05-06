import { join } from "node:path";

import {
  addTodoItem,
  createDeckTentacle,
  deleteDeckTentacle,
  deleteTodoItem,
  editTodoItem,
  listDeckAvailableSkills,
  parseTodoProgress,
  readDeckTentacles,
  readDeckVaultFile,
  setTentacleWorktreeMetadata,
  toggleTodoItem,
  unsetTentacleWorktreeMetadata,
  updateDeckTentacleSuggestedSkills,
} from "../deck/readDeckTentacles";
import { resolvePrompt } from "../prompts";
import { planSwarm } from "../swarmPlanner";
import { loadSwarmPlanInputs } from "../swarmPlanner/inputs";
import {
  MAX_CHILDREN_PER_PARENT,
  NoReposRegisteredError,
  RuntimeInputError,
} from "../terminalRuntime";
import { TENTACLES_RELATIVE_PATH } from "../terminalRuntime/constants";
import type { ApiRouteHandler } from "./routeHelpers";
import {
  readJsonBodyOrWriteError,
  writeJson,
  writeMethodNotAllowed,
  writeNoContent,
  writeText,
} from "./routeHelpers";
import { parseTerminalAgentProvider } from "./terminalParsers";

const buildSingleTodoWorkerPrompt = async ({
  promptsDir,
  workspaceCwd,
  tentacleId,
  tentacleName,
  todoItemText,
  terminalId,
  apiPort,
}: {
  promptsDir: string;
  workspaceCwd: string;
  tentacleId: string;
  tentacleName: string;
  todoItemText: string;
  terminalId: string;
  apiPort: string;
}) => {
  const tentacleContextPath = join(workspaceCwd, TENTACLES_RELATIVE_PATH, tentacleId);

  return await resolvePrompt(promptsDir, "swarm-worker", {
    tentacleName,
    tentacleId,
    tentacleContextPath,
    todoItemText,
    terminalId,
    apiPort,
    workspaceContextIntro:
      "You are working in the shared main workspace on the main branch, not in an isolated worktree.",
    workspaceGuidelines: [
      "- You must work in the main project directory. Do NOT create or use git worktrees for this task.",
      "- You are working in the shared main workspace. Keep edits narrow and focused on this one todo item.",
      "- Do NOT create commits. Leave your completed changes uncommitted in the main workspace.",
      "- Do NOT mark todo items done or rewrite tentacle context files unless this specific todo item explicitly requires it.",
    ].join("\n"),
    commitGuidance:
      "- Do NOT commit. Leave your completed changes uncommitted in the shared workspace and report what changed.",
    definitionOfDoneCommitStep:
      "Changes are left uncommitted in the shared main workspace, ready for operator review.",
    workspaceReminder: "Do not commit. Do not use worktrees.",
    parentTerminalId: "",
    parentSection: "",
  });
};

export const handleDeckTentaclesRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd, projectStateDir },
) => {
  if (requestUrl.pathname !== "/api/deck/tentacles") return false;

  if (request.method === "GET") {
    const tentacles = readDeckTentacles(workspaceCwd, projectStateDir);
    writeJson(response, 200, tentacles, corsOrigin);
    return true;
  }

  if (request.method === "POST") {
    const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
    if (!bodyReadResult.ok) return true;

    const body = bodyReadResult.payload as Record<string, unknown> | null;
    const name = body && typeof body.name === "string" ? body.name : "";
    const description = body && typeof body.description === "string" ? body.description : "";
    const color = body && typeof body.color === "string" ? body.color : "#d4a017";
    const suggestedSkills =
      body && Array.isArray(body.suggestedSkills)
        ? body.suggestedSkills.filter((skill): skill is string => typeof skill === "string")
        : [];

    const rawOctopus =
      body && typeof body.octopus === "object" && body.octopus !== null
        ? (body.octopus as Record<string, unknown>)
        : {};
    const octopus = {
      animation: typeof rawOctopus.animation === "string" ? rawOctopus.animation : null,
      expression: typeof rawOctopus.expression === "string" ? rawOctopus.expression : null,
      accessory: typeof rawOctopus.accessory === "string" ? rawOctopus.accessory : null,
      hairColor: typeof rawOctopus.hairColor === "string" ? rawOctopus.hairColor : null,
    };

    const result = createDeckTentacle(
      workspaceCwd,
      { name, description, color, octopus, suggestedSkills },
      projectStateDir,
    );
    if (!result.ok) {
      writeJson(response, 400, { error: result.error }, corsOrigin);
      return true;
    }

    writeJson(response, 201, result.tentacle, corsOrigin);
    return true;
  }

  writeMethodNotAllowed(response, corsOrigin);
  return true;
};

export const handleDeckSkillsRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  if (requestUrl.pathname !== "/api/deck/skills") return false;

  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  writeJson(response, 200, listDeckAvailableSkills(workspaceCwd), corsOrigin);
  return true;
};

const DECK_TENTACLE_ITEM_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)$/;

export const handleDeckTentacleItemRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir },
) => {
  const match = requestUrl.pathname.match(DECK_TENTACLE_ITEM_PATTERN);
  if (!match) return false;

  if (request.method !== "DELETE") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);

  // Tear down integration worktrees before removing the tentacle directory
  // so we do not leak git worktree refs (the tentacle dir contains the
  // worktree paths; rmSync alone leaves git's worktree registry stale).
  // If tentacleId is invalid, skip cleanup and let deleteDeckTentacle return
  // its standard validation error.
  try {
    for (const entry of runtime.listTentacleIntegrationWorktrees(tentacleId)) {
      runtime.removeTentacleIntegrationWorktree(tentacleId, {
        repoName: entry.repoName,
        bestEffort: true,
      });
    }
  } catch (error) {
    if (!(error instanceof RuntimeInputError)) throw error;
  }

  const result = deleteDeckTentacle(workspaceCwd, tentacleId, projectStateDir);
  if (!result.ok) {
    writeJson(response, 404, { error: result.error }, corsOrigin);
    return true;
  }

  writeNoContent(response, 204, corsOrigin);
  return true;
};

const DECK_VAULT_FILE_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/files\/([^/]+)$/;

export const handleDeckVaultFileRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  const match = requestUrl.pathname.match(DECK_VAULT_FILE_PATTERN);
  if (!match) return false;
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const fileName = decodeURIComponent(match[2] as string);

  const content = readDeckVaultFile(workspaceCwd, tentacleId, fileName);
  if (content === null) {
    writeJson(response, 404, { error: "Vault file not found" }, corsOrigin);
    return true;
  }

  writeText(response, 200, content, "text/markdown; charset=utf-8", corsOrigin);
  return true;
};

const DECK_TENTACLE_SKILLS_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/skills$/;

export const handleDeckTentacleSkillsRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd, projectStateDir },
) => {
  const match = requestUrl.pathname.match(DECK_TENTACLE_SKILLS_PATTERN);
  if (!match) return false;
  if (request.method !== "PATCH") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const body = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!body.ok) return true;

  const payload = body.payload as Record<string, unknown> | null;
  const suggestedSkills = Array.isArray(payload?.suggestedSkills)
    ? payload.suggestedSkills.filter((skill): skill is string => typeof skill === "string")
    : null;

  if (suggestedSkills === null) {
    writeJson(response, 400, { error: "suggestedSkills (string[]) is required" }, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const updated = updateDeckTentacleSuggestedSkills(
    workspaceCwd,
    tentacleId,
    suggestedSkills,
    projectStateDir,
  );
  if (!updated) {
    writeJson(response, 404, { error: "Tentacle not found" }, corsOrigin);
    return true;
  }

  writeJson(response, 200, updated, corsOrigin);
  return true;
};

// ---------------------------------------------------------------------------
// Deck — Tentacle integration worktrees
// ---------------------------------------------------------------------------

const DECK_TENTACLE_WORKTREES_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/worktrees$/;
const DECK_TENTACLE_WORKTREE_ITEM_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/worktrees\/([^/]+)$/;

const findTentacleSummary = (workspaceCwd: string, projectStateDir: string, tentacleId: string) =>
  readDeckTentacles(workspaceCwd, projectStateDir).find((t) => t.tentacleId === tentacleId);

export const handleDeckTentacleWorktreesRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir },
) => {
  const match = requestUrl.pathname.match(DECK_TENTACLE_WORKTREES_PATTERN);
  if (!match) return false;
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  if (!findTentacleSummary(workspaceCwd, projectStateDir, tentacleId)) {
    writeJson(response, 404, { error: "Tentacle not found" }, corsOrigin);
    return true;
  }

  const body = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!body.ok) return true;
  const payload = (body.payload ?? {}) as Record<string, unknown>;

  const repoName = typeof payload.repoName === "string" ? payload.repoName.trim() : "";
  if (!repoName) {
    writeJson(response, 400, { error: "repoName is required" }, corsOrigin);
    return true;
  }

  const baseRef = typeof payload.baseRef === "string" ? payload.baseRef : undefined;

  // Filesystem is the source of truth for which worktrees exist; deck metadata
  // is the createdAt cache, written only after the worktree creation succeeds.
  try {
    runtime.createTentacleIntegrationWorktree(
      tentacleId,
      baseRef === undefined ? { repoName } : { repoName, baseRef },
    );
  } catch (error) {
    if (error instanceof RuntimeInputError) {
      writeJson(response, 400, { error: error.message }, corsOrigin);
      return true;
    }
    throw error;
  }

  setTentacleWorktreeMetadata(workspaceCwd, tentacleId, repoName, projectStateDir);

  const refreshed = findTentacleSummary(workspaceCwd, projectStateDir, tentacleId);
  if (!refreshed) {
    writeJson(response, 500, { error: "Tentacle missing after worktree creation" }, corsOrigin);
    return true;
  }
  writeJson(response, 201, refreshed, corsOrigin);
  return true;
};

export const handleDeckTentacleWorktreeItemRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir },
) => {
  const match = requestUrl.pathname.match(DECK_TENTACLE_WORKTREE_ITEM_PATTERN);
  if (!match) return false;
  if (request.method !== "DELETE") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);

  if (!findTentacleSummary(workspaceCwd, projectStateDir, tentacleId)) {
    writeJson(response, 404, { error: "Tentacle not found" }, corsOrigin);
    return true;
  }

  // Idempotent: a missing worktree still clears stale deck metadata and returns 204.
  // The pre-scan also avoids 400ing on `repoName` values that are no longer registered.
  const onDisk = runtime.listTentacleIntegrationWorktrees(tentacleId);
  if (onDisk.some((entry) => entry.repoName === repoName)) {
    try {
      runtime.removeTentacleIntegrationWorktree(tentacleId, { repoName, bestEffort: true });
    } catch (error) {
      if (error instanceof RuntimeInputError) {
        writeJson(response, 400, { error: error.message }, corsOrigin);
        return true;
      }
      throw error;
    }
  }

  unsetTentacleWorktreeMetadata(workspaceCwd, tentacleId, repoName, projectStateDir);

  writeNoContent(response, 204, corsOrigin);
  return true;
};

// ---------------------------------------------------------------------------
// Deck — Todo toggle
// ---------------------------------------------------------------------------

const DECK_TODO_TOGGLE_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/todo\/toggle$/;

export const handleDeckTodoToggleRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  const match = requestUrl.pathname.match(DECK_TODO_TOGGLE_PATTERN);
  if (!match) return false;
  if (request.method !== "PATCH") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const body = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!body.ok) return true;

  const { itemIndex, done } = body.payload as { itemIndex: unknown; done: unknown };
  if (typeof itemIndex !== "number" || typeof done !== "boolean") {
    writeJson(
      response,
      400,
      { error: "itemIndex (number) and done (boolean) are required" },
      corsOrigin,
    );
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const result = toggleTodoItem(workspaceCwd, tentacleId, itemIndex, done);
  if (!result) {
    writeJson(response, 404, { error: "Todo item not found" }, corsOrigin);
    return true;
  }

  writeJson(response, 200, result, corsOrigin);
  return true;
};

// ---------------------------------------------------------------------------
// Deck — Todo edit (rename item text)
// ---------------------------------------------------------------------------

const DECK_TODO_EDIT_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/todo\/edit$/;

export const handleDeckTodoEditRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  const match = requestUrl.pathname.match(DECK_TODO_EDIT_PATTERN);
  if (!match) return false;
  if (request.method !== "PATCH") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const body = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!body.ok) return true;

  const { itemIndex, text } = body.payload as { itemIndex: unknown; text: unknown };
  if (typeof itemIndex !== "number" || typeof text !== "string" || text.trim().length === 0) {
    writeJson(
      response,
      400,
      { error: "itemIndex (number) and text (non-empty string) are required" },
      corsOrigin,
    );
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const result = editTodoItem(workspaceCwd, tentacleId, itemIndex, text.trim());
  if (!result) {
    writeJson(response, 404, { error: "Todo item not found" }, corsOrigin);
    return true;
  }

  writeJson(response, 200, result, corsOrigin);
  return true;
};

// ---------------------------------------------------------------------------
// Deck — Todo add
// ---------------------------------------------------------------------------

const DECK_TODO_ADD_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/todo$/;

export const handleDeckTodoAddRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  const match = requestUrl.pathname.match(DECK_TODO_ADD_PATTERN);
  if (!match) return false;
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const body = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!body.ok) return true;

  const { text } = body.payload as { text: unknown };
  if (typeof text !== "string" || text.trim().length === 0) {
    writeJson(response, 400, { error: "text (non-empty string) is required" }, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const result = addTodoItem(workspaceCwd, tentacleId, text.trim());
  if (!result) {
    writeJson(response, 404, { error: "Tentacle todo.md not found" }, corsOrigin);
    return true;
  }

  writeJson(response, 201, result, corsOrigin);
  return true;
};

// ---------------------------------------------------------------------------
// Deck — Todo delete
// ---------------------------------------------------------------------------

const DECK_TODO_DELETE_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/todo\/delete$/;

export const handleDeckTodoDeleteRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  const match = requestUrl.pathname.match(DECK_TODO_DELETE_PATTERN);
  if (!match) return false;
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const body = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!body.ok) return true;

  const { itemIndex } = body.payload as { itemIndex: unknown };
  if (typeof itemIndex !== "number") {
    writeJson(response, 400, { error: "itemIndex (number) is required" }, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const result = deleteTodoItem(workspaceCwd, tentacleId, itemIndex);
  if (!result) {
    writeJson(response, 404, { error: "Todo item not found" }, corsOrigin);
    return true;
  }

  writeJson(response, 200, result, corsOrigin);
  return true;
};

// ---------------------------------------------------------------------------
// Deck — Solve a single todo item
// ---------------------------------------------------------------------------

const DECK_TODO_SOLVE_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/todo\/solve$/;

export const handleDeckTodoSolveRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir, promptsDir, getApiPort },
) => {
  const match = requestUrl.pathname.match(DECK_TODO_SOLVE_PATTERN);
  if (!match) return false;
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyReadResult.ok) return true;

  const body = (bodyReadResult.payload ?? {}) as Record<string, unknown>;
  const itemIndex = body.itemIndex;
  if (typeof itemIndex !== "number") {
    writeJson(response, 400, { error: "itemIndex (number) is required" }, corsOrigin);
    return true;
  }

  const agentProviderResult = parseTerminalAgentProvider(body);
  if (agentProviderResult.error) {
    writeJson(response, 400, { error: agentProviderResult.error }, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);
  const todoContent = readDeckVaultFile(workspaceCwd, tentacleId, "todo.md");
  if (todoContent === null) {
    writeJson(response, 404, { error: "Tentacle or todo.md not found." }, corsOrigin);
    return true;
  }

  const todoResult = parseTodoProgress(todoContent);
  const todoItem = todoResult.items[itemIndex] ?? null;
  if (!todoItem) {
    writeJson(response, 404, { error: "Todo item not found." }, corsOrigin);
    return true;
  }
  if (todoItem.done) {
    writeJson(response, 400, { error: "Todo item is already complete." }, corsOrigin);
    return true;
  }

  const terminalId = `${tentacleId}-todo-${itemIndex}`;
  const existingTerminal = runtime
    .listTerminalSnapshots()
    .find((terminal) => terminal.terminalId === terminalId);
  if (existingTerminal) {
    writeJson(
      response,
      409,
      { error: "A solve agent is already active for this todo item.", terminalId },
      corsOrigin,
    );
    return true;
  }

  const deckTentacles = readDeckTentacles(workspaceCwd, projectStateDir);
  const deckEntry = deckTentacles.find((tentacle) => tentacle.tentacleId === tentacleId);
  const tentacleName = deckEntry?.displayName ?? tentacleId;

  try {
    const workerPrompt = await buildSingleTodoWorkerPrompt({
      promptsDir,
      workspaceCwd,
      tentacleId,
      tentacleName,
      todoItemText: todoItem.text,
      terminalId,
      apiPort: getApiPort(),
    });

    const snapshot = runtime.createTerminal({
      terminalId,
      tentacleId,
      tentacleName,
      nameOrigin: "generated",
      autoRenamePromptContext: todoItem.text,
      workspaceMode: "shared",
      ...(agentProviderResult.agentProvider
        ? { agentProvider: agentProviderResult.agentProvider }
        : {}),
      ...(workerPrompt ? { initialPrompt: workerPrompt } : {}),
    });

    writeJson(
      response,
      201,
      {
        terminalId: snapshot.terminalId,
        tentacleId,
        itemIndex,
        workspaceMode: "shared",
      },
      corsOrigin,
    );
    return true;
  } catch (error) {
    if (error instanceof RuntimeInputError) {
      writeJson(response, 400, { error: error.message }, corsOrigin);
      return true;
    }

    throw error;
  }
};

// ---------------------------------------------------------------------------
// Deck — Swarm
// ---------------------------------------------------------------------------

const DECK_TENTACLE_SWARM_PATTERN = /^\/api\/deck\/tentacles\/([^/]+)\/swarm$/;

export const handleDeckTentacleSwarmRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir, promptsDir, getApiPort },
) => {
  const match = requestUrl.pathname.match(DECK_TENTACLE_SWARM_PATTERN);
  if (!match) return false;

  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const tentacleId = decodeURIComponent(match[1] as string);

  const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyReadResult.ok) return true;
  const body = (bodyReadResult.payload ?? {}) as Record<string, unknown>;

  // agentProvider parsing is spawn-only (the preview endpoint does not need
  // a backing agent), so it stays in the route handler.
  const agentProviderResult = parseTerminalAgentProvider(body);
  if (agentProviderResult.error) {
    writeJson(response, 400, { error: agentProviderResult.error }, corsOrigin);
    return true;
  }

  // Existing-swarm guard is also spawn-only: previewing a plan for a
  // tentacle that already has an active swarm is a legitimate operation.
  const existingTerminals = runtime.listTerminalSnapshots();
  const existingSwarmIds = existingTerminals
    .filter((t) => t.terminalId.startsWith(`${tentacleId}-swarm-`))
    .map((t) => t.terminalId);
  if (existingSwarmIds.length > 0) {
    writeJson(
      response,
      409,
      { error: "A swarm is already active for this tentacle.", existingSwarmIds },
      corsOrigin,
    );
    return true;
  }

  // Pre-flight: when workspaceMode is worktree AND repos are registered, ensure
  // the tentacle has an integration worktree so worker branches can anchor on
  // `octogent/<tentacleId>`. Auto-create one for the only registered repo, or
  // require an explicit `repoName` when multiple are registered. Workspaces
  // with zero registered repos fall through to the legacy single-repo path.
  const workspaceModeRaw = typeof body.workspaceMode === "string" ? body.workspaceMode : "worktree";
  let integrationWorktreeCount = 0;
  try {
    integrationWorktreeCount = runtime.listTentacleIntegrationWorktrees(tentacleId).length;
  } catch {
    // Invalid tentacle id — let loadSwarmPlanInputs surface the 404.
  }

  if (workspaceModeRaw === "worktree" && integrationWorktreeCount === 0) {
    const requestedRepoName =
      typeof body.repoName === "string" && body.repoName.trim().length > 0
        ? body.repoName.trim()
        : undefined;
    try {
      runtime.createTentacleIntegrationWorktree(
        tentacleId,
        requestedRepoName === undefined ? {} : { repoName: requestedRepoName },
      );
      integrationWorktreeCount = 1;
    } catch (error) {
      // No repos registered → legacy fallback.
      // Other RuntimeInputErrors (ambiguous / unknown repoName, branch exists) → 400.
      if (error instanceof NoReposRegisteredError) {
        // legacy path; integrationWorktreeCount stays 0
      } else if (error instanceof RuntimeInputError) {
        writeJson(response, 400, { error: error.message }, corsOrigin);
        return true;
      } else {
        throw error;
      }
    }
  }

  const loaded = loadSwarmPlanInputs({
    workspaceCwd,
    projectStateDir,
    listTerminalSnapshots: () => existingTerminals,
    body,
    tentacleId,
    integrationWorktreeCount,
  });
  if (!loaded.ok) {
    writeJson(response, loaded.status, { error: loaded.error }, corsOrigin);
    return true;
  }

  const apiPort = getApiPort();
  const plan = planSwarm({
    tentacleId,
    tentacleName: loaded.inputs.tentacleName,
    tentacleContextPath: loaded.inputs.tentacleContextPath,
    todos: loaded.inputs.targetItems,
    workerWorkspaceMode: loaded.inputs.workerWorkspaceMode,
    baseRef: loaded.inputs.baseRef,
    parentBaseBranch: loaded.inputs.parentBaseBranch,
    apiPort,
    maxChildrenPerParent: MAX_CHILDREN_PER_PARENT,
    useTentacleBranches: loaded.inputs.useTentacleBranches,
  });

  try {
    if (plan.parent) {
      const parentPrompt = await resolvePrompt(
        promptsDir,
        plan.parent.promptTemplate,
        plan.parent.promptVariables,
      );

      runtime.createTerminal({
        terminalId: plan.parent.terminalId,
        tentacleId,
        tentacleName: plan.parent.tentacleName,
        workspaceMode: plan.parent.workspaceMode,
        ...(agentProviderResult.agentProvider
          ? { agentProvider: agentProviderResult.agentProvider }
          : {}),
        ...(parentPrompt ? { initialPrompt: parentPrompt } : {}),
      });
    } else {
      const [worker] = plan.workers;
      if (!worker) {
        writeJson(response, 400, { error: "No incomplete todo items found." }, corsOrigin);
        return true;
      }

      const workerPrompt = await resolvePrompt(
        promptsDir,
        worker.promptTemplate,
        worker.promptVariables,
      );

      runtime.createTerminal({
        terminalId: worker.terminalId,
        tentacleId,
        ...(worker.worktreeId ? { worktreeId: worker.worktreeId } : {}),
        tentacleName: worker.tentacleName,
        nameOrigin: "generated",
        autoRenamePromptContext: worker.autoRenamePromptContext,
        workspaceMode: worker.workspaceMode,
        ...(agentProviderResult.agentProvider
          ? { agentProvider: agentProviderResult.agentProvider }
          : {}),
        ...(workerPrompt ? { initialPrompt: workerPrompt } : {}),
        ...(worker.baseRef ? { baseRef: worker.baseRef } : {}),
      });
    }
  } catch (error) {
    if (error instanceof RuntimeInputError) {
      writeJson(response, 400, { error: error.message }, corsOrigin);
      return true;
    }
    throw error;
  }

  const responseWorkers = plan.workers.map((w) => ({
    terminalId: w.terminalId,
    todoIndex: w.todoIndex,
    todoText: w.todoText,
  }));

  writeJson(
    response,
    201,
    { tentacleId, parentTerminalId: plan.parent?.terminalId ?? null, workers: responseWorkers },
    corsOrigin,
  );
  return true;
};
