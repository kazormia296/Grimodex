import type { TextFragmentPayload, TrashItemData, TrashSubKind } from "./types";

export type DominantSource = "human" | "ai" | "unknown";

export function dominantSource(item: TrashItemData): DominantSource {
  if (item.kind !== "text-fragment") return "human";
  const spans = (item.payload as TextFragmentPayload).spans ?? [];
  if (spans.some((s) => s.source === "ai")) return "ai";
  if (spans.some((s) => s.source === "unknown")) return "unknown";
  return "human";
}

/**
 * 物理ビューで使う body サイズ。設計書 §2 の表に基づく。
 * text-fragment は文字数で動的、その他 subKind は固定サイズ。
 */
export function getBodySize(item: TrashItemData): {
  width: number;
  height: number;
} {
  return getSizeForSubKind(item.subKind, item.charCount);
}

export function getSizeForSubKind(
  subKind: TrashSubKind,
  charCount: number,
): { width: number; height: number } {
  switch (subKind) {
    case "text-fragment": {
      const width = Math.max(80, Math.min(240, 60 + charCount * 8));
      const height = charCount > 30 ? 36 : 28;
      return { width, height };
    }
    case "scene":
      return { width: 200, height: 80 };
    case "codex-entry":
      return { width: 160, height: 60 };
    case "snippet":
      return { width: 140, height: 100 };
    case "map-sticky":
      return { width: 80, height: 80 };
    case "foreshadow":
      return { width: 120, height: 40 };
    case "grid-chapter":
      return { width: 200, height: 40 };
  }
}
