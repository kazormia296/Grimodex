import { useEffect, useState } from "react";

import { useProjectStore } from "@/features/project/projectStore";
import type { WorkLayerPort } from "@/features/work-layer/types";

/**
 * 旗 `VITE_WORK_LAYER_LIVE`（"true"／"1" だけ開く。DEV でも既定は閉じる）。`import.meta.env.*` は build が
 * 値に置き換えるので、旗が閉じた build ではこれが定数 false になり、下の選択で live の hook ごと
 * （動的 import の呼び出しも）取り除かれ、live の chunk は出力されない。旗が閉じている製品 build は、
 * live のために起動時の graph を増やさない。**この式は、動的 import と同じ module に置く**
 * （別の module の定数では、呼び出しは消えても chunk が出力される）。
 */
const LIVE_BUILD =
  import.meta.env.VITE_WORK_LAYER_LIVE === "true" ||
  import.meta.env.VITE_WORK_LAYER_LIVE === "1";

interface OwnedWorkLayerPort {
  readonly projectId: string;
  readonly port: WorkLayerPort;
}

export function useLiveWorkLayerPort(
  activeWorkLayer: boolean,
): WorkLayerPort | null {
  // `useCurrentProjectId()` falls back to a placeholder id when no project is open, so
  // the signal for "a real project" is a project row for the current id. The selector
  // returns a primitive: renaming a project does not re-render this Provider.
  const projectId = useProjectStore((state) =>
    state.currentProjectId != null &&
    state.projects.some((project) => project.id === state.currentProjectId)
      ? state.currentProjectId
      : null,
  );
  const fixturePreferred =
    import.meta.env.DEV && import.meta.env.VITE_WORK_LAYER_FIXTURE === "true";
  const eligible = activeWorkLayer && !fixturePreferred && projectId != null;
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

const useNoLiveWorkLayerPort = (): WorkLayerPort | null => null;

/** 旗が閉じている間、この Provider は何も購読せず、何も読み込まない。 */
export const useWorkLayerLivePort: (
  activeWorkLayer: boolean,
) => WorkLayerPort | null = LIVE_BUILD
  ? useLiveWorkLayerPort
  : useNoLiveWorkLayerPort;
