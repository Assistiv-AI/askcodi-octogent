import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLauncherServer } from "../src/launcher/createLauncherServer";
import { registerProject } from "../src/projectPersistence";

let originalHome: string | undefined;
let homeRoot: string;
let workRoot: string;

beforeEach(() => {
  homeRoot = mkdtempSync(join(tmpdir(), "octogent-launcher-srv-home-"));
  workRoot = mkdtempSync(join(tmpdir(), "octogent-launcher-srv-work-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeRoot;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    process.env.HOME = undefined;
  }
  rmSync(homeRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

const startServer = async (invocationCwd: string) => {
  const server = createLauncherServer({ invocationCwd });
  const { host, port } = await server.start(0, "127.0.0.1");
  return { server, baseUrl: `http://${host}:${port}` };
};

describe("launcher server", () => {
  it("reports launcher mode and cwd state", async () => {
    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(`${baseUrl}/api/launcher/info`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.mode).toBe("launcher");
      expect(body.cwd).toBe(workRoot);
      expect(body.cwdIsInitialized).toBe(false);
      expect(body.cwdProjectName).toBe(null);
    } finally {
      await server.stop();
    }
  });

  it("lists registered projects", async () => {
    const projectPath = join(workRoot, "alpha");
    mkdirSync(projectPath);
    registerProject(projectPath, "Alpha");

    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(`${baseUrl}/api/launcher/projects`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { projects: Array<Record<string, unknown>> };
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0]?.path).toBe(projectPath);
      expect(body.projects[0]?.name).toBe("Alpha");
      expect(body.projects[0]?.exists).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("creates a project on POST and returns the entry", async () => {
    const projectPath = join(workRoot, "beta");
    mkdirSync(projectPath);

    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(`${baseUrl}/api/launcher/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: projectPath, name: "Beta" }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { entry?: Record<string, unknown> };
      expect(body.entry?.path).toBe(projectPath);
      expect(body.entry?.name).toBe("Beta");
    } finally {
      await server.stop();
    }
  });

  it("rejects POST with invalid path", async () => {
    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(`${baseUrl}/api/launcher/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "" }),
      });
      expect(response.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for missing folder on POST", async () => {
    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(`${baseUrl}/api/launcher/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: join(workRoot, "missing") }),
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("removes a registered project on DELETE", async () => {
    const projectPath = join(workRoot, "gamma");
    mkdirSync(projectPath);
    const entry = registerProject(projectPath, "Gamma");

    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(
        `${baseUrl}/api/launcher/projects/${encodeURIComponent(entry.id)}`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);

      const list = await fetch(`${baseUrl}/api/launcher/projects`);
      const body = (await list.json()) as { projects: unknown[] };
      expect(body.projects).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for unknown project on DELETE", async () => {
    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(`${baseUrl}/api/launcher/projects/unknown-id`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("returns 404 from /open for unknown project", async () => {
    const { server, baseUrl } = await startServer(workRoot);
    try {
      const response = await fetch(`${baseUrl}/api/launcher/projects/unknown-id/open`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
