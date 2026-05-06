import { join } from "node:path";

import type { TerminalSnapshot } from "@octogent/core";

import { parseTerminalWorkspaceMode } from "../createApiServer/terminalParsers";
import { parseTodoProgress, readDeckTentacles, readDeckVaultFile } from "../deck/readDeckTentacles";
import { TENTACLES_RELATIVE_PATH } from "../terminalRuntime/constants";
import type { TentacleWorkspaceMode } from "../terminalRuntime/types";
import type { SwarmTodoItem } from "./index";

// Inputs shared by the spawn (`POST /api/deck/tentacles/<id>/swarm`) and
// preview (`POST /api/swarm-plans`) routes. The route-specific concerns
// (existing-swarm check, agentProvider, prompt resolution, terminal creation)
// stay in their respective handlers.
export type LoadedSwarmPlanInputs = {
  targetItems: SwarmTodoItem[];
  tentacleName: string;
  tentacleContextPath: string;
  baseRef: string;
  parentBaseBranch: string;
  workerWorkspaceMode: TentacleWorkspaceMode;
  /** True when worker branches should anchor on the tentacle integration
   * branch (`octogent/<tentacleId>/worker-<n>`). Implies the integration
   * worktree already exists in at least one repo. */
  useTentacleBranches: boolean;
  /** Per-todo file scope predictions (typically from octoboss) used by the
   * planner to derive each worker's sparse-checkout paths. */
  scopePredictions?: Record<number, ReadonlyArray<string>>;
};

export type LoadSwarmPlanInputsResult =
  | { ok: true; inputs: LoadedSwarmPlanInputs }
  | { ok: false; status: number; error: string };

export type LoadSwarmPlanInputsParams = {
  workspaceCwd: string;
  projectStateDir: string;
  listTerminalSnapshots: () => readonly TerminalSnapshot[];
  body: Record<string, unknown>;
  tentacleId: string;
  /** Number of integration worktrees the tentacle has on disk. >= 1 means the
   * `octogent/<tentacleId>` branch exists in at least one repo and worker
   * branches can anchor on it. Pass 0 (legacy fallback) when no repos are
   * registered or no integration worktree has been created. */
  integrationWorktreeCount: number;
};

export const loadSwarmPlanInputs = (
  params: LoadSwarmPlanInputsParams,
): LoadSwarmPlanInputsResult => {
  const { workspaceCwd, projectStateDir, listTerminalSnapshots, body, tentacleId } = params;

  const todoContent = readDeckVaultFile(workspaceCwd, tentacleId, "todo.md");
  if (todoContent === null) {
    return { ok: false, status: 404, error: "Tentacle or todo.md not found." };
  }

  const incompleteItems = parseTodoProgress(todoContent)
    .items.map((item, index) => ({ ...item, index }))
    .filter((item) => !item.done);

  if (incompleteItems.length === 0) {
    return { ok: false, status: 400, error: "No incomplete todo items found." };
  }

  const workspaceModeResult = parseTerminalWorkspaceMode(body);
  if (workspaceModeResult.error) {
    return { ok: false, status: 400, error: workspaceModeResult.error };
  }
  const workerWorkspaceMode =
    body.workspaceMode === undefined ? "worktree" : workspaceModeResult.workspaceMode;

  let targetItems: SwarmTodoItem[] = incompleteItems.map((item) => ({
    index: item.index,
    text: item.text,
  }));
  if (Array.isArray(body.todoItemIndices)) {
    const requestedIndices = new Set(
      (body.todoItemIndices as unknown[]).filter((v): v is number => typeof v === "number"),
    );
    targetItems = targetItems.filter((item) => requestedIndices.has(item.index));
    if (targetItems.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "None of the requested todo item indices are incomplete.",
      };
    }
  }

  // Branch resolution priority:
  //   1. Tentacle integration worktree exists: anchor workers on
  //      `octogent/<tentacleId>` and use sub-branch naming `octogent/<tid>/worker-<n>`.
  //   2. Legacy worktree-mode tentacle terminal exists: same `octogent/<tentacleId>`
  //      baseRef but legacy per-worker `octogent/<workerTerminalId>` branches.
  //   3. Otherwise: baseRef = HEAD, legacy per-worker branches.
  const existingTerminals = listTerminalSnapshots();
  const tentacleTerminal = existingTerminals.find(
    (t) => t.tentacleId === tentacleId && t.workspaceMode === "worktree",
  );
  const useTentacleBranches =
    workerWorkspaceMode === "worktree" && params.integrationWorktreeCount > 0;
  const baseRef = useTentacleBranches || tentacleTerminal ? `octogent/${tentacleId}` : "HEAD";

  const deckTentacles = readDeckTentacles(workspaceCwd, projectStateDir);
  const deckEntry = deckTentacles.find((t) => t.tentacleId === tentacleId);
  const tentacleName = deckEntry?.displayName ?? tentacleId;

  const tentacleContextPath = join(workspaceCwd, TENTACLES_RELATIVE_PATH, tentacleId);
  const parentBaseBranch =
    workerWorkspaceMode === "worktree" ? (baseRef === "HEAD" ? "main" : baseRef) : "main";

  // Optional `scopePredictions: Record<number, string[]>` from the request
  // body. When present and well-shaped, the planner uses it to derive each
  // worker's sparse-checkout paths.
  const scopePredictions = parseScopePredictions(body.scopePredictions);

  return {
    ok: true,
    inputs: {
      targetItems,
      tentacleName,
      tentacleContextPath,
      baseRef,
      parentBaseBranch,
      workerWorkspaceMode,
      useTentacleBranches,
      ...(scopePredictions ? { scopePredictions } : {}),
    },
  };
};

const parseScopePredictions = (raw: unknown): Record<number, ReadonlyArray<string>> | undefined => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<number, ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    if (!Array.isArray(value)) continue;
    const paths = value.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length > 0) result[index] = paths;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};
