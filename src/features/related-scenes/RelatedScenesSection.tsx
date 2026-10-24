import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { CollapsibleSection } from "@/features/layout/CollapsibleSection";
import { debugLog } from "@/lib/debugLog";
import { Nir1RelatedSceneRow } from "./Nir1RelatedSceneRow";
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";
import { isNir1GraphUiEnabled } from "./nir1GraphAvailability";
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

// The Graph view (CP-3b) is a lazy chunk requested only while the Graph UI
// constant is on and the fetch carries a Graph payload, `restart-required` or
// (with `PROFILE_ACTIVATION_UI_ENABLED` on too) `profile-not-restricted`
// (DR-CP3B-7, DR-DA2-33). While the constant is false nothing below fetches it.
const Nir1GraphRelatedScenes = lazy(() => import("./Nir1GraphRelatedScenes"));

/** A failed Graph chunk or render falls back to the R/R+IR rows. */
class Nir1GraphBoundary extends Component<
  { readonly fallback: ReactNode; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // A fixed message only: the error may carry payload text.
    debugLog.warn("related-scenes", "graph view unavailable");
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function showsGraph(fetch: Nir1RelatedScenesFetchResult | null): boolean {
  return Boolean(
    fetch &&
    isNir1GraphUiEnabled() &&
    ((fetch.graphOutcome === "graph-ready" && fetch.graph) ||
      fetch.graphOutcome === "graph-unavailable:restart-required" ||
      // K3/2 T-1 guidance (NIR-1 DA-2 ST3, DR-DA2-33): only while the
      // activation UI constant is on too.
      (PROFILE_ACTIVATION_UI_ENABLED &&
        fetch.graphOutcome === "graph-unavailable:profile-not-restricted")),
  );
}

interface RelatedScenesSectionProps {
  enabled?: boolean;
}

export function RelatedScenesSection({
  enabled = true,
}: RelatedScenesSectionProps = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const { sceneId, fetch, loading } = useNir1RelatedScenes(enabled && open);
  const result = fetch?.result;
  const unavailable =
    result?.kind === "raw" && result.ir.status === "unavailable"
      ? result.ir.reason
      : null;
  return (
    <CollapsibleSection
      title={t("sceneContext.scenesSection")}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      actions={
        loading ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <div className="py-1">
        {unavailable && (
          <p
            data-testid="nir1-unavailable"
            className="px-3 py-2 text-[11px] text-muted-foreground"
          >
            {t(
              unavailable === "unsupported-query"
                ? "relatedScenes.irUnsupported"
                : "relatedScenes.irUnavailable",
            )}
          </p>
        )}
        {!sceneId ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("relatedScenes.noActiveScene")}
          </p>
        ) : fetch && showsGraph(fetch) ? (
          <Nir1GraphBoundary fallback={baseRows(fetch, loading, t)}>
            <Suspense fallback={baseRows(fetch, loading, t)}>
              <Nir1GraphRelatedScenes
                fetch={fetch}
                // The query's own Scene: after an accepted Graph-only click the
                // active Scene is the target for a render before `fetch` resets.
                querySceneId={fetch.origin?.querySceneId ?? sceneId}
              />
            </Suspense>
          </Nir1GraphBoundary>
        ) : (
          baseRows(fetch, loading, t)
        )}
      </div>
    </CollapsibleSection>
  );
}

function baseRows(
  fetch: Nir1RelatedScenesFetchResult | null,
  loading: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): ReactNode {
  const result = fetch?.result;
  return !fetch || !result?.scenes.length ? (
    <p className="px-3 py-2 text-[11px] text-muted-foreground">
      {t(loading ? "relatedScenes.loading" : "relatedScenes.empty")}
    </p>
  ) : result.kind === "raw" ? (
    result.scenes.map((raw) => (
      <Nir1RelatedSceneRow
        key={raw.sceneId}
        sceneId={raw.sceneId}
        sceneTitle={raw.sceneTitle}
        raw={raw}
        fetch={fetch}
      />
    ))
  ) : (
    result.scenes.map((scene) => (
      <Nir1RelatedSceneRow
        key={scene.sceneId}
        sceneId={scene.sceneId}
        sceneTitle={scene.sceneTitle}
        rank={scene.rank1}
        raw={scene.kind !== "ir" ? scene.raw : undefined}
        ir={scene.kind !== "raw" ? scene.ir : undefined}
        fetch={fetch}
      />
    ))
  );
}
