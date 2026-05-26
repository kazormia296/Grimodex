import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneTypoView } from "@/features/kouetsu/views/CurrentSceneTypoView";
import { ProjectTypoView } from "@/features/kouetsu/views/ProjectTypoView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function TypoSection() {
  const scope = useKouetsuStore((s) => s.activeIssuesScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectTypoView />;
  }

  if (scope === "ignored") {
    // MVP: typo 専用 dismiss view は作らず、整合性と同じ DismissedAnnotationsView を流用
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
  return <CurrentSceneTypoView sceneId={activeSceneId} />;
}
