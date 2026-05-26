import { useEffect, useRef } from "react";
import type { SearchStore } from "../store/commandCenterStore";
import { getProviders } from "../providers/registry";
import { parseCommandInput } from "../lib/parseCommandInput";
import { filterByExcludes } from "../lib/filterByExcludes";
import type {
  CommandCenterProvider,
  ProviderExtras,
  Surface,
} from "../providers/types";

/**
 * 検索バーの「入力を購読 → debounce → provider 並行実行 → store に upsert」フック。
 *
 * ## 単一所有 (single owner) の不変条件
 *
 * この hook は **アプリ内で 1 箇所のみ呼び出される**こと。具体的には
 * `CommandCenterBar` のみ。専用ビュー (`CommandCenterResultsPanel`) は
 * **呼び出さない** — もし呼ぶと、2 つの hook 実例がそれぞれ `runtimesRef` を
 * 持ち、互いを認識せずに同じクエリで provider を二重発火 → store への
 * 書込みが race する (advisor が指摘した critical bug)。
 *
 * パネル展開時の limit 切替は、Bar が `useResultsPanelStore((s) => s.mounted)`
 * を購読し、`limit: mounted ? PANEL_FETCH_LIMIT : BAR_FETCH_LIMIT` を渡す
 * 経路で行う。
 *
 * ## Race 対策
 *
 * - 世代 ID (`generation`): 応答受信時に最新世代と照合し、古い結果は捨てる
 * - AbortSignal: 補助 (Tauri invoke は abort できないため世代 ID が主)
 *
 * ## メモ化 (superset memo)
 *
 * `(mode, query)` を base key、その base key で fetch した最大 limit を保持。
 * 新リクエストの limit が **maxLimit 以下なら skip** する。これにより:
 *
 * - パネル open (limit 50) → fetch
 * - パネル close (limit 10) → 10 ≤ 50 で skip (store に 50 件残っているので再取得不要)
 * - パネル open (limit 50) → 50 ≤ 50 で skip
 * - query 変更 → base key 変わるので fetch
 *
 * Bar の display は `BAR_VISIBLE_LIMIT_PER_SECTION` で slice して表示する。
 */

interface ProviderRuntime {
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  generation: number;
  /** 最後に fetch した (mode, query) */
  lastBaseKey: string | null;
  /** その base key で fetch した最大 limit。新 limit がこれ以下なら skip。 */
  lastMaxLimit: number;
}

const DEBOUNCE_BY_PROVIDER: Record<string, number> = {
  lexical: 200,
  semantic: 300,
};
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_LIMIT = 10;

export interface UseCommandCenterSearchOptions {
  /** 1 provider あたりの取得件数。バー単独=10、Dockview パネル mount 中=50 */
  limit?: number;
  /** 絞り込み対象の surface。Phase A2 で bar/panel 個別に hook を起動するときに使う。 */
  surface?: Surface;
}

function ensureRuntime(
  map: Map<string, ProviderRuntime>,
  providerId: string,
): ProviderRuntime {
  let runtime = map.get(providerId);
  if (!runtime) {
    runtime = {
      timer: null,
      controller: null,
      generation: 0,
      lastBaseKey: null,
      lastMaxLimit: 0,
    };
    map.set(providerId, runtime);
  }
  return runtime;
}

function cancelRuntime(runtime: ProviderRuntime): void {
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
  runtime.controller?.abort();
  runtime.controller = null;
}

function debounceFor(providerId: string): number {
  return DEBOUNCE_BY_PROVIDER[providerId] ?? DEFAULT_DEBOUNCE_MS;
}

