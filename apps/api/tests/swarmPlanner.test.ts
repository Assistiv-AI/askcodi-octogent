import { describe, expect, it } from "vitest";
import { type SwarmPlanInput, planSwarm } from "../src/swarmPlanner";

const baseInput = (overrides: Partial<SwarmPlanInput> = {}): SwarmPlanInput => ({
  tentacleId: "api-runtime",
  tentacleName: "API Runtime",
  tentacleContextPath: "/ws/.octogent/tentacles/api-runtime",
  todos: [],
  workerWorkspaceMode: "worktree",
  baseRef: "HEAD",
  parentBaseBranch: "main",
  apiPort: 8787,
  maxChildrenPerParent: 9,
  ...overrides,
});

describe("planSwarm — empty input", () => {
  it("returns an empty plan with no parent and no workers", () => {
    const plan = planSwarm(baseInput({ todos: [] }));

    expect(plan.workers).toEqual([]);
    expect(plan.parent).toBeNull();
    expect(plan.deferredTodoIndices).toEqual([]);
  });
});

describe("planSwarm — single todo", () => {
  it("produces one worker and no parent", () => {
    const plan = planSwarm(
      baseInput({
        todos: [{ index: 2, text: "add request validation" }],
      }),
    );

    expect(plan.parent).toBeNull();
    expect(plan.workers).toHaveLength(1);
    const [worker] = plan.workers;
    expect(worker?.terminalId).toBe("api-runtime-swarm-2");
    expect(worker?.todoIndex).toBe(2);
    expect(worker?.parentTerminalId).toBeUndefined();
    expect(worker?.promptVariables.parentTerminalId).toBe("");
    expect(worker?.promptVariables.parentSection).toBe("");
  });

  it("uses worker terminal ID as the worktree ID in worktree mode", () => {
    const plan = planSwarm(
      baseInput({
        workerWorkspaceMode: "worktree",
        todos: [{ index: 0, text: "x" }],
      }),
    );

    expect(plan.workers[0]?.worktreeId).toBe("api-runtime-swarm-0");
    expect(plan.workers[0]?.baseRef).toBe("HEAD");
  });

  it("does not set worktreeId or baseRef in shared mode", () => {
    const plan = planSwarm(
      baseInput({
        workerWorkspaceMode: "shared",
        todos: [{ index: 0, text: "x" }],
      }),
    );

    expect(plan.workers[0]?.worktreeId).toBeUndefined();
    expect(plan.workers[0]?.baseRef).toBeUndefined();
  });
});

describe("planSwarm — multiple todos", () => {
  const todos = [
    { index: 0, text: "first" },
    { index: 1, text: "second" },
    { index: 2, text: "third" },
  ];

  it("produces a parent and one worker per todo", () => {
    const plan = planSwarm(baseInput({ todos }));

    expect(plan.workers).toHaveLength(3);
    expect(plan.parent).not.toBeNull();
    expect(plan.parent?.terminalId).toBe("api-runtime-swarm-parent");
    expect(plan.parent?.workspaceMode).toBe("shared");
    expect(plan.parent?.tentacleName).toBe("API Runtime (coordinator)");
  });

  it("each worker references the parent terminal ID and has a parentSection", () => {
    const plan = planSwarm(baseInput({ todos }));

    for (const worker of plan.workers) {
      expect(worker.parentTerminalId).toBe("api-runtime-swarm-parent");
      expect(worker.promptVariables.parentTerminalId).toBe("api-runtime-swarm-parent");
      expect(worker.promptVariables.parentSection).toContain("Your parent coordinator");
      expect(worker.promptVariables.parentSection).toContain(
        `node bin/octogent channel send api-runtime-swarm-parent "DONE: ${worker.todoText}"`,
      );
    }
  });

  it("parent prompt variables include the worker listing and spawn commands", () => {
    const plan = planSwarm(baseInput({ todos }));

    expect(plan.parent?.promptVariables.workerCount).toBe("3");
    expect(plan.parent?.promptVariables.maxChildrenPerParent).toBe("9");
    expect(plan.parent?.promptVariables.workerListing).toContain(
      "- `api-runtime-swarm-0` — item #0: first",
    );
    expect(plan.parent?.promptVariables.workerSpawnCommands).toContain(
      "node bin/octogent terminal create",
    );
    expect(plan.parent?.promptVariables.workerSpawnCommands).toContain(
      "--terminal-id 'api-runtime-swarm-0'",
    );
  });

  it("worker spawn commands include --worktree-id only in worktree mode", () => {
    const worktreePlan = planSwarm(baseInput({ todos, workerWorkspaceMode: "worktree" }));
    expect(worktreePlan.parent?.promptVariables.workerSpawnCommands).toContain(
      "--worktree-id 'api-runtime-swarm-0'",
    );

    const sharedPlan = planSwarm(baseInput({ todos, workerWorkspaceMode: "shared" }));
    expect(sharedPlan.parent?.promptVariables.workerSpawnCommands).not.toContain("--worktree-id");
  });
});

