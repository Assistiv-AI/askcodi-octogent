# Octoboss rollout — status and remaining work

Living checkpoint for the multi-PR rollout that turns Octoboss into the autonomous router for tentacles, with multi-repo workspaces, tentacle-owned worktrees, and structured agent-to-agent messaging.

Read this top-to-bottom when picking the work back up. Each section says what shipped, what's deferred, and where to start next.

---

## Vision (one sentence)

Octoboss decides what to do, tentacles do the work, and tentacles can self-orchestrate swarms inside their own repo worktrees with structured channel messages between agents.

## Architecture decisions locked in

- **A. `.octogent/` lives at the workspace folder.** When the workspace folder is itself a git repo, append to its `.gitignore`. When it is a parent of repos, append `.octogent/` to each child repo's `.git/info/exclude` so neither the parent folder nor any child commits workspace state. **Implemented in PR1.**
- **B. Tentacle owns one integration worktree per repo on `octogent/<tentacleId>`.** Workers spawn off the tentacle branch onto sub-branches `octogent/<tentacleId>/worker-<n>` with sparse checkout limited to predicted scope, merging back into the tentacle branch on DONE. Tentacle branch is the user-visible merge target. **Worktree path scheme deferred to PR4.5; sparse-worker setup is PR5 (depends on Octoboss predictions).**
- **C. Workers are partitioned by predicted file overlap.** Octoboss emits per-todo file scope predictions; the planner runs greedy bin-packing to minimize cross-bin overlap. **Predictions are PR5; the planner extraction landed in PR2.**
- **D. Octoboss is per-request only in v1.** No long-lived daemon; each user request triggers one decision call (route or create). Persistent watchers are explicitly out of scope.
- **E. Channel messages carry a structured type.** `DONE | BLOCKED | ASSIGN | INFO`. Inferred from a leading prefix when not explicit. **Implemented in PR3.**

---

## Done

### PR1 — Multi-repo workspace foundation

Files: `apps/api/src/workspace/repos.ts` (new), `apps/api/src/projectPersistence.ts`, `apps/api/src/cli.ts`.
Tests: `apps/api/tests/workspaceRepos.test.ts` (23), `apps/api/tests/projectPersistenceExclude.test.ts` (5).

- `WorkspaceRepos` adapter: `discoverRepos`, `loadRepoRegistry`, `saveRepoRegistry`, `reconcileRepoRegistry`, `createWorkspaceRepos()` factory exposing `list/getByName/findByPath/gitRoot/refresh`. Bounded one-level discovery, refuses symlinks.
- `ensureOctogentExcludedFromRepos(repos)` writes `.octogent/` to each repo's `.git/info/exclude` (resolved via `git rev-parse --git-path` so worktree-pointer setups also work).
- `octogent init` calls both `ensureOctogentGitignoreEntry(workspaceCwd)` and `ensureOctogentExcludedFromRepos(discoverRepos(workspaceCwd))`.

### PR2 — Swarm planner extraction + preview endpoint

Files: `apps/api/src/swarmPlanner/index.ts` (new), `apps/api/src/createApiServer/swarmPlanRoutes.ts` (new), `apps/api/src/createApiServer/requestHandler.ts`, `apps/api/src/createApiServer/deckRoutes.ts`.
Tests: `apps/api/tests/swarmPlanner.test.ts` (16) + 6 endpoint tests in `createApiServer.test.ts`.

- Pure `planSwarm(input)` returns `SwarmPlan = {workers, parent, baseRef, deferredTodoIndices}`. No I/O.
- `POST /api/swarm-plans` preview endpoint: identical input shape to the spawn route, returns the plan without creating any terminals or resolving prompts. Used by Octoboss (PR5) and tentacle agents that want to self-spawn.
- `handleDeckTentacleSwarmRoute` rewritten to call `planSwarm`. Removed ~140 lines of inline string-building. Existing `limits swarm prompts to the top-priority items that fit under the child cap` test still passes byte-for-byte against the same 201 response shape.

### PR3 — Structured channel envelope

Files: `packages/core/src/domain/channel.ts`, `apps/api/src/terminalRuntime/channelMessaging.ts`, `apps/api/src/createApiServer/miscRoutes.ts`, `apps/api/src/cli.ts`.
Tests: `packages/core/tests/channel.test.ts` (11) + 5 channel-route tests in `createApiServer.test.ts`.

