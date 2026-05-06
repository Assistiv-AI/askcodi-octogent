import { TENTACLES_RELATIVE_PATH } from "../terminalRuntime/constants";
import type { TentacleWorkspaceMode } from "../terminalRuntime/types";

export type SwarmTodoItem = {
  // Position in the original todo.md; used to derive worker terminal IDs
  // (`<tentacleId>-swarm-<index>`) so duplicate detection is idempotent.
  index: number;
  text: string;
};

export type SwarmPlanInput = {
  tentacleId: string;
  tentacleName: string;
  tentacleContextPath: string;
  todos: ReadonlyArray<SwarmTodoItem>;
  workerWorkspaceMode: TentacleWorkspaceMode;
  baseRef: string;
  parentBaseBranch: string;
  apiPort: string | number;
  maxChildrenPerParent: number;
};

export type SwarmWorkerSpec = {
  terminalId: string;
  todoIndex: number;
  todoText: string;
  workspaceMode: TentacleWorkspaceMode;
  worktreeId?: string;
  parentTerminalId?: string;
  baseRef?: string;
  promptTemplate: "swarm-worker";
  promptVariables: Record<string, string>;
  tentacleName: string;
  autoRenamePromptContext: string;
};

export type SwarmParentSpec = {
  terminalId: string;
  workspaceMode: "shared";
  promptTemplate: "swarm-parent";
  promptVariables: Record<string, string>;
  tentacleName: string;
};

export type SwarmPlan = {
  tentacleId: string;
  tentacleName: string;
  workers: SwarmWorkerSpec[];
  parent: SwarmParentSpec | null;
  baseRef: string;
  workerWorkspaceMode: TentacleWorkspaceMode;
  // Todo order is priority order, so overflow above `maxChildrenPerParent`
  // falls off the end and is reported here for the response.
  deferredTodoIndices: number[];
};

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

type WorkerTexts = {
  contextIntro: string;
  guidelines: (terminalId: string) => string;
  commitGuidance: string;
  definitionOfDoneCommitStep: string;
  reminder: string;
};

const WORKER_TEXTS: Record<TentacleWorkspaceMode, WorkerTexts> = {
  worktree: {
    contextIntro: "You are working on an isolated worktree branch, not the main branch.",
    guidelines: (terminalId) =>
      `- You are working in an isolated git worktree on branch \`octogent/${terminalId}\`. Make changes freely without worrying about conflicts with other agents.`,
    commitGuidance: "- Commit your changes with a clear commit message describing what you did.",
    definitionOfDoneCommitStep: "Changes are committed with a descriptive message.",
    reminder: "Commit.",
  },
  shared: {
    contextIntro:
      "You are working in the shared main workspace on the main branch, not in an isolated worktree.",
    guidelines: () =>
      [
        "- You are working in the shared main workspace. Other workers may touch the same files, so keep your edits narrow, avoid broad refactors, and coordinate via your parent if you hit overlap.",
        "- Do NOT create commits in shared mode. Leave your changes uncommitted for the coordinator to review and commit later.",
        "- Do NOT mark todo items done or rewrite tentacle context files unless your assigned todo item explicitly requires it. The coordinator handles the final tentacle-level sync.",
      ].join("\n"),
    commitGuidance:
      "- Do NOT commit in shared mode. Leave your completed changes uncommitted and report DONE with a short summary of what changed.",
    definitionOfDoneCommitStep:
      "Changes are left uncommitted in the shared workspace, ready for coordinator review.",
    reminder: "Do not commit in shared mode.",
  },
};

const buildWorkerWorkspaceSection = (
  mode: TentacleWorkspaceMode,
  workers: ReadonlyArray<{ terminalId: string; todoIndex: number; todoText: string }>,
): string =>
  mode === "worktree"
    ? [
        "Each worker commits to its own isolated branch:",
        "",
        ...workers.map(
          (w) => `- \`octogent/${w.terminalId}\` — item #${w.todoIndex}: ${w.todoText}`,
        ),
      ].join("\n")
    : [
        "Workers are running in the shared main workspace, not in separate worktrees.",
        "",
        "There are no per-worker branches for this swarm. Supervise them carefully to avoid overlapping edits in the same files.",
      ].join("\n");

