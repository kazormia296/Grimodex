import { useState, useEffect, useRef, useCallback } from "react";
import { getProject, updateProject } from "@/features/project/api";
import type { Project } from "@/features/project/api";

const PROJECT_ID = "default-project";

export function useProjectSettings() {
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    getProject(PROJECT_ID).then((p) => {
      if (!cancelled && p) setProject(p);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        await updateProject(PROJECT_ID, { [field]: value ?? undefined });
        timers.current.delete(field);
      }, 300);
      timers.current.set(field, timer);
    },
    [],
  );

  return { project, isLoading, updateField };
}
