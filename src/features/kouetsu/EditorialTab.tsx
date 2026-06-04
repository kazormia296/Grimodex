import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { usePanelRef } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useKouetsuStore } from "./kouetsuStore";
import { EditorialScopeBar } from "./EditorialScopeBar";
import { ReviewSection } from "./sections/ReviewSection";
import { PseudoCommentSection } from "./sections/PseudoCommentSection";
import { IntentDriftSection } from "./sections/IntentDriftSection";
import { MetaStructureSection } from "./sections/MetaStructureSection";

function SectionHeader({
  title,
  count,
  expanded,
  onToggle,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
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
    </button>
  );
}

export function EditorialTab() {
  const [reviewExpanded, setReviewExpanded] = useState(true);
  const [pseudoExpanded, setPseudoExpanded] = useState(false);
  const [intentExpanded, setIntentExpanded] = useState(false);
  const [metaExpanded, setMetaExpanded] = useState(false);
  const reviewRef = usePanelRef();
  const pseudoRef = usePanelRef();
  const intentRef = usePanelRef();
  const metaRef = usePanelRef();

  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);

  const reviewCount =
    scope === "current" && activeSceneId
      ? (annotationsByScene.get(activeSceneId) ?? []).filter(
          (a) => a.status === "open" && a.category === "review",
        ).length
      : 0;
  const pseudoCount =
    scope === "current" && activeSceneId
      ? (annotationsByScene.get(activeSceneId) ?? []).filter(
          (a) =>
            a.status === "open" &&
            a.category === "pseudo_comment" &&
            a.parentId == null,
        ).length
      : 0;
  const intentCount =
    scope === "current" && activeSceneId
      ? (annotationsByScene.get(activeSceneId) ?? []).filter(
          (a) => a.status === "open" && a.category === "intent_anchor",
        ).length
      : 0;

  const toggle = (ref: ReturnType<typeof usePanelRef>, expanded: boolean) => {
    if (expanded) ref.current?.collapse();
    else ref.current?.expand();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <EditorialScopeBar />

      <ResizablePanelGroup
        orientation="vertical"
        className="flex-1 overflow-hidden"
      >
        <ResizablePanel
          panelRef={reviewRef}
          collapsible
          collapsedSize={32}
          minSize="15%"
          defaultSize="35%"
          onResize={() => {
            setReviewExpanded(!(reviewRef.current?.isCollapsed() ?? false));
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="レビュー"
            count={reviewCount}
            expanded={reviewExpanded}
            onToggle={() => toggle(reviewRef, reviewExpanded)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ReviewSection />
          </div>
        </ResizablePanel>

        <ResizableHandle horizontal withHandle />

        <ResizablePanel
          panelRef={pseudoRef}
          collapsible
          collapsedSize={32}
          minSize="15%"
          defaultSize="20%"
          onResize={() => {
            setPseudoExpanded(!(pseudoRef.current?.isCollapsed() ?? false));
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="疑似コメント"
            count={pseudoCount}
            expanded={pseudoExpanded}
            onToggle={() => toggle(pseudoRef, pseudoExpanded)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PseudoCommentSection />
          </div>
        </ResizablePanel>

        <ResizableHandle horizontal withHandle />

        <ResizablePanel
          panelRef={intentRef}
          collapsible
          collapsedSize={32}
          minSize="15%"
          defaultSize="25%"
          onResize={() => {
            setIntentExpanded(!(intentRef.current?.isCollapsed() ?? false));
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="狙いズレ"
            count={intentCount}
            expanded={intentExpanded}
            onToggle={() => toggle(intentRef, intentExpanded)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <IntentDriftSection />
          </div>
        </ResizablePanel>

        <ResizableHandle horizontal withHandle />

        <ResizablePanel
          panelRef={metaRef}
          collapsible
          collapsedSize={32}
          minSize="15%"
          defaultSize="20%"
          onResize={() => {
            setMetaExpanded(!(metaRef.current?.isCollapsed() ?? false));
          }}
          className="flex flex-col overflow-hidden"
        >
          <SectionHeader
            title="メタ構造"
            count={0}
            expanded={metaExpanded}
            onToggle={() => toggle(metaRef, metaExpanded)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MetaStructureSection />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
