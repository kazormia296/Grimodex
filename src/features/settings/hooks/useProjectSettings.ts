import { useState, useEffect, useRef, useCallback } from "react";
import { getProject, updateProject } from "@/features/project/api";
import type { Project } from "@/features/project/api";
import {
  useCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import { useSettingsStore } from "@/features/settings/settingsStore";

export function useProjectSettings() {
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const currentProjectId = useCurrentProjectId();

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getProject(currentProjectId).then((p) => {
      if (!cancelled && p) setProject(p);
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  const updateField = useCallback(
    (
      field: keyof Omit<Project, "id" | "createdAt" | "updatedAt">,
      value: string | null,
      /** DB 書込 (debounce) 確定後に発火。言語切替後の index status 再取得用。 */
      onPersist?: () => void,
    ) => {
      setProject((prev) => (prev ? { ...prev, [field]: value } : prev));

      // 執筆言語が変わったら loadProject と同じ reconcile を即時に行う:
      // <html lang> (S1) 更新 + settings cache の言語デフォルト再適用
      // (applyProjectLanguage)。これをしないと en の書体/行間/スマートクォート等が
      // project 再読込まで ja のまま残る。
      if (field === "language" && value) {
        document.documentElement.lang = value;
        useSettingsStore.getState().applyProjectLanguage(value);
      }

      // Debounced DB write per field
      const existing = timers.current.get(field);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        await updateProject(currentProjectId, {
          [field]: value ?? undefined,
        });
        void useProjectStore.getState().refreshProjects();
        timers.current.delete(field);
        // DB 書込後 (Rust の project_language JOIN が新言語を返す) に発火。
        onPersist?.();
      }, 300);
      timers.current.set(field, timer);
    },
    [currentProjectId],
  );

  return { project, isLoading, updateField };
}
