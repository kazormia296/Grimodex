import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { listPhasesByEntryIds } from "@/features/codex/phaseApi";
import { codexSemanticSearch } from "@/features/semantic-search/api";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { CoreCodexReadContext } from "@/../electron/shared/mastraRead/ports";
import { countTokens } from "../contextBuilder";

/**
 * renderer の Codex read tool 4 本（search_codex・list_codex_by_type・search_codex_by_tags・
 * find_related_entries）の ports（MP-4b PR-8b、DR-MP4-40）。getter は呼出しの時点で live な値を返す
 * （tree store・phase store・`db`）。import の束縛は arrow の中で読むので、試験の `vi.mock`
 * （`@/db/client` の chain、`@/features/codex/phaseApi`、`useTreeStore` の差し替え、`@/lib/tauri`、
 * `@/features/semantic-search/api`）が今までどおり効く。
 *
 * - Phase は loader port：renderer の `listPhasesByEntryIds` をそのまま呼ぶ（`toolExecutors.codexHidden.test.ts`
 *   が phaseApi を mock する seam を保つ）。entries は `getDb()` で読む。
 * - `getPhaseState` は phase store を呼出しの時点（Phase の読みの後）で読む。legacy は `resolutionMode` が
 *   常に在る（unresolved が無い）ので `resolved` で渡す。
 * - `getProjectEpoch` は phase store の `projectEpoch`。判定の途中で project が切り替わったら全部 hidden
 *   にする検査（DR-MP4-41 (b)）が、legacy の `resolveCodexForAi` から core の判定へ移っても保たれる。
 * - fts は args を加工せずそのまま渡す（command・引数・scope・limit は core が決める）。
 * - dense は、失敗（feature 無効・未 index・モデル不在）を warn して空配列に握る。握りの置き場は
 *   **この port の中だけ**（core と main は握らない：cancel・timeout・workspace の変更が「0 件」に化けない）。
 *   core の narrow の失敗はこの外なので握られない。`codexSemanticSearch` の workspace 照合は今のまま。
 */
export const LEGACY_CODEX_READ_CONTEXT: CoreCodexReadContext = {
  getDb: () => db,
  getTreeState: () => useTreeStore.getState(),
  countTokens: (text) => countTokens(text),
  getPhaseState: () => {
    const { sceneTimeIndex, resolutionMode } = usePhaseStore.getState();
    return {
      sceneTimeIndex,
      resolutionMode: { kind: "resolved", mode: resolutionMode },
    };
  },
  getProjectEpoch: () => usePhaseStore.getState().projectEpoch,
  codex: { listPhases: (entryIds) => listPhasesByEntryIds([...entryIds]) },
  native: {
    fts: (args) => invoke("fts_search", args),
    codexSemantic: (args) =>
      codexSemanticSearch(args).catch((e) => {
        debugLog.warn(
          "search_codex",
          "dense codex search failed (sparse-only fallback)",
          errorDetail(e),
        );
        return [];
      }),
  },
};
