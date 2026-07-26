import { invoke } from "@/lib/tauri";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { BunsetsuDto, ReorderUnit } from "./types";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import type { SwapSnapshot } from "./paragraphSnapshot";
import { isSwapSnapshotValid } from "./paragraphSnapshot";

interface CacheEntry {
  text: string;
  units: ReorderUnit[];
  promise?: Promise<ReorderUnit[]>;
}

let cache: CacheEntry | null = null;

function dtoToUnits(dtos: BunsetsuDto[]): ReorderUnit[] {
  return dtos.map((d) => ({
    from: d.start,
    to: d.end,
    surface: d.surface,
  }));
}

export function isJapanese(language: string | undefined): boolean {
  return !(language ?? "ja").toLowerCase().startsWith("en");
}

export function clearBunsetsuCache(): void {
  cache = null;
}

export function getCachedBunsetsuUnits(
  state: EditorState | null,
  language: string | undefined,
): ReorderUnit[] | null {
  if (!state) return null;
  if (!isJapanese(language)) return null;
  const resolved = resolveParagraphAtSelection(state);
  if (!resolved) return null;
  if (!cache || cache.text !== resolved.flat.text) return null;
  // in-flight (promise pending) や空結果は cache miss として扱う。
  // 空配列を "確定済み unit なし" として返すと呼び出し側の
  // `if (!bunsetsuUnits)` チェックをすり抜け、文粒度へ暗黙フォールバックしてしまう。
  if (cache.promise || cache.units.length === 0) return null;
  return cache.units;
}

/**
 * text をキーに確定済み文節 units を返す（selection 非依存）。
 * 任意段落（ポインタ下の段落など）の文節を装飾/ドラッグで使うため。
 * in-flight・空・text 不一致は null。
 */
export function getBunsetsuUnitsForText(text: string): ReorderUnit[] | null {
  if (!cache || cache.text !== text) return null;
  if (cache.promise || cache.units.length === 0) return null;
  return cache.units;
}

export async function fetchBunsetsuUnits(text: string): Promise<ReorderUnit[]> {
  if (cache?.text === text && cache.units.length > 0) {
    return cache.units;
  }
  if (cache?.text === text && cache.promise) {
    return cache.promise;
  }

  const promise = invoke<BunsetsuDto[]>("segment_bunsetsu", { text }).then(
    (dtos) => {
      const units = dtoToUnits(dtos);
      cache = { text, units };
      return units;
    },
    (err: unknown) => {
      if (cache?.text === text) cache = null;
      throw err;
    },
  );

  cache = { text, units: [], promise };
  return promise;
}

/** 文節 cache miss 時に prefetch し、完了後に snapshot 検証して onReady を呼ぶ。 */
export function prefetchBunsetsuUnits(
  editor: Editor,
  snapshot: SwapSnapshot,
  language: string | undefined,
  onReady: (snapshot: SwapSnapshot) => void,
  onFailed?: (snapshot: SwapSnapshot) => void,
): void {
  if (!isJapanese(language)) {
    onFailed?.(snapshot);
    return;
  }
  void fetchBunsetsuUnits(snapshot.flatText)
    .then(() => {
      if (!isSwapSnapshotValid(editor.state, snapshot)) return;
      onReady(snapshot);
    })
    .catch(() => {
      if (!isSwapSnapshotValid(editor.state, snapshot)) return;
      onFailed?.(snapshot);
    });
}