const buildCompletionStrategySection = (
  mode: TentacleWorkspaceMode,
  workerCount: number,
  baseBranch: string,
  tentacleId: string,
): string =>
  mode === "worktree"
    ? [
        `Only begin merging after ALL ${workerCount} workers have reported DONE.`,
        "",
        "### Step-by-step merge process",
        "",
        `1. **Create an integration branch** from \`${baseBranch}\`. First check if a stale integration branch exists from a previous swarm attempt — if so, delete it before proceeding:`,
        "   ```bash",
        `   git branch -D octogent_integration_${tentacleId} 2>/dev/null || true`,
        `   git checkout ${baseBranch}`,
        `   git checkout -b octogent_integration_${tentacleId}`,
        "   ```",
        "",
        "2. **Merge each worker branch** into the integration branch one at a time. Start with the branch most likely to merge cleanly (fewest changes):",
        "   ```bash",
        "   git merge <worker-branch-name> --no-edit",
        "   ```",
        "   If there are conflicts, resolve them carefully. Read the conflicting files and understand both sides before choosing.",
        "",
        "3. **Run tests** on the integration branch after all merges. Do not skip this step.",
        "",
        "4. **If tests pass**, merge the integration branch into the base branch:",
        "   ```bash",
        `   git checkout ${baseBranch}`,
        `   git merge octogent_integration_${tentacleId} --no-edit`,
        "   ```",
        "",
        "5. **If tests fail**, investigate and fix before merging. Do not merge broken code.",
        "",
        `6. **Update tentacle state/docs** before finalizing. Mark completed items as done in \`${TENTACLES_RELATIVE_PATH}/${tentacleId}/todo.md\`, and update \`${TENTACLES_RELATIVE_PATH}/${tentacleId}/CONTEXT.md\` or other tentacle markdown files if the merged work changed the reality they describe.`,
        "",
        "7. **Clean up** the integration branch:",
        "   ```bash",
        `   git branch -d octogent_integration_${tentacleId}`,
        "   ```",
        "",
        "### Merge failure recovery",
        "",
        "If a worker's branch has conflicts that are too complex to resolve, send a message to that worker asking them to rebase their work. Merge the other workers' branches first.",
      ].join("\n")
    : [
        `Only begin final verification after ALL ${workerCount} workers have reported DONE.`,
        "",
        "Workers are sharing the main workspace, so there are no per-worker branches to merge.",
        "",
        "### Step-by-step completion process",
        "",
        `1. **Verify the workspace is on \`${baseBranch}\`** and review the overall diff carefully. Do not assume the combined result is safe just because workers reported DONE.`,
        "",
        "2. **Review the changed files** to ensure workers did not overwrite each other or leave partial edits.",
        "",
        "3. **Run tests** on the shared workspace after all workers report DONE. Do not skip this step.",
        "",
        "4. **If tests fail**, investigate and coordinate fixes. Do not declare the swarm complete while the workspace is broken.",
        "",
        `5. **Update tentacle state/docs** before asking for approval. Mark completed items as done in \`${TENTACLES_RELATIVE_PATH}/${tentacleId}/todo.md\`, and update \`${TENTACLES_RELATIVE_PATH}/${tentacleId}/CONTEXT.md\` or other tentacle markdown files if the completed work changed the reality they describe. If no tentacle docs need updates, say that explicitly.`,
        "",
        "6. **Wait for explicit user approval** before creating any commit on the shared main branch. Present a concise summary of the reviewed diff, test results, and tentacle-doc updates first.",
        "",
        "7. **Only after approval, create one final commit** on the shared branch that captures the swarm's completed work.",
        "",
        "8. **Report completion** only after the shared workspace is reviewed, tests pass, tentacle docs are synced, approval is granted, and the final commit is created.",
        "",
        "### Shared-workspace failure recovery",
        "",
        "If two workers collide in the same files, stop them from making broad new edits, inspect the current diff, and coordinate targeted follow-up changes instead of pretending there is a clean merge boundary.",
      ].join("\n");

