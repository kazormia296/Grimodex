import { useEffect, useState } from "react";

import { useProjectStore } from "@/features/project/projectStore";
import { isWorkLayerLiveEnabled } from "@/features/work-layer/workLayerLiveFlag";
import type { WorkLayerPort } from "@/features/work-layer/types";

interface OwnedWorkLayerPort {
  readonly projectId: string;
  readonly port: WorkLayerPort;
}

export function useWorkLayerLivePort(
  activeWorkLayer: boolean,
): WorkLayerPort | null {
  const liveEnabled = isWorkLayerLiveEnabled();
  // `useCurrentProjectId()` falls back to a placeholder id when no project is open, so
  // the signal for "a real project" is a project row for the current id. The selector
  // returns a primitive, and a constant while the flag is closed: a closed flag never
  // re-renders this Provider on project changes.
  const projectId = useProjectStore((state) =>
    liveEnabled &&
    state.currentProjectId != null &&
    state.projects.some((project) => project.id === state.currentProjectId)
      ? state.currentProjectId
      : null,
  );
  const fixturePreferred =
    import.meta.env.DEV && import.meta.env.VITE_WORK_LAYER_FIXTURE === "true";
  const eligible =
    activeWorkLayer && liveEnabled && !fixturePreferred && projectId != null;
  const [owned, setOwned] = useState<OwnedWorkLayerPort | null>(null);

  useEffect(() => {
    if (!eligible || projectId == null) {
      setOwned(null);
      return;
    }

    let cancelled = false;
    let createdPort: WorkLayerPort | null = null;
    void Promise.all([
      import("@/features/work-layer/workLayerLivePort"),
      import("./workLayerLiveReaders"),
    ])
      .then(([portModule, readersModule]) => {
        if (cancelled) return;
        const readers = readersModule.createWorkLayerLiveReaders(projectId);
        createdPort = portModule.createWorkLayerLivePort(readers);
        if (cancelled) {
          createdPort.dispose?.();
          return;
        }
        setOwned({ projectId, port: createdPort });
      })
      .catch(() => {
        if (!cancelled) setOwned(null);
      });

    return () => {
      cancelled = true;
      createdPort?.dispose?.();
    };
  }, [eligible, projectId]);

  return eligible && owned?.projectId === projectId ? owned.port : null;
}
