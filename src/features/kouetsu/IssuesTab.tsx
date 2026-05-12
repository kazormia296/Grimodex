import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { usePanelRef } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { useLintStore } from "@/features/lint/lintStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useKouetsuStore } from "./kouetsuStore";
import { IssuesScopeBar } from "./IssuesScopeBar";
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
      className="flex w-full shrink-0 items-center gap-1.5 border-b border-border bg-muted/20 px-3 py-1.5 text-left text-xs font-medium hover:bg-muted/40"
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
  const linterRef = usePanelRef();
  const consistencyRef = usePanelRef();

  const scope = useKouetsuStore((s) => s.activeIssuesScope);
  const diagnosticCount = useLintStore((s) => s.diagnostics.length);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);
  const consistencyCount =
    scope === "current" && activeSceneId
      ? (annotationsByScene
          .get(activeSceneId)
          ?.filter((a) => a.status === "open").length ?? 0)
      : 0;

  const handleLinterToggle = () => {
    if (linterExpanded) {
      linterRef.current?.collapse();
    } else {
      linterRef.current?.expand();
    }
  };

  const handleConsistencyToggle = () => {
    if (consistencyExpanded) {
      consistencyRef.current?.collapse();
    } else {
      consistencyRef.current?.expand();
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <IssuesScopeBar />

      <ResizablePanelGroup
        orientation="vertical"
        className="flex-1 overflow-hidden"
      >
        <ResizablePanel
          panelRef={linterRef}
          collapsible
          collapsedSize={32}
          minSize="15%"
          defaultSize="50%"
          onResize={() => {
            setLinterExpanded(!(linterRef.current?.isCollapsed() ?? false));
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="校正"
            count={diagnosticCount}
            expanded={linterExpanded}
            onToggle={handleLinterToggle}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <LinterSection />
          </div>
        </ResizablePanel>

        <ResizableHandle horizontal withHandle />

        <ResizablePanel
          panelRef={consistencyRef}
          collapsible
          collapsedSize={32}
          minSize="15%"
          defaultSize="50%"
          onResize={() => {
            setConsistencyExpanded(
              !(consistencyRef.current?.isCollapsed() ?? false),
            );
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="整合性"
            count={consistencyCount}
            expanded={consistencyExpanded}
            onToggle={handleConsistencyToggle}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConsistencySection />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
