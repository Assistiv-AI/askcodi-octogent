## Self-orchestrate your todo list

This tentacle has **{{incompleteTodoCount}} incomplete todo(s)** in `{{tentacleContextPath}}/todo.md`. You can either work through them sequentially yourself, or self-spawn a swarm of worker terminals so the work parallelizes.

**Use your judgment.** A single small todo is usually faster done directly. Three or more independent todos benefit from a swarm. Tightly coupled todos that touch the same files are better serialized.

### How to self-spawn workers

You are the parent. You don't need a separate parent terminal — workers report DONE back to you, and the swarm-completion flow (review → merge → cleanup) is your job.

**Step 1: Ensure an integration worktree exists** for this tentacle. The worktree gives workers a stable base branch (`octogent/{{tentacleId}}`) to anchor on. Single-repo workspaces let the server pick the repo automatically:

```bash
curl -s -X POST http://localhost:{{apiPort}}/api/deck/tentacles/{{tentacleId}}/worktrees \
  -H 'Content-Type: application/json' \
  -d '{}'
```

If the workspace has multiple registered repos, the server returns 400 — pass the explicit `repoName` in the body. If an integration worktree already exists, the call returns 400 with "already exists"; that is fine, proceed.

**Step 2: Get a worker plan from the swarm planner.** Read-only:

```bash
PLAN=$(curl -s -X POST http://localhost:{{apiPort}}/api/swarm-plans \
  -H 'Content-Type: application/json' \
  -d '{"tentacleId": "{{tentacleId}}", "workspaceMode": "worktree"}')
echo "$PLAN" | jq .
```

The response contains `workers[]`. Each worker has a `spawnCommand` field that is a ready-to-execute shell command. Ignore the `parent` field — you are the parent.

**Step 3: Spawn each worker.** The `spawnCommand` already passes `--parent-terminal-id "$OCTOGENT_SESSION_ID"`, which resolves to your terminal id when the shell runs the command, so workers correctly report DONE back to you.

```bash
echo "$PLAN" | jq -r '.workers[].spawnCommand' | while read -r cmd; do
  eval "$cmd"
done
```

**Step 4: Wait for DONE messages.** Workers report completion via channel messages with `type=DONE`. The runtime auto-cleans each worker's worktree on DONE. You receive each DONE in your channel queue — review what changed.

**Step 5: Merge into the tentacle integration branch.** Once all workers report DONE:

```bash
# From within the tentacle integration worktree at .octogent/tentacles/{{tentacleId}}/worktrees/<repo>/
git checkout octogent/{{tentacleId}}

# Iterate worker branches safely (handles the no-match case).
git for-each-ref --format='%(refname:short)' "refs/heads/octogent/{{tentacleId}}/worker-*" \
  | while read -r worker_branch; do
      git merge "$worker_branch" --no-edit  # resolve conflicts manually if needed
    done
```

**Step 6: Update tentacle docs.** Mark completed items as `- [x]` in `{{tentacleContextPath}}/todo.md`. Update `{{tentacleContextPath}}/CONTEXT.md` if the merged work changed assumptions documented there.

### When NOT to swarm

- Single todo: just do it.
- Todos that all touch the same one or two files: serialize, swarms create merge conflicts.
- Exploratory or undefined work: serialize, scope the work first.

### Ground rules

- Do not create more than 9 workers (server cap).
- Do not edit `.octogent/state/*` directly — the runtime owns it.
- Do not delete worker terminals manually before they DONE. Auto-cleanup fires on DONE.
