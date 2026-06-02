import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentScenePseudoCommentView } from "@/features/kouetsu/views/CurrentScenePseudoCommentView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function PseudoCommentSection() {
  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        疑似コメントは現在シーンで生成します。横断表示は「コメント」タブへ。
      </div>
    );
  }

  if (scope === "ignored") {
    return (
      <DismissedAnnotationsView
        category="pseudo_comment"
        emptyLabel="無視した疑似コメントはありません"
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
  return <CurrentScenePseudoCommentView sceneId={activeSceneId} />;
}
