import { useEffect, useState } from "react";

import type { WorkLayerPort } from "./types";

interface WorkLayerPreviewActivation {
  readonly development: boolean;
  readonly fixtureFlag: string | undefined;
  readonly surfaceActive: boolean;
}

export function shouldEnableWorkLayerPreview({
  development,
  fixtureFlag,
  surfaceActive,
}: WorkLayerPreviewActivation): boolean {
  return development && fixtureFlag === "true" && surfaceActive;
}

/**
 * Explicit development-only activation. Production builds never import the
 * fixture chunk, and normal development starts with the Work Layer absent.
 */
export function useWorkLayerPreviewPort(
  surfaceActive: boolean,
): WorkLayerPort | null {
  const [port, setPort] = useState<WorkLayerPort | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) {
      if (
        !shouldEnableWorkLayerPreview({
          development: true,
          fixtureFlag: import.meta.env.VITE_WORK_LAYER_FIXTURE,
          surfaceActive,
        })
      ) {
        setPort(null);
        return;
      }

      let cancelled = false;
      void import("./workLayerFixture")
        .then(({ createWorkLayerFixturePort }) => {
          if (!cancelled) setPort(createWorkLayerFixturePort());
        })
        .catch(() => {
          if (!cancelled) setPort(null);
        });
      return () => {
        cancelled = true;
      };
    }

    setPort(null);
  }, [surfaceActive]);

  return port;
}
