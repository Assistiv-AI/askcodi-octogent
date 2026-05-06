import { type FormEvent, useCallback, useEffect, useState } from "react";

export type ProjectPickerInfo = {
  cwd: string;
  cwdIsInitialized: boolean;
  cwdProjectName: string | null;
};

export type ProjectPickerMode = "launcher" | "switch";

type LauncherProject = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt?: string;
  isRunning: boolean;
  apiBaseUrl: string | null;
  exists: boolean;
};

type ProjectPickerProps = {
  mode: ProjectPickerMode;
  info: ProjectPickerInfo;
  /** When set (typically in switch mode), the matching project is shown
   * but visibly marked as "current" and its open button is disabled. */
  currentProjectId?: string | undefined;
};

const formatRelativeTime = (iso: string | undefined): string => {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.round(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(iso).toLocaleDateString();
};

export const ProjectPicker = ({ mode, info, currentProjectId }: ProjectPickerProps) => {
  const [projects, setProjects] = useState<LauncherProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/launcher/projects");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as { projects?: LauncherProject[] };
      setProjects(data.projects ?? []);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const openProject = useCallback(async (projectId: string) => {
    setBusyProjectId(projectId);
    setOpenError(null);
    try {
      const response = await fetch(`/api/launcher/projects/${encodeURIComponent(projectId)}/open`, {
        method: "POST",
      });
      const data = (await response.json()) as { apiBaseUrl?: string; error?: string };
      if (!response.ok || !data.apiBaseUrl) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      window.location.href = data.apiBaseUrl;
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
      setBusyProjectId(null);
    }
  }, []);

  const removeProject = useCallback(async (projectId: string) => {
    try {
      const response = await fetch(`/api/launcher/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setProjects((current) => current.filter((p) => p.id !== projectId));
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const initializeAndOpen = useCallback(
    async (path: string, name?: string) => {
      setIsCreating(true);
      setCreateError(null);
      try {
        const response = await fetch("/api/launcher/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(name ? { path, name } : { path }),
        });
        const data = (await response.json()) as {
          entry?: { id: string };
          error?: string;
        };
        if (!response.ok || !data.entry) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        await openProject(data.entry.id);
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsCreating(false);
      }
    },
    [openProject],
  );

  const handleCreateSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedPath = newProjectPath.trim();
      if (trimmedPath.length === 0) {
        setCreateError("Path is required.");
        return;
      }
      void initializeAndOpen(trimmedPath, newProjectName.trim() || undefined);
    },
    [initializeAndOpen, newProjectPath, newProjectName],
  );

  const handleOpenCurrentFolder = useCallback(() => {
    void initializeAndOpen(info.cwd);
  }, [initializeAndOpen, info.cwd]);

  const showCurrentFolderCard = mode === "launcher";
  const initFormTitle =
    mode === "launcher" ? "Initialize a different folder" : "Open another folder";

  return (
    <>
      {showCurrentFolderCard && (
        <section className="launcher-section">
          <h2 className="launcher-section-title">Current folder</h2>
          <div className="launcher-card launcher-card--current">
            <div className="launcher-card-body">
              <div className="launcher-card-name">
                {info.cwdProjectName ?? info.cwd.split("/").pop() ?? info.cwd}
              </div>
              <div className="launcher-card-path">{info.cwd}</div>
              <div className="launcher-card-meta">
                {info.cwdIsInitialized ? "Initialized" : "Not yet initialized"}
              </div>
            </div>
            <div className="launcher-card-actions">
              <button
                type="button"
                className="launcher-button launcher-button--primary"
                onClick={handleOpenCurrentFolder}
                disabled={isCreating || busyProjectId !== null}
              >
                {info.cwdIsInitialized ? "Open" : "Initialize and open"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="launcher-section">
        <h2 className="launcher-section-title">{initFormTitle}</h2>
        <form className="launcher-form" onSubmit={handleCreateSubmit}>
          <input
            type="text"
            className="launcher-input"
            placeholder="/absolute/path/to/folder"
            value={newProjectPath}
            onChange={(event) => setNewProjectPath(event.target.value)}
            disabled={isCreating}
            aria-label="Project folder path"
          />
          <input
            type="text"
            className="launcher-input"
            placeholder="Display name (optional)"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            disabled={isCreating}
            aria-label="Project display name"
          />
          <button
            type="submit"
            className="launcher-button launcher-button--primary"
            disabled={isCreating || newProjectPath.trim().length === 0}
          >
            {isCreating ? "Initializing..." : "Initialize and open"}
          </button>
        </form>
        {createError && <div className="launcher-error">{createError}</div>}
      </section>

      <section className="launcher-section">
        <h2 className="launcher-section-title">Recent projects</h2>
        {isLoading ? (
          <div className="launcher-empty">Loading projects…</div>
        ) : projects.length === 0 ? (
          <div className="launcher-empty">No projects yet.</div>
        ) : (
          <ul className="launcher-project-list">
            {projects.map((project) => {
              const isBusy = busyProjectId === project.id;
              const isCurrent = currentProjectId === project.id;
              let openLabel = "Open";
              if (isCurrent) openLabel = "Current";
              else if (isBusy) openLabel = "Opening…";
              else if (project.isRunning) openLabel = "Connect";
              return (
                <li key={project.id} className="launcher-card">
                  <div className="launcher-card-body">
                    <div className="launcher-card-name">
                      {project.name}
                      {isCurrent && (
                        <span className="launcher-pill launcher-pill--current">current</span>
                      )}
                      {project.isRunning && !isCurrent && (
                        <span className="launcher-pill launcher-pill--running">running</span>
                      )}
                      {!project.exists && (
                        <span className="launcher-pill launcher-pill--missing">missing</span>
                      )}
                    </div>
                    <div className="launcher-card-path">{project.path}</div>
                    <div className="launcher-card-meta">
                      {project.lastOpenedAt
                        ? `Opened ${formatRelativeTime(project.lastOpenedAt)}`
                        : `Created ${formatRelativeTime(project.createdAt)}`}
                    </div>
                  </div>
                  <div className="launcher-card-actions">
                    <button
                      type="button"
                      className="launcher-button launcher-button--primary"
                      onClick={() => void openProject(project.id)}
                      disabled={
                        !project.exists ||
                        isBusy ||
                        busyProjectId !== null ||
                        isCreating ||
                        isCurrent
                      }
                    >
                      {openLabel}
                    </button>
                    <button
                      type="button"
                      className="launcher-button launcher-button--ghost"
                      onClick={() => void removeProject(project.id)}
                      disabled={busyProjectId !== null || isCreating || isCurrent}
                      title="Remove from recent projects (does not delete the folder)"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {openError && <div className="launcher-error">{openError}</div>}
      </section>
    </>
  );
};
