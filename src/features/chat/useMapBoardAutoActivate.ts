import { useEffect } from "react";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useMapStore } from "@/features/map/mapStore";
import { useChatStore } from "./chatStore";

/**
 * Map overlay (`includeMapBoard`) を Map panel の可視状態と activeBoardId に
 * 完全追従させる:
 *   - Map panel が visible & activeBoardId 有り → ON + 対象 board に同期
 *   - Map panel が hidden もしくは board 未選択 → OFF
 *   - activeBoardId が切り替わったら mapBoardId も追従
 *
 * 手動トグルは UI からも可能だが、次の panel state / board 変更で再同期される。
 */
export function useMapBoardAutoActivate(): void {
  const mapPanelActive = useLayoutStore((s) => s.isPanelActive("map"));
  const activeBoardId = useMapStore((s) => s.activeBoardId);

  useEffect(() => {
    const setIncludeMapBoard = useChatStore.getState().setIncludeMapBoard;
    if (mapPanelActive && activeBoardId) {
      setIncludeMapBoard(true, { source: "auto", boardId: activeBoardId });
    } else {
      setIncludeMapBoard(false, { source: "auto" });
    }
  }, [mapPanelActive, activeBoardId]);
}