- `ChannelMessageType = "DONE" | "BLOCKED" | "ASSIGN" | "INFO"`, `CHANNEL_MESSAGE_TYPES`, `isChannelMessageType`, optional `type` field on `ChannelMessage`.
- `parseChannelMessageEnvelope(content)` infers `{type, body}` from a leading `DONE: `, `BLOCKED: `, `ASSIGN: `, or `INFO: ` prefix. Defaults to `INFO`.
- `sendChannelMessage(toId, fromId, content, explicitType?)`: explicit type wins; otherwise infer. Stored `content` is unchanged so existing prompts that grep `DONE:` keep working. The typed field is for new consumers (Octoboss router, swarm parent auto-cleanup, future UI badges).
- `POST /api/channels/<id>/messages` accepts `type` in body; rejects unknown types with 400.
- `octogent channel send <id> <msg> [--from X] [--type DONE|BLOCKED|ASSIGN|INFO]`.

### PR4 — Commit 1 of 3 only: multi-repo plumbing into the runtime

Files: `apps/api/src/terminalRuntime/worktreeManager.ts`, `apps/api/src/terminalRuntime.ts`, `apps/api/src/terminalRuntime/types.ts`, `apps/api/src/workspace/repos.ts`.

- `worktreeManager` now takes `WorkspaceRepos` alongside `workspaceCwd`. Each git op resolves the target repo via `workspaceRepos.gitRoot(repoName?)`.
- `createTentacleWorktree(tentacleId, baseRefOrOptions)` accepts `{baseRef, repoName}`. Back-compat shim preserves the old `(tentacleId, baseRef)` string call.
- `removeTentacleWorktree(tentacleId, {bestEffort, repoName})`.
- `PersistedTerminal.worktreeRepoName?` records which repo a terminal's worktree (or shared cwd) belongs to.
- `CreateTerminalRuntimeOptions.workspaceRepos?` lets tests inject a fake adapter.
- Lazy persistence: `reconcileRepoRegistry` no longer creates `repos.json` for an empty workspace with no prior registry. Brand-new workspaces stay clean on disk until something is registered.
- Single-repo / no-discovered-repos legacy behavior preserved: `resolveRepoCwd(undefined)` falls back to `workspaceCwd` so legacy callers and the test FakeGitClient path keep working.

**Verification across all done work:** 212 api tests, 14 core tests, full build clean. The `reports file-backed workspace setup status` test still passes, which means the new runtime no longer eagerly creates `.octogent/` on construction.

---

## Remaining work

### PR4.5 — Tentacle-owned integration worktrees + auto-cleanup

This is the user-visible "tentacles own worktrees" model.

#### Task 1: Tentacle integration worktree path scheme
**What:** Add a parallel API on `worktreeManager` for tentacle-scoped worktrees living at `<workspaceCwd>/.octogent/tentacles/<tentacleId>/worktrees/<repoName>/` on branch `octogent/<tentacleId>`. New methods alongside the existing per-terminal ones.
**Where to start:** `apps/api/src/terminalRuntime/worktreeManager.ts`. New: `createTentacleIntegrationWorktree({tentacleId, repoName, baseRef})`, `removeTentacleIntegrationWorktree({tentacleId, repoName})`, `listTentacleIntegrationWorktrees(tentacleId)`. New constant in `constants.ts` for the relative path `.octogent/tentacles`. Tests in a new `apps/api/tests/tentacleIntegrationWorktree.test.ts`.
**Why parallel API and not a path-scheme rewrite:** Existing terminals on disk reference `.octogent/worktrees/<terminalId>/` and would break if we changed the scheme. New concept coexists; the swarm flip in Task 4 wires workers to use the new scheme.

#### Task 2: Tentacle config records which repos it owns worktrees for
**What:** Extend the tentacle metadata so a tentacle can declare which repos it has integration worktrees in. Used by the swarm route, the deletion path, and the UI.
**Where to start:** `apps/api/src/deck/readDeckTentacles.ts` (search for `DeckTentacle` shape). Add `worktrees?: Array<{repoName: string; createdAt: string}>`. Persist via the existing deck mechanism. Add API: `POST /api/deck/tentacles/<id>/worktrees {repoName}` and `DELETE /api/deck/tentacles/<id>/worktrees/<repoName>`. Each calls into the worktreeManager methods from Task 1.

#### Task 3: Auto-cleanup on DONE
**What:** When a worker terminal sends a `type === "DONE"` channel message and the terminal is a swarm worker (i.e. its `parentTerminalId` is set), clean up the worker's worktree and branch.
**Where to start:** `apps/api/src/terminalRuntime/channelMessaging.ts` — emit a typed event when a DONE message is queued. Or simpler: extend `sendChannelMessage` to call a `onWorkerDone(workerTerminalId)` hook injected at construction. The hook calls `worktreeManager.removeTentacleWorktree(workerTerminalId, {bestEffort: true})`. Tests confirm: send DONE → worktree removed; send INFO → no-op; send DONE from a non-worker → no-op.
**Depends on:** PR3's typed envelope (already shipped).

