import { useEffect, useRef, useState } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { fetchRelatedPastScenes } from "./fetchRelatedScenes";
import {
  listenRelatedScenesGraphReady,
  listenRelatedScenesIndexReady,
} from "./nir1RelatedScenesApi";
import { observeNir1RelatedScenesQuery } from "./nir1EvidenceNavigation";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

const FETCH_DEBOUNCE_MS = 400;
const MAX_TIMEOUT_RETRIES = 2;
let nextQueryGeneration = 0;

/**
 * A Graph that was not usable yet but may be now: a late arrival, or one still
 * warming, stale or busy. Native emits `graph-ready` when such a result is
 * cached; every other outcome has nothing to wait for.
 */
function awaitsGraphReady(value: Nir1RelatedScenesFetchResult): boolean {
  const outcome = value.graphOutcome;
  return (
    outcome === "graph-late" ||
    outcome === "graph-unavailable:warming" ||
    outcome === "graph-unavailable:stale" ||
    outcome === "graph-unavailable:busy"
  );
}

export function useNir1RelatedScenes(enabled: boolean) {
  const sceneId = useTreeStore((state) => state.activeSceneId);
  const nodes = useTreeStore((state) => state.nodes);
  const mode = usePhaseStore((state) => state.resolutionMode);
  const projectId = useProjectStore((state) => state.currentProjectId);
  const workspace = useWorkspaceStore((state) => state.activeWorkspacePath);
  const openRevision = useWorkspaceStore(
    (state) => state.workspaceOpenRevision,
  );
  const [fetch, setFetch] = useState<Nir1RelatedScenesFetchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const current = useRef(0);
  // The generation of the displayed result that still awaits `graph-ready`.
  // Cleared when consumed, so one generation refreshes at most once.
  const graphReadyGeneration = useRef<number | null>(null);
  // The generation whose fetch is in flight, and whether a `graph-ready` came
  // while it was: Native may cache the late Graph before the fetch returns, so
  // the notice is kept for that generation and spent once it has published
  // (still one refresh per generation; DR-CP3A-49).
  const fetchingGeneration = useRef<number | null>(null);
  const graphReadyDuringFetch = useRef<number | null>(null);

  // This visible-section watcher survives an invalidated ticket and the
  // debounce before its replacement query. Subscribe before starting a query.
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!enabled || !sceneId) {
      setListening(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenGraph: (() => void) | undefined;
    // Optional: a failed graph-ready registration never blocks the query.
    const graphReady = listenRelatedScenesGraphReady((readyProject) => {
      const awaited = graphReadyGeneration.current;
      if (disposed || readyProject !== projectId) return;
      if (awaited === null) {
        const fetching = fetchingGeneration.current;
        if (fetching !== null && fetching === current.current)
          graphReadyDuringFetch.current = fetching;
        return;
      }
      if (awaited !== current.current) return;
      graphReadyGeneration.current = null;
      setRefresh((value) => value + 1);
    })
      .then((release) => {
        if (disposed) release();
        else unlistenGraph = release;
      })
      .catch(() => {});
    void listenRelatedScenesIndexReady((readyProject) => {
      if (!disposed && readyProject === projectId)
        setRefresh((value) => value + 1);
    })
      .then(async (release) => {
        await graphReady;
        if (disposed) release();
        else {
          unlisten = release;
          setListening(true);
        }
      })
      .catch(() => {
        if (!disposed) setListening(true);
      });
    return () => {
      disposed = true;
      unlisten?.();
      unlistenGraph?.();
      graphReadyGeneration.current = null;
      graphReadyDuringFetch.current = null;
      setListening(false);
    };
  }, [enabled, sceneId, projectId, workspace, openRevision]);

  useEffect(() => {
    current.current = ++nextQueryGeneration;
    graphReadyGeneration.current = null;
    fetchingGeneration.current = null;
    graphReadyDuringFetch.current = null;
    setFetch(null);
    if (!enabled || !sceneId || !listening) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    let disposed = false;
    let published: Nir1RelatedScenesFetchResult | null = null;
    let unsubscribe: (() => void) | undefined;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const recoverRaw = () => {
      // An IR lease can be revoked for a source mutation too. Never publish
      // its old Raw snapshot; re-read the current S2 without waiting on IR.
      setFetch(null);
      graphReadyGeneration.current = null;
      clearTimeout(timer);
      timer = setTimeout(() => run(true), FETCH_DEBOUNCE_MS);
    };
    const run = (rawOnly = false) => {
      if (disposed) return;
      const generation = ++nextQueryGeneration;
      current.current = generation;
      unsubscribe?.();
      unsubscribe = undefined;
      published?.session?.release();
      published = null;
      graphReadyGeneration.current = null;
      fetchingGeneration.current = generation;
      graphReadyDuringFetch.current = null;
      setLoading(true);
      observeNir1RelatedScenesQuery(sceneId);
      void fetchRelatedPastScenes(sceneId, {
        mode: "hybrid",
        ...(rawOnly ? { rawOnly: true } : {}),
        signal: abort.signal,
        queryGeneration: generation,
        isCurrent: () => current.current === generation && !disposed,
      })
        .then((value) => {
          const readyDuringFetch = graphReadyDuringFetch.current === generation;
          if (fetchingGeneration.current === generation) {
            fetchingGeneration.current = null;
            graphReadyDuringFetch.current = null;
          }
          if (disposed || current.current !== generation) {
            value.session?.release();
            return;
          }
          published = value;
          if (value.status !== "completed") {
            value.session?.release();
            if (value.status === "invalidated") recoverRaw();
            return;
          }
          setFetch(value);
          graphReadyGeneration.current = null;
          if (awaitsGraphReady(value)) {
            // A notice that came during the fetch is this generation's one
            // refresh; otherwise wait for the next one.
            if (readyDuringFetch) setRefresh((count) => count + 1);
            else graphReadyGeneration.current = generation;
          }
          unsubscribe = value.session?.subscribeInvalidation(() => {
            if (disposed || current.current !== generation) return;
            recoverRaw();
          });
          // A ready notification can be followed by a transient timeout. Keep
          // its completed Raw result visible and start a distinct request;
          // each request retains its own fixed deadline and recorded outcome.
          if (
            value.result.kind === "raw" &&
            value.result.ir.status === "unavailable" &&
            value.result.ir.reason === "timeout" &&
            retries < MAX_TIMEOUT_RETRIES
          ) {
            retries++;
            timer = setTimeout(() => run(), FETCH_DEBOUNCE_MS);
          }
        })
        .catch(() => {
          if (fetchingGeneration.current === generation) {
            fetchingGeneration.current = null;
            graphReadyDuringFetch.current = null;
          }
          if (!disposed && current.current === generation) setFetch(null);
        })
        .finally(() => {
          if (!disposed && current.current === generation) setLoading(false);
        });
    };
    timer = setTimeout(() => run(), FETCH_DEBOUNCE_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
      abort.abort();
      unsubscribe?.();
      published?.session?.release();
    };
  }, [
    enabled,
    sceneId,
    nodes,
    mode,
    projectId,
    workspace,
    openRevision,
    listening,
    refresh,
  ]);
  return { sceneId, fetch, loading };
}
