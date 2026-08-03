import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { instantEpochMilliseconds } from "@/lib/time";
import { useLensStore } from "@/features/post-effect/lensStore";
import type {
  PostEffectSeverity,
  SceneLensRecord,
} from "@/features/post-effect/types";
import { useTreeStore } from "./treeStore";
import { getTreeIndex } from "./treeIndex";

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
 * lens 群から dot の表示状態 (worst severity と stale) を導出する純関数。
 *
 * - worst: SEVERITY_ORDER 上で最も重い severity (無ければ info)。
 * - stale: シーンの updatedAt が「グループ内で最も新しい runCompletedAt」より後か。
 *   lens 行は created_at 昇順で来るため lenses[0] は最古。1 シーンが複数 run の
 *   lens を持つ場合に最古 run と比較すると最新診断より前の編集でも誤って stale に
 *   なるので、必ず最新 runCompletedAt と比較する。
 */
export function computeLensDotState(
  lenses: SceneLensRecord[],
  updatedAt: string | undefined,
): { worst: PostEffectSeverity; stale: boolean } {
  const worst =
    SEVERITY_ORDER.find((sev) => lenses.some((l) => l.severity === sev)) ??
    "info";
  const latestRunCompletedAt = lenses.reduce<number | null>((max, lens) => {
    const epoch = lens.runCompletedAt
      ? instantEpochMilliseconds(lens.runCompletedAt)
      : null;
    if (epoch === null) return max;
    return max === null || epoch > max ? epoch : max;
  }, null);
  const updatedEpoch = updatedAt ? instantEpochMilliseconds(updatedAt) : null;
  const stale =
    updatedEpoch !== null &&
    latestRunCompletedAt !== null &&
    updatedEpoch > latestRunCompletedAt;
  return { worst, stale };
}

/**
 * Outline (Scenes パネル) の lens バッジ。meta_structure 診断のあるシーンに
 * 重要度色のドットを出す。診断 run 以降に編集されたシーン (stale) は薄く表示。
 */
export function LensDot({ sceneId }: { sceneId: string }) {
  const { t } = useTranslation();
  const showLensOverlay = useLensStore((s) => s.showLensOverlay);
  const lenses = useLensStore((s) => s.bySceneId.get(sceneId));
  const updatedAt = useTreeStore(
    (state) => getTreeIndex(state.nodes).nodeById.get(sceneId)?.updatedAt,
  );

  if (!showLensOverlay || !lenses || lenses.length === 0) return null;

  const { worst, stale } = computeLensDotState(lenses, updatedAt);

  return (
    <span
      title={stale ? t("tree.lensDot.edited") : t("tree.lensDot.found")}
      className={cn(
        "ml-1 inline-block h-2 w-2 shrink-0 rounded-full",
        SEVERITY_COLOR[worst],
        stale && "opacity-30",
      )}
    />
  );
}
