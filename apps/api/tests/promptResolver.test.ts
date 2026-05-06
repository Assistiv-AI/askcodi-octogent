import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  interpolatePrompt,
  listPromptTemplates,
  readPromptTemplate,
  resolvePrompt,
} from "../src/prompts";

describe("interpolatePrompt", () => {
  it("replaces known variables", () => {
    const result = interpolatePrompt("Hello {{name}}, welcome to {{place}}.", {
      name: "Alice",
      place: "Octogent",
    });
    expect(result).toBe("Hello Alice, welcome to Octogent.");
  });

  it("leaves unknown placeholders intact", () => {
    const result = interpolatePrompt("{{known}} and {{unknown}}", { known: "yes" });
    expect(result).toBe("yes and {{unknown}}");
  });

  it("handles templates with no placeholders", () => {
    const result = interpolatePrompt("No variables here.", { foo: "bar" });
    expect(result).toBe("No variables here.");
  });
});

describe("readPromptTemplate", () => {
  let promptsDir: string;

  beforeEach(async () => {
    promptsDir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  });

  afterEach(async () => {
    await rm(promptsDir, { recursive: true, force: true });
  });

  it("reads an existing template file", async () => {
    await writeFile(join(promptsDir, "greeting.md"), "Hello {{name}}!\n");
    const result = await readPromptTemplate(promptsDir, "greeting");
    expect(result).toBe("Hello {{name}}!");
  });

  it("returns undefined for missing templates", async () => {
    const result = await readPromptTemplate(promptsDir, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("rejects path traversal attempts", async () => {
    const result = await readPromptTemplate(promptsDir, "../etc/passwd");
    expect(result).toBeUndefined();
  });
});

describe("resolvePrompt", () => {
  let promptsDir: string;

  beforeEach(async () => {
    promptsDir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  });

  afterEach(async () => {
    await rm(promptsDir, { recursive: true, force: true });
  });

  it("reads and interpolates a template", async () => {
    await writeFile(join(promptsDir, "tentacle-init.md"), "You are the {{tentacleId}} agent.");
    const result = await resolvePrompt(promptsDir, "tentacle-init", {
      tentacleId: "sandbox",
    });
    expect(result).toBe("You are the sandbox agent.");
  });

  it("returns undefined for missing templates", async () => {
    const result = await resolvePrompt(promptsDir, "missing", { tentacleId: "x" });
    expect(result).toBeUndefined();
  });

  it("prepends octoboss-base for octoboss-* prompts when base exists", async () => {
    await writeFile(join(promptsDir, "octoboss-base.md"), "MANAGER PERSONA");
    await writeFile(
      join(promptsDir, "octoboss-reorganize-todos.md"),
      "Reorganize todos for {{tentacleId}}.",
    );

    const result = await resolvePrompt(promptsDir, "octoboss-reorganize-todos", {
      tentacleId: "alpha",
    });

    expect(result).toBe("MANAGER PERSONA\n\nReorganize todos for alpha.");
  });

  it("does not prepend itself when resolving octoboss-base directly", async () => {
    await writeFile(join(promptsDir, "octoboss-base.md"), "MANAGER PERSONA");

    const result = await resolvePrompt(promptsDir, "octoboss-base", {});

    expect(result).toBe("MANAGER PERSONA");
  });

  it("returns the specific octoboss prompt alone when octoboss-base is missing", async () => {
    await writeFile(join(promptsDir, "octoboss-clean-contexts.md"), "Clean contexts.");

    const result = await resolvePrompt(promptsDir, "octoboss-clean-contexts", {});

    expect(result).toBe("Clean contexts.");
  });

  it("does not prepend for non-octoboss prompts", async () => {
    await writeFile(join(promptsDir, "octoboss-base.md"), "MANAGER PERSONA");
    await writeFile(join(promptsDir, "tentacle-planner.md"), "Plan for {{tentacleId}}.");

    const result = await resolvePrompt(promptsDir, "tentacle-planner", {
      tentacleId: "beta",
    });

    expect(result).toBe("Plan for beta.");
  });

  it("returns undefined when an octoboss-* prompt does not exist, even if base does", async () => {
    await writeFile(join(promptsDir, "octoboss-base.md"), "MANAGER PERSONA");

    const result = await resolvePrompt(promptsDir, "octoboss-doesnt-exist", {});

    expect(result).toBeUndefined();
  });
});

describe("listPromptTemplates", () => {
  let promptsDir: string;

  beforeEach(async () => {
    promptsDir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  });

  afterEach(async () => {
    await rm(promptsDir, { recursive: true, force: true });
  });

  it("lists template names without .md extension", async () => {
    await writeFile(join(promptsDir, "alpha.md"), "a");
    await writeFile(join(promptsDir, "beta.md"), "b");
    await writeFile(join(promptsDir, "readme.txt"), "ignored");

    const names = await listPromptTemplates(promptsDir);
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });

  it("returns empty array when directory does not exist", async () => {
    const names = await listPromptTemplates("/tmp/nonexistent-workspace");
    expect(names).toEqual([]);
  });
});
