import { cn } from "@/lib/utils";
import { useLensStore } from "@/features/post-effect/lensStore";
import type { PostEffectSeverity } from "@/features/post-effect/types";

const SEVERITY_COLOR: Record<PostEffectSeverity, string> = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  suggestion: "bg-blue-400",
  info: "bg-slate-400",
};

const SEVERITY_ORDER: PostEffectSeverity[] = [
  "error",
  "warning",
  "suggestion",
  "info",
];

/**
 * Outline (Scenes パネル) の lens バッジ。meta_structure 診断のあるシーンに
 * 重要度色のドットを出す。診断 run 以降に編集されたシーン (stale) は薄く表示。
 */
export function LensDot({
  sceneId,
  updatedAt,
}: {
  sceneId: string;
  updatedAt?: string;
}) {
  const showLensOverlay = useLensStore((s) => s.showLensOverlay);
  const lenses = useLensStore((s) => s.bySceneId.get(sceneId));

  if (!showLensOverlay || !lenses || lenses.length === 0) return null;

  const worst =
    SEVERITY_ORDER.find((sev) => lenses.some((l) => l.severity === sev)) ??
    "info";
  // lens 行は created_at 昇順なので lenses[0] は最古。1 シーンが複数 run の
  // lens (plot_structure / pacing が別 run など) を持つと最古 run の完了時刻で
  // stale 判定され、最新診断より前の編集でも誤って薄表示になる。グループ内の
  // 最新 runCompletedAt と比較する。
  const runCompletedAt = lenses.reduce<string | null>((max, l) => {
    const t = l.runCompletedAt ?? null;
    if (!t) return max;
    if (!max) return t;
    return new Date(t).getTime() > new Date(max).getTime() ? t : max;
  }, null);
  const stale =
    !!updatedAt &&
    !!runCompletedAt &&
    new Date(updatedAt).getTime() > new Date(runCompletedAt).getTime();

  return (
    <span
      title={
        stale
          ? "このシーンは構造診断以降に編集されています"
          : "メタ構造診断あり"
      }
      className={cn(
        "ml-1 inline-block h-2 w-2 shrink-0 rounded-full",
        SEVERITY_COLOR[worst],
        stale && "opacity-30",
      )}
    />
  );
}
