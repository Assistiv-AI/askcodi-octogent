import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOctogentExcludedFromRepos } from "../src/projectPersistence";

const initRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  execSync("git init -q", { cwd: path });
};

describe("ensureOctogentExcludedFromRepos", () => {
  let workspaceCwd: string;

  beforeEach(() => {
    workspaceCwd = mkdtempSync(join(tmpdir(), "exclude-"));
  });

  afterEach(() => {
    rmSync(workspaceCwd, { recursive: true, force: true });
  });

  it("appends `.octogent/` to each repo's .git/info/exclude on first run", () => {
    const alpha = join(workspaceCwd, "alpha");
    const beta = join(workspaceCwd, "beta");
    initRepo(alpha);
    initRepo(beta);

    const result = ensureOctogentExcludedFromRepos([
      { name: "alpha", path: alpha },
      { name: "beta", path: beta },
    ]);

    expect(result.changed).toHaveLength(2);
    for (const repoPath of [alpha, beta]) {
      const exclude = readFileSync(join(repoPath, ".git", "info", "exclude"), "utf-8");
      expect(exclude.split("\n").map((l) => l.trim())).toContain(".octogent/");
    }
  });

  it("is idempotent: running twice does not duplicate the entry", () => {
    const alpha = join(workspaceCwd, "alpha");
    initRepo(alpha);
    ensureOctogentExcludedFromRepos([{ name: "alpha", path: alpha }]);

    const second = ensureOctogentExcludedFromRepos([{ name: "alpha", path: alpha }]);

    expect(second.changed).toEqual([]);
    const exclude = readFileSync(join(alpha, ".git", "info", "exclude"), "utf-8");
    const matches = exclude.split("\n").filter((l) => l.trim() === ".octogent/");
    expect(matches).toHaveLength(1);
  });

  it("preserves any pre-existing exclude content", () => {
    const alpha = join(workspaceCwd, "alpha");
    initRepo(alpha);
    const existing = "# old comment\n*.log\n";
    writeFileSync(join(alpha, ".git", "info", "exclude"), existing, "utf-8");

    ensureOctogentExcludedFromRepos([{ name: "alpha", path: alpha }]);

    const exclude = readFileSync(join(alpha, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain("# old comment");
    expect(exclude).toContain("*.log");
    expect(exclude).toContain(".octogent/");
  });

  it("handles repos with no repos argument by being a no-op", () => {
    const result = ensureOctogentExcludedFromRepos([]);
    expect(result.changed).toEqual([]);
  });

  it("skips a repo whose path is not actually a git repo without throwing", () => {
    const fake = join(workspaceCwd, "not-a-repo");
    mkdirSync(fake, { recursive: true });

    const result = ensureOctogentExcludedFromRepos([{ name: "fake", path: fake }]);

    expect(result.changed).toEqual([]);
    expect(existsSync(join(fake, ".git", "info", "exclude"))).toBe(false);
  });
});
