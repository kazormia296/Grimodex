import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useKouetsuStore, type IssuesScope } from "./kouetsuStore";

const SCOPES: Array<{ id: IssuesScope; labelKey: string }> = [
  { id: "current", labelKey: "kouetsu.scope.current" },
  { id: "project", labelKey: "kouetsu.scope.project" },
  { id: "ignored", labelKey: "kouetsu.scope.ignored" },
];

export function IssuesScopeBar() {
  const { t } = useTranslation();
  const activeScope = useKouetsuStore((s) => s.activeIssuesScope);
  const setScope = useKouetsuStore((s) => s.setActiveIssuesScope);

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-2 py-1 text-xs">
      {SCOPES.map(({ id, labelKey }) => (
        <button
          key={id}
          type="button"
          onClick={() => setScope(id)}
          className={cn(
            "rounded px-2 py-0.5",
            activeScope === id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
