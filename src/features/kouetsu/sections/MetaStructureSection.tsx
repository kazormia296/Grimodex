import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { MetaStructureView } from "@/features/kouetsu/views/MetaStructureView";

export function MetaStructureSection() {
  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <MetaStructureView scope="project" />;
  }

  if (scope === "ignored") {
    // メタ構造は scene_lens 由来で dismiss の概念を持たない (annotation ではない)。
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        メタ構造に除外項目はありません
      </div>
    );
  }

  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        シーンを選択してください
      </div>
    );
  }
  return <MetaStructureView scope="current" sceneId={activeSceneId} />;
}
