import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLintStore } from "@/features/lint/lintStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { LinterSection } from "./sections/LinterSection";
import { ConsistencySection } from "./sections/ConsistencySection";

function SectionHeader({
  title,
  count,
  expanded,
  onToggle,
  action,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 border-b border-border bg-muted/20 px-3 py-1.5 text-left text-xs font-medium hover:bg-muted/40"
    >
      <ChevronRight
        size={12}
        className={cn(
          "shrink-0 text-muted-foreground transition-transform",
          expanded && "rotate-90",
        )}
      />
      <span>{title}</span>
      {count > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none text-muted-foreground">
          {count}
        </span>
      )}
      {action && (
        <span
          className="ml-auto"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {action}
        </span>
      )}
    </button>
  );
}

export function IssuesTab() {
  const [linterExpanded, setLinterExpanded] = useState(true);
  const [consistencyExpanded, setConsistencyExpanded] = useState(true);

  const diagnosticCount = useLintStore((s) => s.diagnostics.length);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);
  const consistencyCount = activeSceneId
    ? (annotationsByScene.get(activeSceneId)?.filter((a) => a.status === "open")
        .length ?? 0)
    : 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <SectionHeader
        title="校正"
        count={diagnosticCount}
        expanded={linterExpanded}
        onToggle={() => setLinterExpanded((v) => !v)}
      />
      {linterExpanded && (
        <div className="min-h-0 flex-1">
          <LinterSection />
        </div>
      )}

      <SectionHeader
        title="整合性"
        count={consistencyCount}
        expanded={consistencyExpanded}
        onToggle={() => setConsistencyExpanded((v) => !v)}
      />
      {consistencyExpanded && <ConsistencySection />}
    </div>
  );
}
