import { useMemo } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  resolveKouetsuScope,
  useKouetsuStore,
  type KouetsuScope,
} from "./kouetsuStore";

/**
 * persist された folder anchor が現ツリーに存在しないとき project へ正規化した
 * scope を返す。Project 系ビュー / KouetsuScopeBar は生の store scope ではなく
 * 必ずこれを参照し、宙に浮いた folder anchor による全空表示 + 無音 no-op を防ぐ。
 * 書き込み（setScope）は従来どおり生 store に対して行う。
 */
export function useResolvedKouetsuScope(): KouetsuScope {
  const scope = useKouetsuStore((s) => s.scope);
  const nodes = useTreeStore((s) => s.nodes);
  return useMemo(() => resolveKouetsuScope(scope, nodes), [scope, nodes]);
}
