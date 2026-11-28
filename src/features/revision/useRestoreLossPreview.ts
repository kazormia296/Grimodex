import { useEffect, useRef, useState } from "react";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { RestoreLossNotice } from "./projectSnapshotNative";
import { previewProjectSnapshotRestoreLoss } from "./projectSnapshotApi";
import type { RestoreScope } from "./projectSnapshotScopes";

export interface RestoreLossPreviewState {
  status: "idle" | "loading" | "ready" | "error";
  notices: RestoreLossNotice[];
  /**
   * SRD/1 RD6: imported proposals whose approval the restore takes off.
   * `null` unless `status` is "ready" and Native said.
   */
  approvalLossCount: number | null;
}

interface CachedPreview {
  notices: RestoreLossNotice[];
  approvalLossCount: number | null;
}

export function useRestoreLossPreview(
  snapshotId: string | null,
  structural: boolean,
  scopes: ReadonlySet<RestoreScope>,
  enabled: boolean,
): RestoreLossPreviewState {
  const [state, setState] = useState<RestoreLossPreviewState>({
    status: "idle",
    notices: [],
    approvalLossCount: null,
  });
  const cache = useRef(new Map<string, CachedPreview>());
  const activeSnapshotId = useRef<string | null>(null);
  const hasStarted = useRef(false);
  const requestNumber = useRef(0);
  const scopesKey = [...scopes].sort().join(",");

  useEffect(() => {
    let timer: number | undefined;
    const orderedScopes = scopesKey
      ? (scopesKey.split(",") as RestoreScope[])
      : [];
    const request = ++requestNumber.current;
    const cancel = () => {
      window.clearTimeout(timer);
      if (request === requestNumber.current) requestNumber.current += 1;
    };
    if (!snapshotId) {
      cache.current.clear();
      activeSnapshotId.current = null;
      hasStarted.current = false;
      setState({ status: "idle", notices: [], approvalLossCount: null });
      return cancel;
    }
    if (activeSnapshotId.current !== snapshotId) {
      cache.current.clear();
      activeSnapshotId.current = snapshotId;
      hasStarted.current = false;
    }
    if (!enabled || !structural) {
      setState({ status: "idle", notices: [], approvalLossCount: null });
      return cancel;
    }

    const key = `${snapshotId}\u0000${scopesKey}`;
    const cached = cache.current.get(key);
    if (cached) {
      setState({ status: "ready", ...cached });
      return cancel;
    }

    setState({ status: "loading", notices: [], approvalLossCount: null });
    const delay = hasStarted.current ? 300 : 0;
    hasStarted.current = true;
    const run = () => {
      void previewProjectSnapshotRestoreLoss(snapshotId, new Set(orderedScopes))
        .then(
          ({ structural: isStructural, lossNotices, approvalLossCount }) => {
            if (request !== requestNumber.current) return;
            const preview: CachedPreview = {
              notices: isStructural ? lossNotices : [],
              approvalLossCount: isStructural ? approvalLossCount : null,
            };
            cache.current.set(key, preview);
            setState({ status: "ready", ...preview });
          },
        )
        .catch((error: unknown) => {
          if (request !== requestNumber.current) return;
          debugLog.error(
            "ProjectSnapshot",
            "restore loss preview failed",
            errorDetail(error),
          );
          setState({ status: "error", notices: [], approvalLossCount: null });
        });
    };
    if (delay === 0) run();
    else timer = window.setTimeout(run, delay);

    return cancel;
  }, [enabled, scopesKey, snapshotId, structural]);

  return state;
}
