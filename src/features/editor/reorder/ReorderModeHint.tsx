import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpDown } from "lucide-react";
import { useCurrentProject } from "@/features/project/projectStore";
import {
  acquireModifierListeners,
  useReorderModifierStore,
} from "./reorderModifierStore";
import type { ReorderGranularity } from "./types";

function granularityLabel(
  gran: ReorderGranularity,
  t: (key: string) => string,
): string {
  if (gran === "bunsetsu") return t("editor.reorder.granularityBunsetsu");
  if (gran === "character") return t("editor.reorder.granularityCharacter");
  return t("editor.reorder.granularitySentence");
}

function nextGranularityHint(
  gran: ReorderGranularity,
  isJapanese: boolean,
  t: (key: string) => string,
): string {
  if (isJapanese) {
    if (gran === "sentence") return t("editor.reorder.hint.switchToBunsetsu");
    if (gran === "bunsetsu") return t("editor.reorder.hint.switchToCharacter");
    return t("editor.reorder.hint.switchToSentence");
  }
  return gran === "sentence"
    ? t("editor.reorder.hint.switchToCharacter")
    : t("editor.reorder.hint.switchToSentence");
}

/**
 * フッターの推敲リオーダー説明。
 *   平常     … Alt=段落 / Alt+Shift=文・文節・文字 を並べ替え の存在を控えめに案内
 *   Alt      … 段落並べ替え（ハンドルドラッグ / Alt+矢印）
 *   AltShift … 現在の入れ替え単位 ＋ ドラッグ/矢印 ＋ 粒度切替キー
 */
export function ReorderModeHint({ className }: { className?: string }) {
  const { t } = useTranslation();
  const mode = useReorderModifierStore((s) => s.mode);
  const granularity = useReorderModifierStore((s) => s.granularity);
  const isJapanese = (useCurrentProject()?.language ?? "ja")
    .toLowerCase()
    .startsWith("ja");

  useEffect(() => acquireModifierListeners(), []);

  const gran: ReorderGranularity =
    !isJapanese && granularity === "bunsetsu" ? "sentence" : granularity;

  let text: string;
  if (mode === "alt") {
    text = t("editor.reorder.hint.paragraph");
  } else if (mode === "altShift") {
    const unitBadge = t("editor.reorder.hint.currentUnit", {
      unit: granularityLabel(gran, t),
    });
    const swap = ` · ${nextGranularityHint(gran, isJapanese, t)}`;
    text = `${unitBadge} · ${t("editor.reorder.hint.altShiftActive")}${swap}`;
  } else {
    text = t("editor.reorder.hint.base");
  }

  const active = mode !== "none";
  return (
    <span
      className={`flex items-center gap-1 whitespace-nowrap tabular-nums ${
        active ? "text-foreground" : "opacity-70"
      } ${className ?? ""}`}
      data-reorder-mode={mode}
      data-reorder-granularity={gran}
    >
      <ArrowUpDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      {text}
    </span>
  );
}
