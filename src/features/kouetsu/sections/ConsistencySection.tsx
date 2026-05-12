import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { PostEffectAnnotationPanel } from "@/features/post-effect/PostEffectAnnotationPanel";
import { ProjectAnnotationsView } from "@/features/kouetsu/views/ProjectAnnotationsView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function ConsistencySection() {
  const scope = useKouetsuStore((s) => s.activeIssuesScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectAnnotationsView />;
  }

  if (scope === "ignored") {
    return <DismissedAnnotationsView />;
  }

  // current scope
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        シーンを選択してください
      </div>
    );
  }
  return <PostEffectAnnotationPanel sceneId={activeSceneId} />;
}
