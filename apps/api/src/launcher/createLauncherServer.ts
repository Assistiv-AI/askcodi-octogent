import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join } from "node:path";

import { readJsonBody } from "../createApiServer/requestParsers";
import {
  getRequestCorsOrigin,
  isAllowedHostHeader,
  isAllowedOriginHeader,
  readHeaderValue,
  withCors,
} from "../createApiServer/security";
import { logVerbose } from "../logging";
import { loadProjectConfig } from "../projectPersistence";
import {
  createLauncherProject,
  listLauncherProjects,
  openLauncherProject,
  removeLauncherProject,
} from "./launcherCore";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export type CreateLauncherServerOptions = {
  /** The directory the user invoked `octogent` in. Surfaces as "current
   * folder" in the picker so they can initialize and open it. */
  invocationCwd: string;
  webDistDir?: string | undefined;
  allowRemoteAccess?: boolean | undefined;
};

const writeJson = (
  response: ServerResponse,
  status: number,
  payload: unknown,
  corsOrigin: string | null,
) => {
  response.writeHead(status, withCors({ "Content-Type": "application/json" }, corsOrigin));
  response.end(JSON.stringify(payload));
};

const serveStaticFile = async (
  response: ServerResponse,
  webDistDir: string,
  pathname: string,
): Promise<boolean> => {
  const safePath = pathname.replace(/\.\./g, "").replace(/\/+/g, "/");
  const filePath = join(webDistDir, safePath === "/" ? "index.html" : safePath);
  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      console.error(
        `[Launcher] Static file error: ${filePath}`,
        error instanceof Error ? error.message : error,
      );
    }
    return false;
  }
};

const logRequest = (method: string, path: string, status: number, startTime: number) => {
  logVerbose(`[Launcher] ${method} ${path} ${status} ${Date.now() - startTime}ms`);
};

const PROJECT_OPEN_PATH_PATTERN = /^\/api\/launcher\/projects\/([^/]+)\/open$/;
const PROJECT_ITEM_PATH_PATTERN = /^\/api\/launcher\/projects\/([^/]+)$/;

