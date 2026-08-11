import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSceneStore } from "@/features/tree/store";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useForeshadowStore } from "./foreshadowStore";
import { CreateForeshadowDialog } from "./CreateForeshadowDialog";
import { ForeshadowExtractionReview } from "./extraction-ui/ForeshadowExtractionReview";
import { getChapterForeshadowStats } from "./api";
import type { AuditCandidate, ChapterForeshadowStats } from "./types";

export function ForeshadowChapterTab() {
  const { t } = useTranslation();
  const { nodes } = useSceneStore();
  const { auditingChapterIds, auditResults, auditChapter } =
    useForeshadowStore();

  const chapters = nodes.filter((n) => n.nodeType === "folder" && !n.parentId);

  const [expandedChapterId, setExpandedChapterId] = useState<string | null>(
    null,
  );
  const [stats, setStats] = useState<Record<string, ChapterForeshadowStats>>(
    {},
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] = useState<{
    title: string;
    intent: string;
  } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const handleExpandChapter = async (chapterId: string) => {
    if (expandedChapterId === chapterId) {
      setExpandedChapterId(null);
      return;
    }
    setExpandedChapterId(chapterId);
    if (!stats[chapterId]) {
      const s = await getChapterForeshadowStats(chapterId);
      setStats((prev) => ({ ...prev, [chapterId]: s }));
    }
  };

  const handleAdoptCandidate = (candidate: AuditCandidate) => {
    setDialogInitial({
      title: candidate.suggestedTitle,
      intent: candidate.suggestedIntent,
    });
    setDialogOpen(true);
  };

  if (chapters.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {t("foreshadow.chapter.noChapters", "章がありません")}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="border-b border-border/50 px-3 py-2">
        <button
          type="button"
          data-testid="foreshadow-open-extraction-review"
          onClick={() => setReviewOpen(true)}
          className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-border px-2 py-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Sparkles className="h-3 w-3" />
          {t("foreshadow.reviewExtract.open", "伏線候補レビュー（プレビュー）")}
        </button>
      </div>

      {chapters.map((chapter) => {
        const isExpanded = expandedChapterId === chapter.id;
        const chapterStats = stats[chapter.id];
        const isAuditing = auditingChapterIds.has(chapter.id);
        const results = auditResults[chapter.id] ?? [];

        return (
          <div key={chapter.id} className="border-b border-border/50">
            {/* Chapter header */}
            <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50">
              <button
                type="button"
                data-testid={`foreshadow-chapter-expand-${chapter.id}`}
                onClick={() => void handleExpandChapter(chapter.id)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>

              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {chapter.title}
              </span>

              {chapterStats && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {chapterStats.scenesWithBody}/{chapterStats.totalScenes}
                </span>
              )}

              <button
                type="button"
                data-testid={`foreshadow-chapter-audit-${chapter.id}`}
                disabled={isAuditing}
                onClick={() => void auditChapter(chapter.id)}
                className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {isAuditing ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Sparkles className="h-2.5 w-2.5" />
                )}
                {t("foreshadow.chapter.audit", "AI 監査")}
              </button>
            </div>

            {/* Expanded: audit results */}
            {isExpanded && results.length > 0 && (
              <div className="bg-muted/20 pb-1 pl-6 pr-3">
                {results.map((candidate, idx) => (
                  <div
                    key={idx}
                    data-testid={`foreshadow-audit-candidate-${chapter.id}-${idx}`}
                    className="mt-1 rounded border border-border/60 bg-background p-1.5 text-[10px]"
                  >
                    <div className="flex items-center gap-1">
                      <span className="font-medium text-foreground">
                        {candidate.suggestedTitle}
                      </span>
                      <span
                        className={`rounded px-1 py-0.5 text-[9px] ${
                          candidate.confidence === "high"
                            ? "bg-green-500/15 text-green-600 dark:text-green-400"
                            : candidate.confidence === "medium"
                              ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {candidate.confidence}
                      </span>
                    </div>
                    {candidate.suggestedIntent && (
                      <p className="mt-0.5 text-muted-foreground">
                        {candidate.suggestedIntent}
                      </p>
                    )}
                    <p className="mt-0.5 italic text-foreground/60">
                      「{candidate.evidenceExcerpt}」
                    </p>
                    <div className="mt-1 flex gap-1">
                      <button
                        type="button"
                        onClick={() => handleAdoptCandidate(candidate)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
                      >
                        {t("foreshadow.chapter.adopt", "伏線として登録")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {dialogOpen && dialogInitial && (
        <CreateForeshadowDialog
          open={dialogOpen}
          projectId={getCurrentProjectId()}
          initialTitle={dialogInitial.title}
          initialIntent={dialogInitial.intent}
          onSave={async () => {
            setDialogOpen(false);
            setDialogInitial(null);
          }}
          onClose={() => {
            setDialogOpen(false);
            setDialogInitial(null);
          }}
        />
      )}

      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("foreshadow.reviewExtract.title", "伏線候補レビュー")}
            </DialogTitle>
          </DialogHeader>
          <ForeshadowExtractionReview proposals={[]} />
          <DialogFooter>
            <button
              type="button"
              onClick={() => setReviewOpen(false)}
              className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              {t("common.close", "閉じる")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
