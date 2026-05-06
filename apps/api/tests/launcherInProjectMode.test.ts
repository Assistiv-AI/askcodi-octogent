import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-pty", () => ({
  spawn: vi.fn(),
}));

import { createApiServer } from "../src/createApiServer";
import {
  ensureProjectScaffold,
  registerProject,
  resolveGlobalProjectDir,
} from "../src/projectPersistence";

let originalHome: string | undefined;
let homeRoot: string;
let workRoot: string;
let stopServer: (() => Promise<void>) | null = null;

beforeEach(() => {
  homeRoot = mkdtempSync(join(tmpdir(), "octogent-launcher-pm-home-"));
  workRoot = mkdtempSync(join(tmpdir(), "octogent-launcher-pm-work-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeRoot;
});

afterEach(async () => {
  if (stopServer) {
    await stopServer();
    stopServer = null;
  }
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    process.env.HOME = undefined;
  }
  rmSync(homeRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

const startProjectServer = async () => {
  const workspaceCwd = join(workRoot, "host");
  mkdirSync(workspaceCwd);
  const config = ensureProjectScaffold(workspaceCwd, "Host");
  const projectStateDir = resolveGlobalProjectDir(config.projectId);
  registerProject(workspaceCwd, "Host");

  const server = createApiServer({ workspaceCwd, projectStateDir });
  const address = await server.start(0, "127.0.0.1");
  stopServer = () => server.stop();
  return {
    baseUrl: `http://${address.host}:${address.port}`,
    workspaceCwd,
    projectId: config.projectId,
  };
};

describe("launcher routes in project mode", () => {
  it("/api/launcher/info returns mode=project and the host project's id", async () => {
    const { baseUrl, workspaceCwd, projectId } = await startProjectServer();

    const response = await fetch(`${baseUrl}/api/launcher/info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.mode).toBe("project");
    expect(body.cwd).toBe(workspaceCwd);
    expect(body.cwdIsInitialized).toBe(true);
    expect(body.cwdProjectName).toBe("Host");
    expect(body.cwdProjectId).toBe(projectId);
  });

  it("/api/launcher/projects returns the registered list", async () => {
    const { baseUrl } = await startProjectServer();
    const sibling = join(workRoot, "sibling");
    mkdirSync(sibling);
    registerProject(sibling, "Sibling");

    const response = await fetch(`${baseUrl}/api/launcher/projects`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: Array<Record<string, unknown>> };
    const names = body.projects.map((p) => p.name);
    expect(names).toContain("Host");
    expect(names).toContain("Sibling");
  });

  it("POST /api/launcher/projects creates a new project", async () => {
    const { baseUrl } = await startProjectServer();
    const newPath = join(workRoot, "new-project");
    mkdirSync(newPath);

    const response = await fetch(`${baseUrl}/api/launcher/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: newPath, name: "New Project" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { entry?: Record<string, unknown> };
    expect(body.entry?.path).toBe(newPath);
    expect(body.entry?.name).toBe("New Project");
  });

  it("POST /api/launcher/projects/:id/open returns 404 for unknown ids", async () => {
    const { baseUrl } = await startProjectServer();
    const response = await fetch(`${baseUrl}/api/launcher/projects/does-not-exist/open`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  it("DELETE /api/launcher/projects/:id removes a registered project", async () => {
    const { baseUrl } = await startProjectServer();
    const sibling = join(workRoot, "byebye");
    mkdirSync(sibling);
    const entry = registerProject(sibling, "Byebye");

    const response = await fetch(
      `${baseUrl}/api/launcher/projects/${encodeURIComponent(entry.id)}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);

    const list = await fetch(`${baseUrl}/api/launcher/projects`);
    const body = (await list.json()) as { projects: Array<Record<string, unknown>> };
    const names = body.projects.map((p) => p.name);
    expect(names).not.toContain("Byebye");
  });

  it("DELETE /api/launcher/projects/:id returns 404 for unknown ids", async () => {
    const { baseUrl } = await startProjectServer();
    const response = await fetch(`${baseUrl}/api/launcher/projects/unknown`, { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});
