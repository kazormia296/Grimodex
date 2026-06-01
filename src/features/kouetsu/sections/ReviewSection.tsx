import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneReviewView } from "@/features/kouetsu/views/CurrentSceneReviewView";
import { ProjectReviewView } from "@/features/kouetsu/views/ProjectReviewView";

export function ReviewSection() {
  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectReviewView />;
  }

  // current scope (ignored は Editorial スコープバーに無い)
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        シーンを選択してください
      </div>
    );
  }
  return <CurrentSceneReviewView sceneId={activeSceneId} />;
}
