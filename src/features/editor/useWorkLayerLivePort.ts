import { useEffect, useState } from "react";

import { useProjectStore } from "@/features/project/projectStore";
import type { WorkLayerPort } from "@/features/work-layer/types";

/**
 * 旗 `VITE_WORK_LAYER_LIVE`（既定は開く。`false`／`0` で閉じる。fixture が指定された DEV では fixture が優先）。
 * `import.meta.env.*` は build が値に置き換えるので、`false`／`0` を指定した build ではこれが定数 false に
 * なり、下の選択で live の hook ごと（動的 import の呼び出しも）取り除かれ、live の chunk は出力されない。
 * **この式は、動的 import と同じ module に置く**（別の module の定数では、呼び出しは消えても chunk が出力される）。
 */
const LIVE_BUILD =
  import.meta.env.VITE_WORK_LAYER_LIVE !== "false" &&
  import.meta.env.VITE_WORK_LAYER_LIVE !== "0";

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

/** 旗を閉じた build では、この Provider は何も購読せず、何も読み込まない。 */
export const useWorkLayerLivePort: (
  activeWorkLayer: boolean,
) => WorkLayerPort | null = LIVE_BUILD
  ? useLiveWorkLayerPort
  : useNoLiveWorkLayerPort;
