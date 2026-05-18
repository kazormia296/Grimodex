import { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useKouetsuStore, type KouetsuTab } from "./kouetsuStore";
import { IssuesTab } from "./IssuesTab";
import { EditorialTab } from "./EditorialTab";
import { CommentsTab } from "./CommentsTab";
import { markStart, markEnd } from "@/lib/perfLog";

const TABS: { id: KouetsuTab; labelKey: string }[] = [
  { id: "issues", labelKey: "kouetsu.tab.issues" },
  { id: "editorial", labelKey: "kouetsu.tab.editorial" },
  { id: "comments", labelKey: "kouetsu.tab.comments" },
];

export function KouetsuPanel() {
  markStart("kouetsuPanel.render");
  useLayoutEffect(() => {
    markEnd("kouetsuPanel.render");
  });
  const { t } = useTranslation();
  const { activeTab, setActiveTab } = useKouetsuStore();

  return (
    <div className="flex h-full flex-col" data-testid="kouetsu-panel">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border bg-muted/20 px-2 py-1">
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
      </div>
    </div>
  );
}
