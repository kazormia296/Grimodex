import { useCallback, useMemo } from "react";
import type { TrashItemData } from "../types";
import { getBodySize } from "../displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

interface StickyMeta {
  bodyPreview?: string | null;
  paletteId?: string | null;
  colorSlot?: number | null;
}

// Sticky パレット → 背景色のざっくりマッピング。Map 本体のパレット詳細とは独立で、
// trash 表示用の簡易表現。設計書 §8.2 の「黄色付箋 (角度ランダム、影強め)」を満たす。
const PALETTE_BG: Record<string, string[]> = {
  "post-it-playful": [
    "bg-yellow-200/95",
    "bg-pink-200/95",
    "bg-sky-200/95",
    "bg-lime-200/95",
  ],
  "post-it-classic": [
    "bg-yellow-200/95",
    "bg-amber-100/95",
    "bg-orange-200/95",
  ],
};

export function MapStickyTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);
  const meta = (item.previewMeta ?? {}) as StickyMeta;

  // 同一 id で安定な傾き (-5°〜+5°)。設計書 §8.2: 「角度 ±5° ランダム」
  const tilt = useMemo(() => {
    let h = 0;
    for (const c of item.id) h = (h * 31 + c.charCodeAt(0)) | 0;
    return ((h % 11) - 5) * 0.6;
  }, [item.id]);

  const palette = meta.paletteId ?? "post-it-playful";
  const slot = Math.max(0, meta.colorSlot ?? 0);
  const bgClass =
    (PALETTE_BG[palette] ?? PALETTE_BG["post-it-playful"])[
      slot % (PALETTE_BG[palette]?.length ?? 1)
    ] ?? "bg-yellow-200/95";

  return (
    <div
      ref={ref}
      className={`absolute will-change-transform select-none rounded-sm px-2 py-1.5 text-zinc-900 shadow-md ring-1 ring-yellow-900/10 ${bgClass}`}
      style={{
        width: size.width,
        height: size.height,
        top: 0,
        left: 0,
        // 物理シミュ側の rotate と合成されるので、初期傾きは CSS variable 経由で
        // body 側に渡したいが現状は physics 側が rotation を制御。ここでは inner
        // span を傾けて雰囲気だけ出す。
      }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <div
        className="flex h-full flex-col"
        style={{ transform: `rotate(${tilt}deg)` }}
      >
        <div className="truncate text-[11px] font-semibold leading-tight">
          {item.previewText || "—"}
        </div>
        {meta.bodyPreview ? (
          <div className="mt-1 line-clamp-3 text-[9px] leading-tight opacity-80">
            {meta.bodyPreview}
          </div>
        ) : null}
      </div>
    </div>
  );
}
