import type { Dispatch, SetStateAction } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Nir1EntityRelationHumanDecision } from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";
import type { CodexEntry } from "./api";
import type { CodexRelationRow } from "./codexRelationApi";
import { CodexEntityRelationReviewDialogFooter } from "./CodexEntityRelationReviewDialogFooter";
import { CodexEntityRelationReviewSelectors } from "./CodexEntityRelationReviewSelectors";
import { CodexEntityRelationRevisionReviewPanel } from "./CodexEntityRelationRevisionReviewPanel";
import type { TypedReviewSession } from "./useCodexEntityRelationReview";

export interface CodexEntityRelationReviewDialogContentProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly entries: readonly CodexEntry[];
  readonly scenes: readonly { id: string; title: string }[];
  readonly relations: readonly CodexRelationRow[];
  readonly sceneId: string;
  readonly setSceneId: Dispatch<SetStateAction<string>>;
  readonly selectedEntityIds: ReadonlySet<string>;
  readonly setSelectedEntityIds: Dispatch<SetStateAction<Set<string>>>;
  readonly selectedRelationIds: ReadonlySet<string>;
  readonly setSelectedRelationIds: Dispatch<SetStateAction<Set<string>>>;
  readonly selectionError: string | null;
  readonly projectMatches: boolean;
  readonly typedReview: TypedReviewSession | null;
  readonly typedDecisionBusy: boolean;
  readonly typedPrepareBusy: boolean;
  readonly typedDecisionError: string | null;
  readonly onDecision: (decision: Nir1EntityRelationHumanDecision) => void;
  readonly onReplace: () => void;
  readonly onStartNew: () => void;
  readonly onPrepare: () => void;
}

export function CodexEntityRelationReviewDialogContent({
  open,
  onOpenChange,
  entries,
  scenes,
  relations,
  sceneId,
  setSceneId,
  selectedEntityIds,
  setSelectedEntityIds,
  selectedRelationIds,
  setSelectedRelationIds,
  selectionError,
  projectMatches,
  typedReview,
  typedDecisionBusy,
  typedPrepareBusy,
  typedDecisionError,
  onDecision,
  onReplace,
  onStartNew,
  onPrepare,
}: CodexEntityRelationReviewDialogContentProps) {
  // A cold current-read may know the durable Run but not be allowed to
  // publish its material. Keep that reason visible while reopening the direct
  // selectors so an explicit action can mint a new immutable Revision. The
  // old Run is never requalified by this path.
  const coldUnavailableWithoutResult =
    typedReview?.status === "unavailable" && typedReview.result === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-hidden"
        data-testid="nir1-entity-relation-prepare-dialog"
      >
        <DialogHeader>
          <DialogTitle>Entity / Relation レビュー準備</DialogTitle>
          <p className="text-xs text-muted-foreground">
            既存Codexの軽量投影を選択し、Nativeでtyped Revisionを準備します。
          </p>
        </DialogHeader>
        {typedReview && (
          <CodexEntityRelationRevisionReviewPanel
            runId={typedReview.runId}
            status={typedReview.status}
            result={typedReview.result}
            decision={typedReview.decision}
            unavailableReason={typedReview.unavailableReason}
            busy={typedDecisionBusy || typedPrepareBusy}
            error={typedDecisionError}
            onDecision={onDecision}
            onReplace={onReplace}
            onStartNew={onStartNew}
          />
        )}
        {!typedReview || coldUnavailableWithoutResult ? (
          <CodexEntityRelationReviewSelectors
            entries={entries}
            scenes={scenes}
            relations={relations}
            sceneId={sceneId}
            setSceneId={setSceneId}
            selectedEntityIds={selectedEntityIds}
            setSelectedEntityIds={setSelectedEntityIds}
            selectedRelationIds={selectedRelationIds}
            setSelectedRelationIds={setSelectedRelationIds}
            selectionError={
              selectionError ??
              typedDecisionError ??
              (!projectMatches
                ? "Project bindingが一致しないため準備できません"
                : null)
            }
          />
        ) : null}
        <CodexEntityRelationReviewDialogFooter
          typedReview={Boolean(typedReview) && !coldUnavailableWithoutResult}
          typedPrepareBusy={typedPrepareBusy}
          typedDecisionBusy={typedDecisionBusy}
          sceneSelected={Boolean(sceneId) && projectMatches}
          onClose={() => onOpenChange(false)}
          onPrepare={onPrepare}
        />
      </DialogContent>
    </Dialog>
  );
}
