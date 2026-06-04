import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneIntentDriftView } from "@/features/kouetsu/views/CurrentSceneIntentDriftView";
import { ProjectIntentDriftView } from "@/features/kouetsu/views/ProjectIntentDriftView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function IntentDriftSection() {
  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectIntentDriftView />;
  }

  if (scope === "ignored") {
    return (
      <DismissedAnnotationsView
        category="intent_anchor"
        emptyLabel="無視した狙いズレ指摘はありません"
      />
    );
  }

  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        シーンを選択してください
      </div>
    );
  }
  return <CurrentSceneIntentDriftView sceneId={activeSceneId} />;
}