const buildWorkerPromptVariables = ({
  tentacleName,
  tentacleId,
  tentacleContextPath,
  todoText,
  terminalId,
  apiPort,
  workspaceMode,
  parentTerminalId,
}: {
  tentacleName: string;
  tentacleId: string;
  tentacleContextPath: string;
  todoText: string;
  terminalId: string;
  apiPort: string;
  workspaceMode: TentacleWorkspaceMode;
  parentTerminalId: string | null;
}): Record<string, string> => {
  const parentSection = parentTerminalId
    ? [
        "## Communication",
        "",
        `Your parent coordinator is at terminal \`${parentTerminalId}\`.`,
        "When you complete your task, report back:",
        "```bash",
        `node bin/octogent channel send ${parentTerminalId} "DONE: ${todoText}" --from ${terminalId}`,
        "```",
        "If you are blocked, ask for help:",
        "```bash",
        `node bin/octogent channel send ${parentTerminalId} "BLOCKED: <describe what you need>" --from ${terminalId}`,
        "```",
      ].join("\n")
    : "";

  const texts = WORKER_TEXTS[workspaceMode];
  return {
    tentacleName,
    tentacleId,
    tentacleContextPath,
    todoItemText: todoText,
    terminalId,
    apiPort,
    workspaceContextIntro: texts.contextIntro,
    workspaceGuidelines: texts.guidelines(terminalId),
    commitGuidance: texts.commitGuidance,
    definitionOfDoneCommitStep: texts.definitionOfDoneCommitStep,
    workspaceReminder: texts.reminder,
    parentTerminalId: parentTerminalId ?? "",
    parentSection,
  };
};

const buildWorkerSpawnCommand = ({
  workerTerminalId,
  tentacleId,
  parentTerminalId,
  tentacleName,
  todoText,
  workspaceMode,
  promptVariables,
}: {
  workerTerminalId: string;
  tentacleId: string;
  parentTerminalId: string;
  tentacleName: string;
  todoText: string;
  workspaceMode: TentacleWorkspaceMode;
  promptVariables: Record<string, string>;
}): string => {
  const variablesJson = JSON.stringify(promptVariables);
  const commandParts = [
    "node bin/octogent terminal create",
    `--terminal-id ${shellSingleQuote(workerTerminalId)}`,
    `--tentacle-id ${shellSingleQuote(tentacleId)}`,
    `--parent-terminal-id ${shellSingleQuote(parentTerminalId)}`,
    `--workspace-mode ${workspaceMode}`,
    `--name ${shellSingleQuote(tentacleName)}`,
    "--name-origin generated",
    `--auto-rename-prompt-context ${shellSingleQuote(todoText)}`,
    "--prompt-template swarm-worker",
    `--prompt-variables ${shellSingleQuote(variablesJson)}`,
  ];
  if (workspaceMode === "worktree") {
    commandParts.splice(3, 0, `--worktree-id ${shellSingleQuote(workerTerminalId)}`);
  }
  return commandParts.join(" ");
};

/**
 * Pure planning function: given a tentacle, its incomplete todos, and the
 * desired workspace mode, return the structured `SwarmPlan` that the route
 * handler (or any other caller, including a tentacle agent) needs in order
 * to spawn the swarm.
 *
 * Behavior:
 * - More than one todo => one parent coordinator + one worker per todo, with
 *   the parent's prompt containing the literal CLI commands to spawn each
 *   worker. The route handler creates only the parent terminal; the parent
 *   spawns the workers itself.
 * - Exactly one todo => no parent. One worker terminal that runs directly.
 * - Zero todos => an empty plan (workers=[], parent=null).
 *
 * Todo overflow above `maxChildrenPerParent` is deferred (todo order is
 * priority order). The deferred indices are surfaced on the plan.
 *
 * The function does no I/O. No prompt resolution, no terminal creation, no
 * filesystem reads. It is safe to call from a preview endpoint.
 */
