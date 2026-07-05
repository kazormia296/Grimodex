import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useKouetsuStore, type KouetsuTab } from "./kouetsuStore";
import { IssuesInbox } from "./IssuesInbox";
import { CommentsTab } from "./CommentsTab";
import { BlockerTab } from "./BlockerTab";
import { recordMark } from "@/lib/perfLog";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { PanelHeader } from "@/features/layout/PanelHeader";

const TABS: { id: KouetsuTab; labelKey: string }[] = [
  { id: "issues", labelKey: "kouetsu.tab.issues" },
  { id: "comments", labelKey: "kouetsu.tab.comments" },
  { id: "blocker", labelKey: "kouetsu.tab.blocker" },
];

export function KouetsuPanel({ isActive = true }: SlotPanelProps = {}) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const storedTab = useKouetsuStore((s) => s.activeTab);
  const setActiveTab = useKouetsuStore((s) => s.setActiveTab);
  // persist 済み store から不正値（旧 "editorial" 等）が来ても tab 選択と
  // aria-labelledby の id 参照が壊れないよう既知の tab に正規化する
  const activeTab = TABS.some(({ id }) => id === storedTab)
    ? storedTab
    : TABS[0].id;
  const setPanelActive = useKouetsuStore((s) => s.setPanelActive);
  const idBase = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // APG tabs パターン: 矢印キーで隣接タブへ移動（automatic activation）。
  const handleTabKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let next: number;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft")
      next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    setActiveTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  // keepalive で hidden の間、配下ビューの scene 追従処理を bail させるため
  // パネルの active 状態を store に反映する (isActive 省略時は active 扱い)。
  useEffect(() => {
    setPanelActive(isActive);
  }, [isActive, setPanelActive]);

  const __renderResult = (
    <div className="flex h-full flex-col" data-testid="kouetsu-panel">
      <PanelHeader panelId="kouetsu">
        <div
          role="tablist"
          aria-label={t("layout.panel.kouetsu")}
          className="flex items-center gap-0.5"
        >
          {TABS.map(({ id, labelKey }, index) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${id}`}
              aria-selected={activeTab === id}
              aria-controls={`${idBase}-tabpanel`}
              tabIndex={activeTab === id ? 0 : -1}
              onClick={() => setActiveTab(id)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              className={cn(
                "rounded px-2 py-0.5 text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                activeTab === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </PanelHeader>
      <div
        role="tabpanel"
        id={`${idBase}-tabpanel`}
        aria-labelledby={`${idBase}-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {activeTab === "issues" && <IssuesInbox />}
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