export function useCommandCenterSearch(
  store: SearchStore,
  options: UseCommandCenterSearchOptions = {},
): void {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const surface = options.surface;
  const runtimesRef = useRef<Map<string, ProviderRuntime>>(new Map());

  const query = store((s) => s.query);
  // descriptionMode は semantic provider の cacheKeyExtras で memo に影響する。
  // ここで購読しないと変更が effect 再実行をトリガしないため、deps に含めて再評価させる。
  const descriptionMode = store((s) => s.descriptionMode);

  useEffect(() => {
    const parsed = parseCommandInput(query);
    const state = store.getState();
    state.setMode(parsed.mode);
    state.setParsedQuery(parsed.text);
    state.setExcludes(parsed.excludes);

    const trimmed = parsed.text.trim();
    const providers = getProviders(parsed.mode, surface);
    const activeIds = new Set(providers.map((p) => p.id));

    // search mode で空クエリのときは結果を完全クリア。
    // command mode (`> ` 起動) のときは空クエリでもコマンド一覧を出したいので provider を回す。
    if (!trimmed && parsed.mode === "search") {
      for (const runtime of runtimesRef.current.values()) {
        cancelRuntime(runtime);
        runtime.lastBaseKey = null;
        runtime.lastMaxLimit = 0;
      }
      state.reset();
      return;
    }

    // mode 切替などで居なくなった provider の section を消す
    for (const id of Array.from(runtimesRef.current.keys())) {
      if (!activeIds.has(id)) {
        const runtime = runtimesRef.current.get(id);
        if (runtime) cancelRuntime(runtime);
        runtimesRef.current.delete(id);
        store.getState().removeSection(id);
      }
    }

    const extras: ProviderExtras = { descriptionMode };
    for (const provider of providers) {
      scheduleProvider(provider, store, runtimesRef.current, {
        query: trimmed,
        mode: parsed.mode,
        limit,
        excludes: parsed.excludes,
        extras,
      });
    }
  }, [store, query, limit, descriptionMode, surface]);

  // unmount cleanup
  useEffect(() => {
    const runtimes = runtimesRef.current;
    return () => {
      for (const runtime of runtimes.values()) cancelRuntime(runtime);
      runtimes.clear();
    };
  }, []);
}

interface ScheduleArgs {
  query: string;
  mode: "search" | "command";
  limit: number;
  /** post-filter で section.items から drop する除外語 */
  excludes: string[];
  /** provider が search/cacheKey で使う追加コンテキスト */
  extras: ProviderExtras;
}

function makeBaseKey(
  provider: CommandCenterProvider,
  args: ScheduleArgs,
): string {
  // excludes は post-filter にしか効かないが、変更で見え方が変わるためメモ key に含める。
  // 順序差で別 key にならないよう sort してから join (\x00 は通常クエリに現れない安全な区切り)。
  const sortedExcludes = [...args.excludes].sort().join("\x00");
  // provider 固有の bust factor (例: semantic は descriptionMode を含む)。
  // 他 provider に影響しないよう provider.id 単位で計算される。
  const extras = provider.cacheKeyExtras?.(args.extras) ?? "";
  return `${args.mode}::${args.query}::ex=${sortedExcludes}::extras=${extras}`;
}

function scheduleProvider(
  provider: CommandCenterProvider,
  store: SearchStore,
  runtimes: Map<string, ProviderRuntime>,
  args: ScheduleArgs,
): void {
  const runtime = ensureRuntime(runtimes, provider.id);
  const baseKey = makeBaseKey(provider, args);

  // superset memo: same baseKey (mode + query + excludes) かつ limit が直近 max 以下なら skip
  if (runtime.lastBaseKey === baseKey && args.limit <= runtime.lastMaxLimit) {
    return;
  }

  cancelRuntime(runtime);
  const myGen = ++runtime.generation;
  const controller = new AbortController();
  runtime.controller = controller;

  // loading section を即座に upsert (検索中表示)
  const loadingSection = {
    id: provider.id,
    title: provider.title,
    order: provider.order,
    items: [],
    state: { kind: "loading" as const },
  };
  store.getState().upsertSection(loadingSection, provider.hideWhenEmpty);

  runtime.timer = setTimeout(() => {
    void runProvider(
      provider,
      store,
      runtime,
      controller,
      myGen,
      baseKey,
      args,
    );
  }, debounceFor(provider.id));
}

async function runProvider(
  provider: CommandCenterProvider,
  store: SearchStore,
  runtime: ProviderRuntime,
  controller: AbortController,
  myGen: number,
  baseKey: string,
  args: ScheduleArgs,
): Promise<void> {
  try {
    const section = await provider.search({
      query: args.query,
      signal: controller.signal,
      limit: args.limit,
      mode: args.mode,
      generation: myGen,
      descriptionMode: args.extras.descriptionMode,
    });
    if (runtime.generation !== myGen || controller.signal.aborted) return;
    // 同じ base key への重ね打ちなら maxLimit は max を取る、
    // 別 base key への移行ならその limit に置き換える。
    if (runtime.lastBaseKey === baseKey) {
      runtime.lastMaxLimit = Math.max(runtime.lastMaxLimit, args.limit);
    } else {
      runtime.lastBaseKey = baseKey;
      runtime.lastMaxLimit = args.limit;
    }
    const filtered = filterByExcludes(section, args.excludes);
    store.getState().upsertSection(filtered, provider.hideWhenEmpty);
  } catch (e) {
    if (runtime.generation !== myGen || controller.signal.aborted) return;
    store.getState().upsertSection(
      {
        id: provider.id,
        title: provider.title,
        order: provider.order,
        items: [],
        state: {
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        },
      },
      provider.hideWhenEmpty,
    );
  }
}
