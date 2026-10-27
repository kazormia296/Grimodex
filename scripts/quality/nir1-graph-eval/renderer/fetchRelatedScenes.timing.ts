/**
 * CP-4 S1f harness-only timing shim of the product module
 * `src/features/related-scenes/fetchRelatedScenes.ts` (DR-CP4-F-5).
 *
 * The harness renderer build resolves the product's imports of that module
 * (the hook `useNir1RelatedScenes.ts` among them) to this file; this file alone
 * imports the product module itself. Every export is the product's; only
 * `fetchRelatedPastScenes` is wrapped, and only its hybrid calls are noted:
 * the options the hook passed (scene, query generation, the `graph-ready` mark,
 * the seed it read from the pin, Raw-only), the renderer `performance.now()`
 * of the call and of the answer, and the answer object itself (summarized by
 * the probe after the sample, never here, so the hook gets the same value with
 * one added promise reaction). Each answer is tagged with its call's sequence
 * number so that the probe can tell which call a React commit shows. The
 * arguments, the answers and the product's control flow are unchanged. It
 * never ships in the product `dist/`.
 */
import * as product from "@/features/related-scenes/fetchRelatedScenes";
import type {
  Nir1RelatedScenesFetchOptions,
  Nir1RelatedScenesFetchResult,
} from "@/features/related-scenes/nir1RelatedScenesFetchTypes";

export * from "@/features/related-scenes/fetchRelatedScenes";

export interface FetchTimingRow {
  seq: number;
  sceneId: string;
  queryGeneration: number | null;
  refreshTrigger: string | null;
  seed: string | null;
  rawOnly: boolean;
  calledAt: number;
  resolvedAt: number | null;
  failed: boolean;
  value: Nir1RelatedScenesFetchResult | null;
}

const host = globalThis as unknown as {
  __cp4FetchTiming?: FetchTimingRow[];
  __cp4FetchSeq?: WeakMap<object, number>;
  __cp4FetchNext?: number;
  __cp4FetchTimingInstalled?: boolean;
};
host.__cp4FetchTimingInstalled = true;
const rows = (host.__cp4FetchTiming ??= []);
const seqOf = (host.__cp4FetchSeq ??= new WeakMap<object, number>());

function timedFetch(
  sceneId: string,
  options?: Nir1RelatedScenesFetchOptions,
): ReturnType<typeof product.fetchRelatedPastScenes> {
  if (options?.mode !== "hybrid")
    return product.fetchRelatedPastScenes(sceneId, options);
  host.__cp4FetchNext = (host.__cp4FetchNext ?? 0) + 1;
  const row: FetchTimingRow = {
    seq: host.__cp4FetchNext,
    sceneId,
    queryGeneration: options.queryGeneration ?? null,
    refreshTrigger: options.refreshTrigger ?? null,
    seed: options.graphSeedEntityId ?? null,
    rawOnly: options.rawOnly === true,
    calledAt: performance.now(),
    resolvedAt: null,
    failed: false,
    value: null,
  };
  rows.push(row);
  return product.fetchRelatedPastScenes(sceneId, options).then(
    (value) => {
      row.resolvedAt = performance.now();
      const result = value as Nir1RelatedScenesFetchResult;
      row.value = result;
      seqOf.set(result, row.seq);
      return value;
    },
    (error: unknown) => {
      row.resolvedAt = performance.now();
      row.failed = true;
      throw error;
    },
  );
}

export const fetchRelatedPastScenes =
  timedFetch as typeof product.fetchRelatedPastScenes;
