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

  const existingTerminals = listTerminalSnapshots();
  const tentacleTerminal = existingTerminals.find(
    (t) => t.tentacleId === tentacleId && t.workspaceMode === "worktree",
  );
  const baseRef = tentacleTerminal ? `octogent/${tentacleId}` : "HEAD";

  const deckTentacles = readDeckTentacles(workspaceCwd, projectStateDir);
  const deckEntry = deckTentacles.find((t) => t.tentacleId === tentacleId);
  const tentacleName = deckEntry?.displayName ?? tentacleId;

  const tentacleContextPath = join(workspaceCwd, TENTACLES_RELATIVE_PATH, tentacleId);
  const parentBaseBranch =
    workerWorkspaceMode === "worktree" ? (baseRef === "HEAD" ? "main" : baseRef) : "main";

  return {
    ok: true,
    inputs: {
      targetItems,
      tentacleName,
      tentacleContextPath,
      baseRef,
      parentBaseBranch,
      workerWorkspaceMode,
    },
  };
};
