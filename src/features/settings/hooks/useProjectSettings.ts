import { useState, useEffect, useRef, useCallback } from "react";
import { getProject, updateProject } from "@/features/project/api";
import type { Project } from "@/features/project/api";
import {
  useCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";

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
    ) => {
      setProject((prev) => (prev ? { ...prev, [field]: value } : prev));

      // 執筆言語が変わったら <html lang> をすぐ更新
      if (field === "language" && value) {
        document.documentElement.lang = value;
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
      }, 300);
      timers.current.set(field, timer);
    },
    [currentProjectId],
  );

  return { project, isLoading, updateField };
}
