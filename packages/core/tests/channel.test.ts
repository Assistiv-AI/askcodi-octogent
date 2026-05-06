import { describe, expect, it } from "vitest";
import {
  CHANNEL_MESSAGE_TYPES,
  isChannelMessageType,
  parseChannelMessageEnvelope,
} from "../src/domain/channel";

describe("parseChannelMessageEnvelope", () => {
  it("infers DONE from a leading 'DONE:' prefix and strips it from the body", () => {
    expect(parseChannelMessageEnvelope("DONE: fixed validation")).toEqual({
      type: "DONE",
      body: "fixed validation",
    });
  });

  it("infers BLOCKED from a leading 'BLOCKED:' prefix", () => {
    expect(parseChannelMessageEnvelope("BLOCKED: need access to db")).toEqual({
      type: "BLOCKED",
      body: "need access to db",
    });
  });

  it("infers ASSIGN from a leading 'ASSIGN:' prefix", () => {
    expect(parseChannelMessageEnvelope("ASSIGN: refactor the parser")).toEqual({
      type: "ASSIGN",
      body: "refactor the parser",
    });
  });

  it("respects explicit 'INFO:' prefix", () => {
    expect(parseChannelMessageEnvelope("INFO: just FYI")).toEqual({
      type: "INFO",
      body: "just FYI",
    });
  });

  it("defaults to INFO with the original body when no prefix matches", () => {
    expect(parseChannelMessageEnvelope("plain message no prefix")).toEqual({
      type: "INFO",
      body: "plain message no prefix",
    });
  });

  it("treats unknown prefixes (lowercase, missing colon) as INFO", () => {
    expect(parseChannelMessageEnvelope("done: lowercase")).toEqual({
      type: "INFO",
      body: "done: lowercase",
    });
    expect(parseChannelMessageEnvelope("DONE no colon")).toEqual({
      type: "INFO",
      body: "DONE no colon",
    });
  });

  it("does not crash on empty input", () => {
    expect(parseChannelMessageEnvelope("")).toEqual({ type: "INFO", body: "" });
  });

  it("handles multi-line bodies after the prefix", () => {
    const result = parseChannelMessageEnvelope("DONE: line one\nline two");
    expect(result.type).toBe("DONE");
    expect(result.body).toBe("line one\nline two");
  });
});

describe("isChannelMessageType", () => {
  it("returns true for each known type", () => {
    for (const type of CHANNEL_MESSAGE_TYPES) {
      expect(isChannelMessageType(type)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isChannelMessageType("done")).toBe(false);
    expect(isChannelMessageType("RANDOM")).toBe(false);
    expect(isChannelMessageType("")).toBe(false);
  });

  it("returns false for non-string inputs", () => {
    expect(isChannelMessageType(undefined)).toBe(false);
    expect(isChannelMessageType(null)).toBe(false);
    expect(isChannelMessageType(42)).toBe(false);
  });
});
