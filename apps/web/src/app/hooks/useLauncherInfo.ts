import { useEffect, useState } from "react";

export type LauncherInfoResponse = {
  mode: "launcher" | "project";
  cwd: string;
  cwdIsInitialized: boolean;
  cwdProjectName: string | null;
  cwdProjectId?: string | null;
};

export type UseLauncherInfoResult = {
  info: LauncherInfoResponse | null;
  error: string | null;
};

export const useLauncherInfo = (): UseLauncherInfoResult => {
  const [info, setInfo] = useState<LauncherInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/launcher/info");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as LauncherInfoResponse;
        if (!cancelled) setInfo(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { info, error };
};
