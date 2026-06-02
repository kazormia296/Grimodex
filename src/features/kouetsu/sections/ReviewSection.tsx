import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneReviewView } from "@/features/kouetsu/views/CurrentSceneReviewView";
import { ProjectReviewView } from "@/features/kouetsu/views/ProjectReviewView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function ReviewSection() {
  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectReviewView />;
  }

  if (scope === "ignored") {
    return (
      <DismissedAnnotationsView
        category="review"
        emptyLabel="無視したレビュー指摘はありません"
      />
    );
  }

  // current scope
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        シーンを選択してください
      </div>
    );
  }
  return <CurrentSceneReviewView sceneId={activeSceneId} />;
}
