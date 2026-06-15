import { useTranslation } from "react-i18next";
import { useRescanStore } from "@/features/codex/mentionRescanQueue";
import { useMatrixStore } from "./matrixStore";

interface Props {
  sceneCount: number;
  totalSceneCount: number;
  codexCount: number;
  totalCodexCount: number;
  filledCells: number;
}

export function MatrixStatusBar({
  sceneCount,
  totalSceneCount,
  codexCount,
  totalCodexCount,
  filledCells,
}: Props) {
  const { t } = useTranslation();
  const settingsSaved = useMatrixStore((s) => s.settingsSaved);
  const isRunning = useRescanStore((s) => s.isRunning);
  const progress = useRescanStore((s) => s.progress);
  const total = useRescanStore((s) => s.total);

  const sceneLabel =
    sceneCount < totalSceneCount
      ? `${sceneCount} / ${totalSceneCount} ${t("common.unitScenes")}`
      : `${sceneCount} ${t("common.unitScenes")}`;

  const codexLabel =
    codexCount < totalCodexCount
      ? `${codexCount} / ${totalCodexCount} ${t("common.unitCodex")}`
      : `${codexCount} ${t("common.unitCodex")}`;

  return (
    <div className="flex items-center gap-3 border-t px-4 py-1 text-[11px] text-muted-foreground">
      <span>
        {sceneLabel} × {codexLabel}
      </span>
      <span>•</span>
      <span>{t("matrix.status.cellsFilled", { count: filledCells })}</span>
      <span>•</span>
      <span>
        {settingsSaved
          ? t("matrix.status.settingsSavedStatus")
          : t("matrix.status.settingsSavingStatus")}
      </span>
      {isRunning && (
        <>
          <span>•</span>
          <span className="text-yellow-600 dark:text-yellow-400">
            {t("matrix.status.scanning", { progress, total })}
          </span>
        </>
      )}
    </div>
  );
}
