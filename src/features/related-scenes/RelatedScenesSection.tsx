import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { CollapsibleSection } from "@/features/layout/CollapsibleSection";
import { useTreeStore } from "@/features/tree/treeStore";
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
// The seed line and the seed candidates (DR-SEEDSUG-1): their own lazy chunk,
// requested only while the Graph UI constant is on.
const Nir1GraphSeedPanel = lazy(() => import("./Nir1GraphSeedPanel"));

/** A failed Graph chunk or render falls back to the R/R+IR rows. */
class Nir1GraphBoundary extends Component<
  {
    readonly fallback: ReactNode;
    readonly children: ReactNode;
    readonly message?: string;
  },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // A fixed message only: the error may carry payload text.
    debugLog.warn(
      "related-scenes",
      this.props.message ?? "graph view unavailable",
    );
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
  // DR-SEEDSUG-3: after a pin from the seed candidates the query is paused for
  // one commit, the same path as closing and reopening the section: the hook
  // ends its query, then reads the seed again and begins with it. The hook
  // itself is unchanged.
  // A pair of counters, not a boolean: a pin reported after the resume was
  // queued but before it rendered still pauses (and resumes) once more.
  const [pauseTick, setPauseTick] = useState(0);
  const [resumedTick, setResumedTick] = useState(0);
  const paused = pauseTick !== resumedTick;
  useEffect(() => {
    setResumedTick(pauseTick);
  }, [pauseTick]);
  const { sceneId, fetch, loading } = useNir1RelatedScenes(
    enabled && open && !paused,
  );
  const content = useRef<HTMLDivElement>(null);
  const onSeedPinned = (pinnedSceneId: string) => {
    // A pin of a Scene that is no longer active needs no new query here.
    if (useTreeStore.getState().activeSceneId !== pinnedSceneId) return;
    const box = content.current;
    const focused = document.activeElement;
    // The candidates leave with the query: keep the focus in the section.
    if (
      box &&
      (focused === null || focused === document.body || box.contains(focused))
    )
      box.focus();
    setPauseTick((tick) => tick + 1);
  };
  // DR-SEEDSUG-1: the seed panel belongs to the shown, completed query of the
  // active Scene, and reads again for each new query of it.
  const seedOrigin =
    enabled &&
    isNir1GraphUiEnabled() &&
    fetch?.origin?.projectId &&
    fetch.origin.querySceneId === sceneId
      ? fetch.origin
      : null;
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
      <div
        ref={content}
        // The focus target after a seed pin (DR-SEEDSUG-3); only with the
        // Graph UI on, so the closed product keeps its DOM.
        tabIndex={isNir1GraphUiEnabled() ? -1 : undefined}
        className={isNir1GraphUiEnabled() ? "py-1 outline-none" : "py-1"}
      >
        {seedOrigin?.projectId && (
          <Nir1GraphBoundary
            fallback={null}
            message="graph seed panel unavailable"
          >
            <Suspense fallback={null}>
              <Nir1GraphSeedPanel
                projectId={seedOrigin.projectId}
                sceneId={seedOrigin.querySceneId}
                queryGeneration={seedOrigin.queryGeneration}
                onPinned={onSeedPinned}
              />
            </Suspense>
          </Nir1GraphBoundary>
        )}
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
