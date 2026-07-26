import { useTranslation } from "react-i18next";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKouetsuStore } from "../kouetsuStore";
import { useFullCheckStore } from "../fullCheckStore";
import { KouetsuScopePicker } from "../KouetsuScopePicker";
import { RunControl } from "./RunControl";

/**
 * 指摘タブのヘッダ行（デザイン 2a）。左にツリースコープピッカー
 * （KouetsuScopePicker、コメントタブと共用）、右に全体チェック分割ボタン
 * （RunControl）と観点ダッシュボードのトグル。
 * ステータスフィルタ chips はリストツールバー（IssueList）へ移動した。
 */
export function TriageHeader() {
  const { t } = useTranslation();
  const dashboardOn = useKouetsuStore((s) => s.dashboardOn);
  const toggleDashboard = useKouetsuStore((s) => s.toggleDashboard);
  const closePipeline = useFullCheckStore((s) => s.closePipeline);

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1 text-xs">
      <KouetsuScopePicker />

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <RunControl />
        <button
          type="button"
          aria-pressed={dashboardOn}
          onClick={() => {
            // 設計 2a: ダッシュボードトグルは選択（toggleDashboard 内で解除）と
            // パイプライン表示を解除する。closePipeline は実行中なら表示のみ
            // 畳み（run 継続・ピルから復帰可）、完了後なら idle へ戻して閉じる。
            closePipeline();
            toggleDashboard();
          }}
          title={t("kouetsu.triage.dashboardToggle")}
          aria-label={t("kouetsu.triage.dashboardToggle")}
          className={cn(
            "flex items-center rounded-md border p-1",
            dashboardOn
              ? "border-[var(--kouetsu-accent)]/40 bg-[var(--kouetsu-accent-weak)] text-[var(--kouetsu-accent)]"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <LayoutGrid size={13} />
        </button>
      </div>
    </div>
  );
}