describe("planSwarm — overflow above maxChildrenPerParent", () => {
  it("caps workers at maxChildrenPerParent and reports deferred indices in priority order", () => {
    const todos = Array.from({ length: 12 }, (_, i) => ({ index: i, text: `item ${i}` }));

    const plan = planSwarm(baseInput({ todos, maxChildrenPerParent: 9 }));

    expect(plan.workers).toHaveLength(9);
    expect(plan.workers.map((w) => w.todoIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.deferredTodoIndices).toEqual([9, 10, 11]);
  });

  it("returns no deferred indices when todos fit", () => {
    const todos = [
      { index: 0, text: "a" },
      { index: 1, text: "b" },
    ];

    const plan = planSwarm(baseInput({ todos, maxChildrenPerParent: 9 }));

    expect(plan.deferredTodoIndices).toEqual([]);
  });
});

describe("planSwarm — workspace mode affects the completion strategy", () => {
  const todos = [
    { index: 0, text: "a" },
    { index: 1, text: "b" },
  ];

  it("worktree mode mentions per-worker integration branches", () => {
    const plan = planSwarm(baseInput({ todos, workerWorkspaceMode: "worktree" }));
    expect(plan.parent?.promptVariables.completionStrategySection).toContain(
      "Create an integration branch",
    );
    expect(plan.parent?.promptVariables.completionStrategySection).toContain(
      "octogent_integration_api-runtime",
    );
  });

  it("shared mode mentions explicit user approval before commit", () => {
    const plan = planSwarm(baseInput({ todos, workerWorkspaceMode: "shared" }));
    expect(plan.parent?.promptVariables.completionStrategySection).toContain(
      "Wait for explicit user approval",
    );
    expect(plan.parent?.promptVariables.completionStrategySection).not.toContain(
      "octogent_integration_",
    );
  });
});

describe("planSwarm — base ref propagation", () => {
  it("forwards baseRef to worker spec when in worktree mode", () => {
    const plan = planSwarm(
      baseInput({
        baseRef: "octogent/api-runtime",
        todos: [{ index: 0, text: "x" }],
      }),
    );
    expect(plan.workers[0]?.baseRef).toBe("octogent/api-runtime");
  });

  it("uses parentBaseBranch in the parent prompt variables", () => {
    const plan = planSwarm(
      baseInput({
        parentBaseBranch: "develop",
        todos: [
          { index: 0, text: "a" },
          { index: 1, text: "b" },
        ],
      }),
    );
    expect(plan.parent?.promptVariables.baseBranch).toBe("develop");
  });
});

describe("planSwarm — apiPort handling", () => {
  it("accepts apiPort as a number and stringifies for prompt variables", () => {
    const plan = planSwarm(
      baseInput({
        apiPort: 8787,
        todos: [{ index: 0, text: "x" }],
      }),
    );
    expect(plan.workers[0]?.promptVariables.apiPort).toBe("8787");
  });

  it("accepts apiPort as a string and passes through", () => {
    const plan = planSwarm(
      baseInput({
        apiPort: "9090",
        todos: [{ index: 0, text: "x" }],
      }),
    );
    expect(plan.workers[0]?.promptVariables.apiPort).toBe("9090");
  });
});
