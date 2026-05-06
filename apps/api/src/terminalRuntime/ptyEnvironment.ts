import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const createShellEnvironment = (options?: {
  octogentSessionId?: string;
  /** Absolute URL of the API server hosting this PTY session. Set so any
   * child `octogent ...` invocations target this server, not whatever
   * project happens to live under their cwd. */
  apiBaseUrl?: string;
}) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (options?.octogentSessionId) {
    env.OCTOGENT_SESSION_ID = options.octogentSessionId;
  }
  // Absolute path to the running CLI entry. Children invoked from any cwd
  // can `node "$OCTOGENT_BIN" ...` without depending on `bin/octogent`
  // being resolvable from their cwd. argv[1] is the entry script when
  // running `node /path/to/cli.js` or `bin/octogent` (which immediately
  // imports cli.js).
  const argvEntry = process.argv[1];
  if (typeof argvEntry === "string" && argvEntry.length > 0) {
    env.OCTOGENT_BIN = argvEntry;
  }
  if (options?.apiBaseUrl) {
    // The CLI prefers OCTOGENT_API_ORIGIN/OCTOGENT_API_BASE over
    // runtime.json lookup, so children always reach this server.
    env.OCTOGENT_API_BASE = options.apiBaseUrl;
  }
  return env;
};

export const ensureNodePtySpawnHelperExecutable = () => {
  if (process.platform === "win32") {
    return;
  }

  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    const packageDir = dirname(packageJsonPath);
    const helperCandidates = [
      join(packageDir, "build", "Release", "spawn-helper"),
      join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    ];

    for (const helperPath of helperCandidates) {
      if (!existsSync(helperPath)) {
        continue;
      }

      const currentMode = statSync(helperPath).mode;
      if ((currentMode & 0o111) !== 0) {
        continue;
      }

      chmodSync(helperPath, currentMode | 0o755);
    }
  } catch {
    // Let node-pty throw the actionable error if helper lookup/setup fails.
  }
};
