import { useLayoutStore, type BottomTab } from "./layoutStore";
import { SnippetPanel } from "@/features/snippets/SnippetPanel";
import { AttributionReport } from "@/features/attribution/AttributionReport";

const TAB_LABELS: Record<BottomTab, string> = {
  snippets: "Snippets",
  attribution: "帰属",
};

export function BottomDock() {
  const bottomActive = useLayoutStore((s) => s.bottomActive);
  const setBottomActive = useLayoutStore((s) => s.setBottomActive);

  const tabs: BottomTab[] = ["snippets", "attribution"];

  return (
    <div className="flex h-full flex-col overflow-hidden border-t border-border bg-background">
      {/* Tab bar */}
      <div className="flex flex-shrink-0 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setBottomActive(tab)}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              bottomActive === tab
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {bottomActive === "snippets" && <SnippetPanel />}
        {bottomActive === "attribution" && <AttributionReport />}
      </div>
    </div>
  );
}
