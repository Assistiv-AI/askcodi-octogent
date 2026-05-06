import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DeckTentacleSummary } from "@octogent/core";

import {
  DEFAULT_OCTOPUS_APPEARANCE,
  DEFAULT_TENTACLE_COLOR,
  addTodoItem,
  createDeckTentacle,
} from "../deck/readDeckTentacles";
import { TENTACLES_RELATIVE_PATH } from "../terminalRuntime/constants";

/**
 * Internal discriminated union after parsing the LLM's literal output shape
 * (`{routedTo}` / `{createTentacle}` / `{needClarification}`).
 */
export type OctobossDecision =
  | { kind: "route"; tentacleId: string }
  | { kind: "create"; tentacle: { name: string; description: string } }
  | { kind: "clarify"; question: string };

export type ParseDecisionResult =
  | { ok: true; decision: OctobossDecision }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Try `JSON.parse` on the trimmed input; if that yields a non-object value
 * (array, primitive, null), or if it throws, fall back to slicing between the
 * first `{` and last `}` (handles markdown code fences and prose wrapping).
 * Returns the parsed object or `undefined`. */
const extractJsonObject = (raw: string): Record<string, unknown> | undefined => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  try {
    const direct = JSON.parse(trimmed);
    if (isRecord(direct)) return direct;
  } catch {
    // fall through
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return undefined;

  try {
    const sliced = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    return isRecord(sliced) ? sliced : undefined;
  } catch {
    return undefined;
  }
};

export const parseOctobossDecision = (raw: string): ParseDecisionResult => {
  const parsed = extractJsonObject(raw);
  if (parsed === undefined) {
    return { ok: false, error: "llmOutput did not contain a JSON object." };
  }

  const presentKeys = ["routedTo", "createTentacle", "needClarification"].filter(
    (key) => parsed[key] !== undefined && parsed[key] !== null,
  );
  if (presentKeys.length === 0) {
    return {
      ok: false,
      error: "Decision must include exactly one of: routedTo, createTentacle, needClarification.",
    };
  }
  if (presentKeys.length > 1) {
    return {
      ok: false,
      error: `Decision is ambiguous: multiple keys set (${presentKeys.join(", ")}).`,
    };
  }

  if (typeof parsed.routedTo === "string") {
    const tentacleId = parsed.routedTo.trim();
    if (tentacleId.length === 0) {
      return { ok: false, error: "routedTo must be a non-empty string." };
    }
    return { ok: true, decision: { kind: "route", tentacleId } };
  }

  if (parsed.createTentacle !== undefined) {
    if (!isRecord(parsed.createTentacle)) {
      return { ok: false, error: "createTentacle must be an object." };
    }
    const { name, description } = parsed.createTentacle;
    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, error: "createTentacle.name is required." };
    }
    if (typeof description !== "string") {
      return { ok: false, error: "createTentacle.description is required." };
    }
    return {
      ok: true,
      decision: {
        kind: "create",
        tentacle: { name: name.trim(), description: description.trim() },
      },
    };
  }

  if (typeof parsed.needClarification === "string") {
    const question = parsed.needClarification.trim();
    if (question.length === 0) {
      return { ok: false, error: "needClarification must be a non-empty string." };
    }
    return { ok: true, decision: { kind: "clarify", question } };
  }

  // The presentKeys gate ensured exactly one recognized key exists, but its
  // value type was wrong (e.g. `routedTo: 42`, `needClarification: 7`).
  return { ok: false, error: "Decision value did not match the expected type." };
};

/** Domain-layer result. Route handler maps `kind` to HTTP status. */
export type ExecuteDecisionResult =
  | { kind: "routed"; tentacleId: string; todoTotal: number; todoDone: number }
  | { kind: "created"; tentacle: DeckTentacleSummary }
  | { kind: "clarification"; question: string }
  | { kind: "not-found"; tentacleId: string }
  | { kind: "create-failed"; reason: string }
  | { kind: "append-failed"; tentacleId: string };

export type ExecuteDecisionParams = {
  workspaceCwd: string;
  projectStateDir: string;
  userRequest: string;
  decision: OctobossDecision;
};

/** Returns true if a tentacle directory with a `CONTEXT.md` exists for the
 * given id. O(1) check that avoids the much heavier `readDeckTentacles` scan. */
const tentacleExistsOnDisk = (workspaceCwd: string, tentacleId: string): boolean => {
  // addTodoItem applies the same path-segment validation, but checking here
  // first lets us return a clean "not-found" without depending on side effects.
  if (tentacleId.includes("..") || tentacleId.includes("/")) return false;
  return existsSync(join(workspaceCwd, TENTACLES_RELATIVE_PATH, tentacleId, "CONTEXT.md"));
};

export const executeOctobossDecision = (params: ExecuteDecisionParams): ExecuteDecisionResult => {
  const { workspaceCwd, projectStateDir, userRequest, decision } = params;

  if (decision.kind === "clarify") {
    return { kind: "clarification", question: decision.question };
  }

  if (decision.kind === "route") {
    if (!tentacleExistsOnDisk(workspaceCwd, decision.tentacleId)) {
      return { kind: "not-found", tentacleId: decision.tentacleId };
    }
    const progress = addTodoItem(workspaceCwd, decision.tentacleId, userRequest);
    if (!progress) {
      return { kind: "append-failed", tentacleId: decision.tentacleId };
    }
    return {
      kind: "routed",
      tentacleId: decision.tentacleId,
      todoTotal: progress.total,
      todoDone: progress.done,
    };
  }

  // decision.kind === "create"
  const result = createDeckTentacle(
    workspaceCwd,
    {
      name: decision.tentacle.name,
      description: decision.tentacle.description,
      color: DEFAULT_TENTACLE_COLOR,
      octopus: DEFAULT_OCTOPUS_APPEARANCE,
    },
    projectStateDir,
  );
  if (!result.ok) {
    return { kind: "create-failed", reason: result.error };
  }
  // Seed the new tentacle's todo.md with the user's request. createDeckTentacle
  // already wrote a fresh todo.md, so a transient append failure here only
  // loses the seed, not the tentacle itself.
  addTodoItem(workspaceCwd, result.tentacle.tentacleId, userRequest);
  return { kind: "created", tentacle: result.tentacle };
};