export const planSwarm = (input: SwarmPlanInput): SwarmPlan => {
  const {
    tentacleId,
    tentacleName,
    tentacleContextPath,
    todos,
    workerWorkspaceMode,
    baseRef,
    parentBaseBranch,
    apiPort,
    maxChildrenPerParent,
  } = input;

  const apiPortString = typeof apiPort === "number" ? String(apiPort) : apiPort;
  const targets = todos.slice(0, maxChildrenPerParent);
  const deferredTodoIndices = todos.slice(maxChildrenPerParent).map((t) => t.index);

  if (targets.length === 0) {
    return {
      tentacleId,
      tentacleName,
      workers: [],
      parent: null,
      baseRef,
      workerWorkspaceMode,
      deferredTodoIndices,
    };
  }

  const needsParent = targets.length > 1;
  const parentTerminalId = needsParent ? `${tentacleId}-swarm-parent` : null;

  const workers: SwarmWorkerSpec[] = targets.map((todo) => {
    const workerTerminalId = `${tentacleId}-swarm-${todo.index}`;
    const promptVariables = buildWorkerPromptVariables({
      tentacleName,
      tentacleId,
      tentacleContextPath,
      todoText: todo.text,
      terminalId: workerTerminalId,
      apiPort: apiPortString,
      workspaceMode: workerWorkspaceMode,
      parentTerminalId,
    });
    return {
      terminalId: workerTerminalId,
      todoIndex: todo.index,
      todoText: todo.text,
      workspaceMode: workerWorkspaceMode,
      ...(workerWorkspaceMode === "worktree" ? { worktreeId: workerTerminalId } : {}),
      ...(parentTerminalId ? { parentTerminalId } : {}),
      ...(workerWorkspaceMode === "worktree" ? { baseRef } : {}),
      promptTemplate: "swarm-worker" as const,
      promptVariables,
      tentacleName,
      autoRenamePromptContext: todo.text,
    };
  });

  if (!needsParent || !parentTerminalId) {
    return {
      tentacleId,
      tentacleName,
      workers,
      parent: null,
      baseRef,
      workerWorkspaceMode,
      deferredTodoIndices,
    };
  }

  const workerListing = workers
    .map((w) => `- \`${w.terminalId}\` — item #${w.todoIndex}: ${w.todoText}`)
    .join("\n");

  const workerSpawnCommands = workers
    .map((w) => {
      const command = buildWorkerSpawnCommand({
        workerTerminalId: w.terminalId,
        tentacleId,
        parentTerminalId,
        tentacleName,
        todoText: w.todoText,
        workspaceMode: workerWorkspaceMode,
        promptVariables: w.promptVariables,
      });
      return `- \`${w.terminalId}\`:\n  \`\`\`bash\n  ${command}\n  \`\`\``;
    })
    .join("\n");

  const parent: SwarmParentSpec = {
    terminalId: parentTerminalId,
    workspaceMode: "shared",
    promptTemplate: "swarm-parent" as const,
    tentacleName: `${tentacleName} (coordinator)`,
    promptVariables: {
      tentacleName,
      tentacleId,
      workerCount: String(workers.length),
      maxChildrenPerParent: String(maxChildrenPerParent),
      workerListing,
      workerWorkspaceSection: buildWorkerWorkspaceSection(workerWorkspaceMode, workers),
      workerSpawnCommands,
      completionStrategySection: buildCompletionStrategySection(
        workerWorkspaceMode,
        workers.length,
        parentBaseBranch,
        tentacleId,
      ),
      baseBranch: parentBaseBranch,
      terminalId: parentTerminalId,
      apiPort: apiPortString,
    },
  };

  return {
    tentacleId,
    tentacleName,
    workers,
    parent,
    baseRef,
    workerWorkspaceMode,
    deferredTodoIndices,
  };
};
