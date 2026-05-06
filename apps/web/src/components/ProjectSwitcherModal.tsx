import { useEffect } from "react";

import { useLauncherInfo } from "../app/hooks/useLauncherInfo";
import { ProjectPicker, type ProjectPickerInfo } from "./ProjectPicker";

type ProjectSwitcherModalProps = {
  onClose: () => void;
};

export const ProjectSwitcherModal = ({ onClose }: ProjectSwitcherModalProps) => {
  const { info, error } = useLauncherInfo();

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const pickerInfo: ProjectPickerInfo | null = info
    ? {
        cwd: info.cwd,
        cwdIsInitialized: info.cwdIsInitialized,
        cwdProjectName: info.cwdProjectName,
      }
    : null;

  return (
    <div className="project-switcher-overlay">
      <button
        type="button"
        className="project-switcher-backdrop"
        aria-label="Close project switcher"
        onClick={onClose}
      />
      <dialog open className="project-switcher-modal" aria-label="Switch project">
        <header className="project-switcher-modal-header">
          <h2 className="project-switcher-modal-title">Switch project</h2>
          <button
            type="button"
            className="launcher-button launcher-button--ghost"
            onClick={onClose}
          >
            Close
          </button>
        </header>
        <div className="project-switcher-modal-body">
          {error && <div className="launcher-error">{error}</div>}
          {pickerInfo && (
            <ProjectPicker
              mode="switch"
              info={pickerInfo}
              {...(info?.cwdProjectId ? { currentProjectId: info.cwdProjectId } : {})}
            />
          )}
          {!pickerInfo && !error && <div className="launcher-empty">Loading…</div>}
        </div>
      </dialog>
    </div>
  );
};
