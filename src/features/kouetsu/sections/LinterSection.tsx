import { LinterPanel } from "@/features/lint/LinterPanel";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import type { IssuesScope } from "@/features/kouetsu/kouetsuStore";

function scopeToMode(scope: IssuesScope): "current" | "project" | "disables" {
  if (scope === "ignored") return "disables";
  return scope;
}

export function LinterSection() {
  const scope = useKouetsuStore((s) => s.activeIssuesScope);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LinterPanel mode={scopeToMode(scope)} />
    </div>
  );
}
