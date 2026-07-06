import { LinterPanel } from "@/features/lint/LinterPanel";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";

export function LinterSection() {
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const mode =
    statusFilter === "dismissed"
      ? "disables"
      : scope.type === "scene"
        ? "current"
        : "project";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LinterPanel mode={mode} />
    </div>
  );
}
