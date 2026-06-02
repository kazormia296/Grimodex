import { useMemo, useState } from "react";
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
import { deriveIssueCounts } from "./issueCounts";
import { IssuesScopeBar } from "./IssuesScopeBar";
import { LinterSection } from "./sections/LinterSection";
import { ConsistencySection } from "./sections/ConsistencySection";
import { TypoSection } from "./sections/TypoSection";

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
  const [typoExpanded, setTypoExpanded] = useState(true);
  const linterRef = usePanelRef();
  const consistencyRef = usePanelRef();
  const typoRef = usePanelRef();

  const scope = useKouetsuStore((s) => s.activeIssuesScope);
  const diagnostics = useLintStore((s) => s.diagnostics);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);

  // typo Lint は誤字脱字セクションに別集計しつつ、校正セクションにも従来どおり含める
  // (Linter 全件パネルの一貫性を優先。MVP のトレードオフ)
  const { linterCount, consistencyCount, typoCount } = useMemo(
    () =>
      deriveIssueCounts({
        diagnostics,
        annotationsByScene,
        scope,
        activeSceneId,
      }),
    [diagnostics, annotationsByScene, scope, activeSceneId],
  );

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

  const handleTypoToggle = () => {
    if (typoExpanded) {
      typoRef.current?.collapse();
    } else {
      typoRef.current?.expand();
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
          defaultSize="34%"
          onResize={() => {
            setLinterExpanded(!(linterRef.current?.isCollapsed() ?? false));
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="校正"
            count={linterCount}
            expanded={linterExpanded}
            onToggle={handleLinterToggle}
            action={
              <span className="text-[10px] text-muted-foreground">
                自動検出
              </span>
            }
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
          defaultSize="33%"
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

        <ResizableHandle horizontal withHandle />

        <ResizablePanel
          panelRef={typoRef}
          collapsible
          collapsedSize={32}
          minSize="15%"
          defaultSize="33%"
          onResize={() => {
            setTypoExpanded(!(typoRef.current?.isCollapsed() ?? false));
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="誤字脱字"
            count={typoCount}
            expanded={typoExpanded}
            onToggle={handleTypoToggle}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TypoSection />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
