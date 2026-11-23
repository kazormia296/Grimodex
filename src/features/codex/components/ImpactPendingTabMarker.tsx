import { useTranslation } from "react-i18next";
import { useImpactPending } from "./useImpactPending";

interface ImpactPendingTabMarkerProps {
  entryId: string;
  /** 再計算の契機（アクティブなタブ・項目の更新時刻など）。変わると再計算する。 */
  refreshKey: string;
}

/**
 * 整合性タブの小さな点（DR-INN-1）。前回の影響チェック以降に変更があり、押せば実際に
 * チェックが走る項目だけに出す。タブの幅を変えないよう absolute で重ね、ボタンの
 * padding の内側に収める。DetailTabs の表示用の列にだけ描画される。
 */
export function ImpactPendingTabMarker({
  entryId,
  refreshKey,
}: ImpactPendingTabMarkerProps) {
  const { t } = useTranslation();
  const pending = useImpactPending(entryId, refreshKey);
  if (pending.state !== "pending") return null;
  return (
    <>
      <span
        data-testid="detail-tab-pending-dot"
        aria-hidden="true"
        className="pointer-events-none absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary"
      />
      <span className="sr-only">{t("codex.impactCheck.pendingTab")}</span>
    </>
  );
}
