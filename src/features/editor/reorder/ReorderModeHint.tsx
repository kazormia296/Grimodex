import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpDown } from "lucide-react";
import { useCurrentProject } from "@/features/project/projectStore";
import {
  acquireModifierListeners,
  useReorderModifierStore,
} from "./reorderModifierStore";

/**
 * フッターの推敲リオーダー説明。
 *   平常     … Alt=段落 / Alt+Shift=文・文節 の存在を控えめに案内
 *   Alt      … 段落並べ替え（ハンドルドラッグ / Alt+矢印）
 *   AltShift … 現在の入れ替え単位（文/文節）＋ ドラッグ/矢印 ＋ 粒度切替キー
 *
 * 入れ替え単位バッジは Alt+Shift 押下中のみ表示する（常時表示すると、平常時
 * にも関わらず「文/文節」という語が出て何の状態か紛らわしいとのフィードバック
 * があったため、モード連動に戻した）。
 *
 * store は各エディタプラグインの view() が acquire するが、フッター単独でも
 * 追従できるよう（refcount 共有なので二重取得は無害）ここでも acquire する。
 */
export function ReorderModeHint({ className }: { className?: string }) {
  const { t } = useTranslation();
  const mode = useReorderModifierStore((s) => s.mode);
  const granularity = useReorderModifierStore((s) => s.granularity);
  const isJapanese = (useCurrentProject()?.language ?? "ja")
    .toLowerCase()
    .startsWith("ja");

  useEffect(() => acquireModifierListeners(), []);

  // 英語プロジェクトは文固定（effectiveGranularity と同じ扱い）。store の
  // granularity は前プロジェクトの文節が残り得るので非日本語では文へ矯正する。
  const gran = isJapanese ? granularity : "sentence";

  let text: string;
  if (mode === "alt") {
    text = t("editor.reorder.hint.paragraph");
  } else if (mode === "altShift") {
    const unitLabel =
      gran === "bunsetsu"
        ? t("editor.reorder.granularityBunsetsu")
        : t("editor.reorder.granularitySentence");
    const unitBadge = t("editor.reorder.hint.currentUnit", {
      unit: unitLabel,
    });
    const swap = !isJapanese
      ? ""
      : gran === "bunsetsu"
        ? ` · ${t("editor.reorder.hint.switchToSentence")}`
        : ` · ${t("editor.reorder.hint.switchToBunsetsu")}`;
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