#### Task 4: Swarm route flip to use tentacle integration worktrees
**What:** Rewrite the multi-worker path in `handleDeckTentacleSwarmRoute` so workers spawn sub-worktrees off the tentacle integration branch (`octogent/<tentacleId>/worker-<n>`) instead of standalone branches.
**Where to start:** `apps/api/src/createApiServer/deckRoutes.ts` swarm route. Before spawning workers, ensure the tentacle has an integration worktree per repo it owns. Worker baseRef becomes `octogent/<tentacleId>` (the tentacle branch) instead of `HEAD` or the previous fallback. Worker branch becomes `octogent/<tentacleId>/worker-<n>` instead of `octogent/<terminalId>`. The completion strategy in `swarmPlanner` for worktree mode then merges worker branches into the tentacle branch (not into `main` directly).
**Depends on:** Tasks 1, 2, and the planner update for the new merge target.

### PR5 — Octoboss as router + tentacle self-spawn + sparse worker checkouts

#### Task 5: Octoboss router prompt + endpoint
**What:** A new prompt `prompts/octoboss-router.md` and a server-side handler `apps/api/src/octoboss/router.ts` that, given a user request and the current set of tentacles, returns one of `{routedTo: tentacleId} | {createTentacle: {name, description}} | {needClarification: question}`. The web UI's main entry-point becomes "talk to Octoboss" instead of "click a tentacle".
**Where to start:** Define the JSON shape of the LLM call's expected output. Implement a small parser. Validate the routed tentacleId exists. Surface `needClarification` as a channel message back to the user (no half-state).

#### Task 6: Tentacle self-spawn capability
**What:** Tentacle agents call `POST /api/swarm-plans` (already exists from PR2) to plan, then call `POST /api/terminals` per worker to spawn. No human swarm-button click needed. Add a tentacle prompt that includes the literal commands to do this.
**Where to start:** New prompt `prompts/tentacle-orchestrator.md` (or extend `tentacle-planner.md`) describing the swarm-plan → spawn flow. Tentacle session that opens with a pending todo list optionally goes through this prompt.

#### Task 7: File-overlap partitioner with sparse checkouts
**What:** Octoboss router emits per-todo file scope predictions. The swarm planner does greedy bin-packing on file sets to minimize cross-bin overlap. Worker worktrees use `git sparse-checkout init --cone && git sparse-checkout set <paths>` to keep disk usage bounded.
**Where to start:** Extend `SwarmPlanInput` with optional `scopePredictions?: Record<number, string[]>` (todoIndex → predicted file paths). Add `partitionByOverlap(todos, scopePredictions, k)` to `swarmPlanner`. Add `gitClient.setSparseCheckout({cwd, paths})` to the git client interface. Worker creation in the swarm route applies sparse paths when provided.
**Disk-size design:** With sparse, total disk = tentacle worktree (1× full) + per-active-worker (small partial). On worker DONE (Task 3 cleanup) the partial decays. Fall back to non-sparse when predicted scope is unknown or wider than ~30% of repo.

#### Task 8: Web UI surfaces for the new flows
**What:** Empty-state shows just Octoboss centered with "spawn your first tentacle" CTA. Octoboss right-click menu adds Create-tentacle, Spawn-into-tentacle, Send-message. Channel UI shows typed badges (DONE/BLOCKED/ASSIGN/INFO).
**Where to start:** `apps/web/src/components/CanvasPrimaryView.tsx` for the menu, `apps/web/src/App.tsx` for the empty state.

---

## Pre-resume checklist

When you come back to this:

1. `pnpm install` (in case branches changed).
2. `pnpm --filter @octogent/api test && pnpm --filter @octogent/core exec vitest run` — confirm 212 + 14 still green.
3. `pnpm build` — confirm full build clean.
4. Read the next "Task N" you want to do, plus the file paths it points at.
5. Run `/simplify` over the work-in-progress branch to clean up anything sloppy before adding more.

## Files to remove this doc when the rollout is done

After Task 8 ships, delete this file. The information lives in:
- Code at the file paths called out above.
- `docs/concepts/mental-model.md`, `docs/concepts/tentacles.md` (update those alongside the changes).
- Git log of the merged PRs.
