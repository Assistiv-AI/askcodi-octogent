import { ProjectPicker, type ProjectPickerInfo } from "./ProjectPicker";

type LauncherAppProps = {
  info: ProjectPickerInfo;
};

export const LauncherApp = ({ info }: LauncherAppProps) => {
  return (
    <div className="launcher-shell">
      <div className="launcher-frame">
        <header className="launcher-header">
          <h1 className="launcher-title">Octogent</h1>
          <p className="launcher-subtitle">Pick a project to open or initialize a new one.</p>
        </header>

        <ProjectPicker mode="launcher" info={info} />
      </div>
    </div>
  );
};
