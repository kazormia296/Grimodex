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
import { isNir1GraphUiEnabled } from "./nir1GraphAvailability";
import { selectNir1GraphSeed } from "./nir1GraphSeed";
import { subscribeNir1GraphOnlyRevocation } from "./nir1GraphOnlyRevocation";
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
  // DR-CP3B-9 (D8-b): the shown result, and the generation already refreshed
  // for a revoked Graph-only row (one refresh per generation).
  const shown = useRef<Nir1RelatedScenesFetchResult | null>(null);
  shown.current = fetch;
  const revokedGeneration = useRef<number | null>(null);
  // CP-3b F4: the Scenes revoked while a generation's fetch was in flight
  // (Native may have re-checked before the revoke committed). Checked once
  // when that generation publishes, like `graphReadyDuringFetch`.
  const revokedDuringFetch = useRef<{
    generation: number;
    sceneIds: Set<string>;
  } | null>(null);
  // RS-JOIN (DR-RSJ-6): a `graph-ready` refresh of the same query keeps the
  // shown result (and its session, with its invalidation watch) until the new
  // generation publishes or ends, instead of showing "loading" in between.
  const graphReadyRefresh = useRef(false);
  // Whether the running generation was itself a `graph-ready` refresh: only
  // the first refresh of such a chain skips the debounce (P2-A, DR-RSJ-6).
  const startedByGraphReady = useRef(false);
  const queryKey = useRef<readonly unknown[] | null>(null);
  const carried = useRef<{
    value: Nir1RelatedScenesFetchResult;
    unsubscribe?: () => void;
  } | null>(null);
  const dropCarried = useRef(() => {
    const kept = carried.current;
    carried.current = null;
    kept?.unsubscribe?.();
    kept?.value.session?.release();
    return kept !== null;
  }).current;

  // A revoke of the author's declaration in this window hides the shown
  // Graph-only row of that Scene and queries once more. Closed with the UI.
  useEffect(() => {
    if (!enabled || !isNir1GraphUiEnabled()) return;
    return subscribeNir1GraphOnlyRevocation((revokedSceneId) => {
      const generation = current.current;
      const value = shown.current;
      if (
        value?.graphOutcome === "graph-ready" &&
        value.graph?.graphOnly?.sceneId === revokedSceneId
      ) {
        if (revokedGeneration.current === generation) return;
        revokedGeneration.current = generation;
        setRefresh((count) => count + 1);
      } else if (fetchingGeneration.current === generation) {
        const kept = revokedDuringFetch.current;
        if (kept?.generation === generation) kept.sceneIds.add(revokedSceneId);
        else
          revokedDuringFetch.current = {
            generation,
            sceneIds: new Set([revokedSceneId]),
          };
      }
    });
  }, [enabled]);

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
      graphReadyRefresh.current = true;
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
    const key = [
      enabled,
      sceneId,
      nodes,
      mode,
      projectId,
      workspace,
      openRevision,
      listening,
    ];
    const sameQuery =
      queryKey.current?.every((value, at) => Object.is(value, key[at])) ??
      false;
    queryKey.current = key;
    const byGraphReady = graphReadyRefresh.current && sameQuery;
    graphReadyRefresh.current = false;
    const chained = startedByGraphReady.current;
    startedByGraphReady.current = byGraphReady;
    const kept = byGraphReady ? carried.current : null;
    if (kept) {
      // The kept result is withdrawn on its own invalidation, as it was while
      // it was the current generation's.
      kept.unsubscribe?.();
      kept.unsubscribe = kept.value.session?.subscribeInvalidation(() => {
        if (carried.current === kept && dropCarried()) setFetch(null);
      });
    } else {
      dropCarried();
      setFetch(null);
    }
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
      // Both callers come after this generation's answer, which has already
      // dropped any kept result (DR-RSJ-6).
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
      const isCurrent = () => current.current === generation && !disposed;
      // DR-CP3B-3 (D2-A): only with the Graph UI on is a pin read and a seed
      // sent; otherwise begin is byte-identical to the one before CP-3a. A
      // failed read is no seed; Raw and IR still run. `rawOnly` has no begin.
      if (rawOnly || !isNir1GraphUiEnabled() || !projectId) {
        start(rawOnly, generation, isCurrent, null);
        return;
      }
      void selectNir1GraphSeed(projectId, sceneId)
        .catch(() => null)
        .then((seed) => {
          if (isCurrent()) start(false, generation, isCurrent, seed);
          else if (fetchingGeneration.current === generation)
            fetchingGeneration.current = null;
        });
    };
    const start = (
      rawOnly: boolean,
      generation: number,
      isCurrent: () => boolean,
      seed: string | null,
    ) => {
      void fetchRelatedPastScenes(sceneId, {
        mode: "hybrid",
        ...(rawOnly ? { rawOnly: true } : {}),
        signal: abort.signal,
        queryGeneration: generation,
        isCurrent,
        ...(seed !== null ? { graphSeedEntityId: seed } : {}),
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
          // The new generation has an answer: a kept result leaves now.
          const hadKept = dropCarried();
          if (value.status !== "completed") {
            value.session?.release();
            if (value.status === "invalidated") recoverRaw();
            else if (hadKept) setFetch(null);
            return;
          }
          setFetch(value);
          graphReadyGeneration.current = null;
          const revoked = revokedDuringFetch.current;
          if (revoked?.generation === generation) {
            revokedDuringFetch.current = null;
            const graphOnlyId = value.graph?.graphOnly?.sceneId;
            if (
              value.graphOutcome === "graph-ready" &&
              graphOnlyId !== undefined &&
              revoked.sceneIds.has(graphOnlyId) &&
              revokedGeneration.current !== generation
            ) {
              revokedGeneration.current = generation;
              setRefresh((count) => count + 1);
            }
          }
          if (awaitsGraphReady(value)) {
            // A notice that came during the fetch is this generation's one
            // refresh; otherwise wait for the next one.
            if (readyDuringFetch) {
              graphReadyRefresh.current = true;
              setRefresh((count) => count + 1);
            } else graphReadyGeneration.current = generation;
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
          if (!disposed && current.current === generation) {
            dropCarried();
            setFetch(null);
          }
        })
        .finally(() => {
          if (!disposed && current.current === generation) setLoading(false);
        });
    };
    // DR-RSJ-6: the first `graph-ready` refresh runs at once; the Graph it
    // waits for is cached already. Every other start keeps the debounce.
    timer = setTimeout(
      () => run(),
      byGraphReady && !chained ? 0 : FETCH_DEBOUNCE_MS,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
      abort.abort();
      // The shown result is carried to the next run, which keeps or drops it
      // (the unmount effect below drops it when there is no next run).
      dropCarried();
      if (published !== null && published === shown.current)
        carried.current = { value: published, unsubscribe };
      else {
        unsubscribe?.();
        published?.session?.release();
      }
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
    dropCarried,
  ]);
  // Declared after the query effect: on unmount its cleanup runs after that
  // effect's cleanup has carried the shown result, and releases it.
  useEffect(
    () => () => {
      dropCarried();
    },
    [dropCarried],
  );
  return { sceneId, fetch, loading };
}
