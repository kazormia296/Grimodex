import { invoke } from "@tauri-apps/api/core";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { BunsetsuDto, ReorderUnit } from "./types";
import { resolveParagraphAtSelection } from "./paragraphFlat";

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

function isJapanese(language: string | undefined): boolean {
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

/** 文節 cache miss 時に prefetch し、完了後に onReady を呼ぶ。 */
export function prefetchBunsetsuUnits(
  editor: Editor,
  text: string,
  language: string | undefined,
  onReady: () => void,
): void {
  if (!isJapanese(language)) return;
  void fetchBunsetsuUnits(text)
    .then(() => {
      const resolved = resolveParagraphAtSelection(editor.state);
      if (!resolved || resolved.flat.text !== text) return;
      onReady();
    })
    .catch(() => {
      // 失敗時は文粒度 fallback（呼び出し側）
    });
}
