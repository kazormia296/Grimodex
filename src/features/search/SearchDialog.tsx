import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { SemanticSearchDialog } from "@/features/semantic-search/SemanticSearchDialog";
import { useSearchModeStore } from "./searchModeStore";

/**
 * Ctrl+Shift+F で開く検索 Dialog の入口。
 *
 * `useSearchModeStore` から最後に使ったモードを読み、字句検索 (FTS5) か
 * セマンティック検索のどちらかを描画する。両 Dialog はそれぞれ独自に
 * Modal chrome を持つが、上部のタブで相互に切り替えできる
 * (タブクリックで `setMode` → 親 (本コンポーネント) が再 render → 切替)。
 *
 * 最後に使ったモードは localStorage に永続化されるので、ユーザは
 * 一度切り替えれば次回以降そのモードで開く。
 */
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const mode = useSearchModeStore((s) => s.mode);
  return mode === "semantic" ? (
    <SemanticSearchDialog onClose={onClose} />
  ) : (
    <GlobalSearchDialog onClose={onClose} />
  );
}
