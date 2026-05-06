import { describe, expect, it } from "vitest";

import { parseOctobossDecision } from "../src/octoboss/router";

describe("parseOctobossDecision", () => {
  it("parses a plain JSON routedTo", () => {
    const result = parseOctobossDecision(`{"routedTo": "docs-knowledge"}`);
    expect(result).toEqual({
      ok: true,
      decision: { kind: "route", tentacleId: "docs-knowledge" },
    });
  });

  it("parses a plain JSON createTentacle", () => {
    const result = parseOctobossDecision(
      `{"createTentacle": {"name": "auth", "description": "Auth and sessions"}}`,
    );
    expect(result).toEqual({
      ok: true,
      decision: {
        kind: "create",
        tentacle: { name: "auth", description: "Auth and sessions" },
      },
    });
  });

  it("parses a plain JSON needClarification", () => {
    const result = parseOctobossDecision(`{"needClarification": "Which billing flow?"}`);
    expect(result).toEqual({
      ok: true,
      decision: { kind: "clarify", question: "Which billing flow?" },
    });
  });

  it("extracts JSON from a markdown-fenced code block", () => {
    const result = parseOctobossDecision(
      'Here is my decision:\n```json\n{"routedTo": "docs"}\n```',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision.kind).toBe("route");
  });

  it("extracts JSON embedded in prose", () => {
    const result = parseOctobossDecision(
      'Routing this to docs because it is documentation work. {"routedTo": "docs"} done.',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: "route", tentacleId: "docs" });
    }
  });

  it("rejects when no JSON object is present", () => {
    const result = parseOctobossDecision("I don't know.");
    expect(result.ok).toBe(false);
  });

  it("rejects empty input", () => {
    const result = parseOctobossDecision("");
    expect(result.ok).toBe(false);
  });

  it("rejects when the JSON has no recognized key", () => {
    const result = parseOctobossDecision(`{"foo": "bar"}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exactly one of/);
  });

  it("rejects when multiple keys are set", () => {
    const result = parseOctobossDecision(`{"routedTo": "docs", "needClarification": "?"}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ambiguous/);
  });

  it("rejects routedTo with a non-string value", () => {
    const result = parseOctobossDecision(`{"routedTo": 42}`);
    expect(result.ok).toBe(false);
  });

  it("rejects routedTo with empty string", () => {
    const result = parseOctobossDecision(`{"routedTo": "  "}`);
    expect(result.ok).toBe(false);
  });

  it("rejects createTentacle missing name", () => {
    const result = parseOctobossDecision(`{"createTentacle": {"description": "missing name"}}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/name/);
  });

  it("rejects createTentacle missing description", () => {
    const result = parseOctobossDecision(`{"createTentacle": {"name": "auth"}}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/description/);
  });

  it("rejects when createTentacle is not an object", () => {
    const result = parseOctobossDecision(`{"createTentacle": "auth"}`);
    expect(result.ok).toBe(false);
  });

  it("rejects when needClarification is empty", () => {
    const result = parseOctobossDecision(`{"needClarification": "   "}`);
    expect(result.ok).toBe(false);
  });

  it("trims the parsed values", () => {
    const result = parseOctobossDecision(`{"routedTo": "  docs  "}`);
    expect(result.ok).toBe(true);
    if (result.ok && result.decision.kind === "route") {
      expect(result.decision.tentacleId).toBe("docs");
    }
  });
});