export const createLauncherServer = ({
  invocationCwd,
  webDistDir,
  allowRemoteAccess = false,
}: CreateLauncherServerOptions) => {
  const resolvedWebDistDir = webDistDir && existsSync(webDistDir) ? webDistDir : null;
  let httpServer: ReturnType<typeof createServer> | null = null;
  let activeHost = "127.0.0.1";
  let activePort = 0;

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const startTime = Date.now();
    let statusCode = 0;
    const originalWriteHead = response.writeHead.bind(response);
    response.writeHead = ((...args: Parameters<typeof response.writeHead>) => {
      statusCode = typeof args[0] === "number" ? args[0] : 0;
      return originalWriteHead(...args);
    }) as typeof response.writeHead;

    const originHeader = readHeaderValue(request.headers.origin);
    const hostHeader = readHeaderValue(request.headers.host);
    const corsOrigin = getRequestCorsOrigin(originHeader, allowRemoteAccess);

    if (!isAllowedHostHeader(hostHeader, allowRemoteAccess)) {
      writeJson(response, 403, { error: "Host not allowed." }, null);
      logRequest(request.method ?? "?", request.url ?? "/", 403, startTime);
      return;
    }

    if (!isAllowedOriginHeader(originHeader, allowRemoteAccess)) {
      writeJson(response, 403, { error: "Origin not allowed." }, null);
      logRequest(request.method ?? "?", request.url ?? "/", 403, startTime);
      return;
    }

    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const { pathname } = requestUrl;

      if (request.method === "OPTIONS") {
        response.writeHead(204, withCors({}, corsOrigin));
        response.end();
        logRequest("OPTIONS", pathname, 204, startTime);
        return;
      }

      if (pathname === "/api/launcher/info") {
        if (request.method !== "GET") {
          writeJson(response, 405, { error: "Method not allowed" }, corsOrigin);
        } else {
          const cwdConfig = loadProjectConfig(invocationCwd);
          writeJson(
            response,
            200,
            {
              mode: "launcher",
              host: activeHost,
              port: activePort,
              cwd: invocationCwd,
              cwdIsInitialized: cwdConfig !== null,
              cwdProjectName: cwdConfig?.displayName ?? null,
              cwdProjectId: cwdConfig?.projectId ?? null,
            },
            corsOrigin,
          );
        }
        logRequest(request.method ?? "?", pathname, statusCode, startTime);
        return;
      }

      if (pathname === "/api/launcher/projects") {
        if (request.method === "GET") {
          writeJson(response, 200, { projects: listLauncherProjects() }, corsOrigin);
        } else if (request.method === "POST") {
          const body = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>;
          const path = typeof body.path === "string" ? body.path : "";
          const name = typeof body.name === "string" ? body.name : undefined;
          const result = createLauncherProject({ path, ...(name ? { name } : {}) });
          if (result.kind === "ok") {
            writeJson(response, 201, { entry: result.entry }, corsOrigin);
          } else if (result.kind === "missing-folder") {
            writeJson(response, 404, { error: "Folder does not exist." }, corsOrigin);
          } else {
            writeJson(response, 400, { error: result.reason }, corsOrigin);
          }
        } else {
          writeJson(response, 405, { error: "Method not allowed" }, corsOrigin);
        }
        logRequest(request.method ?? "?", pathname, statusCode, startTime);
        return;
      }

      const openMatch = pathname.match(PROJECT_OPEN_PATH_PATTERN);
      if (openMatch) {
        const projectId = decodeURIComponent(openMatch[1] ?? "");
        if (request.method !== "POST") {
          writeJson(response, 405, { error: "Method not allowed" }, corsOrigin);
        } else {
          const result = await openLauncherProject(projectId);
          if (result.kind === "ok") {
            writeJson(
              response,
              200,
              {
                apiBaseUrl: result.apiBaseUrl,
                alreadyRunning: result.alreadyRunning,
              },
              corsOrigin,
            );
          } else if (result.kind === "not-found") {
            writeJson(response, 404, { error: "Project not found." }, corsOrigin);
          } else if (result.kind === "missing-folder") {
            writeJson(response, 404, { error: "Project folder no longer exists." }, corsOrigin);
          } else if (result.kind === "spawn-failed") {
            writeJson(
              response,
              500,
              { error: `Failed to start project: ${result.reason}` },
              corsOrigin,
            );
          } else {
            writeJson(
              response,
              504,
              { error: "Timed out waiting for project to start." },
              corsOrigin,
            );
          }
        }
        logRequest(request.method ?? "?", pathname, statusCode, startTime);
        return;
      }

      const itemMatch = pathname.match(PROJECT_ITEM_PATH_PATTERN);
      if (itemMatch) {
        const projectId = decodeURIComponent(itemMatch[1] ?? "");
        if (request.method !== "DELETE") {
          writeJson(response, 405, { error: "Method not allowed" }, corsOrigin);
        } else {
          const result = removeLauncherProject(projectId);
          if (result.kind === "ok") {
            writeJson(response, 200, { ok: true }, corsOrigin);
          } else {
            writeJson(response, 404, { error: "Project not found." }, corsOrigin);
          }
        }
        logRequest(request.method ?? "?", pathname, statusCode, startTime);
        return;
      }

      if (resolvedWebDistDir && request.method === "GET") {
        const served =
          (await serveStaticFile(response, resolvedWebDistDir, pathname)) ||
          (await serveStaticFile(response, resolvedWebDistDir, "/"));
        if (served) {
          logRequest(request.method, pathname, 200, startTime);
          return;
        }
      }

      writeJson(response, 404, { error: "Not found" }, corsOrigin);
      logRequest(request.method ?? "?", pathname, statusCode, startTime);
    } catch (error) {
      console.error(
        `[Launcher] Unhandled error: ${request.method ?? "?"} ${request.url ?? "/"}`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      writeJson(response, 500, { error: "Internal server error" }, corsOrigin);
      logRequest(request.method ?? "?", request.url ?? "/", statusCode, startTime);
    }
  };

  return {
    start: (port: number, host: string) =>
      new Promise<{ host: string; port: number }>((resolve, reject) => {
        httpServer = createServer(handler);
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          const address = httpServer?.address();
          if (address && typeof address === "object") {
            activeHost = host;
            activePort = address.port;
          }
          resolve({ host: activeHost, port: activePort });
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        if (!httpServer) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      }),
  };
};
