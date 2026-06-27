import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SpellCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKouetsuStore, type KouetsuTab } from "./kouetsuStore";
import { IssuesTab } from "./IssuesTab";
import { EditorialTab } from "./EditorialTab";
import { CommentsTab } from "./CommentsTab";
import { BlockerTab } from "./BlockerTab";
import { recordMark } from "@/lib/perfLog";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";

const TABS: { id: KouetsuTab; labelKey: string }[] = [
  { id: "issues", labelKey: "kouetsu.tab.issues" },
  { id: "editorial", labelKey: "kouetsu.tab.editorial" },
  { id: "comments", labelKey: "kouetsu.tab.comments" },
  { id: "blocker", labelKey: "kouetsu.tab.blocker" },
];

export function KouetsuPanel({ isActive = true }: SlotPanelProps = {}) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const { activeTab, setActiveTab } = useKouetsuStore();
  const setPanelActive = useKouetsuStore((s) => s.setPanelActive);

  // keepalive で hidden の間、配下ビューの scene 追従処理を bail させるため
  // パネルの active 状態を store に反映する (isActive 省略時は active 扱い)。
  useEffect(() => {
    setPanelActive(isActive);
  }, [isActive, setPanelActive]);

  const __renderResult = (
    <div className="flex h-full flex-col" data-testid="kouetsu-panel">
      <div
        data-panel-header
        className="flex shrink-0 items-center gap-0.5 border-b border-border bg-muted/20 px-3 py-1 text-xs"
      >
        <SpellCheck className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="mr-1 shrink-0 font-medium text-foreground">
          {t("layout.panel.kouetsu")}
        </span>
        {TABS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={cn(
              "rounded px-2 py-0.5 text-xs transition-colors",
              activeTab === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "issues" && <IssuesTab />}
        {activeTab === "editorial" && <EditorialTab />}
        {activeTab === "comments" && <CommentsTab />}
        {activeTab === "blocker" && <BlockerTab />}
      </div>
    </div>
  );
  recordMark(
    "kouetsuPanel.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
