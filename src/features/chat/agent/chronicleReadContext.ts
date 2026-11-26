import i18next from "@/lib/i18n";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  listEventParticipantsForProject,
  listEventRelations,
  getProjectCalendar,
} from "@/features/chronicle/api";
import type { CoreChronicleReadContext } from "@/../electron/shared/mastraRead/ports";
import { countTokens } from "../contextBuilder";
import {
  getSharedEvents,
  getSharedSceneEvents,
  getSharedCodexNames,
  getSharedReadingOrder,
} from "./chronicleToolCache";

/**
 * renderer の年表 read tool 4 本の ports（MP-4b PR-7a、DR-MP4-37）。通常は getter が tree store の
 * live な値を返し、turn の tool context があれば scene だけ開始時の値に固定する。
 * 年表のデータは、今までと同じ loader を arrow の中で呼んで取る：
 * cache（`chronicleToolCache.ts` の module singleton。バッチごとに破棄される）、`chronicle/api`、
 * 読む順の memo（nodes の参照で key する）。import の束縛は arrow の中で読むので、試験の
 * `vi.mock`（`@/features/chronicle/api`・`@/features/codex/api`・`treeStore`・`phaseResolver`・
 * `./chronicleToolCache`）が今までどおり効く。
 *
 * この module は `@/db/client` を import しない（年表の tool は DB を直接読まない。`chronicle/api` が
 * 自分の `db` で共有の reader を呼ぶ）。UI 言語は `i18next.language === "en"` の完全一致だけが en
 * （`"en-US"` は ja）。Main の出所は未決（Q4）で、ここでは置かない。
 */
export function createLegacyChronicleReadContext(
  currentSceneId?: string | null,
): CoreChronicleReadContext {
  const getTreeState = () => {
    const state = useTreeStore.getState();
    return currentSceneId === undefined
      ? state
      : { ...state, activeSceneId: currentSceneId };
  };
  return {
    getTreeState,
    countTokens: (text) => countTokens(text),
    getUiLanguage: () => (i18next.language === "en" ? "en" : "ja"),
    chronicle: {
      getEvents: (projectId) => getSharedEvents(projectId),
      getSceneEvents: (projectId) => getSharedSceneEvents(projectId),
      getCodexNames: (projectId) => getSharedCodexNames(projectId),
      listHiddenCodexIds: async (projectId, ids) => {
        const { listCodexIdsHiddenFromAi } =
          await import("@/features/codex/context/codexHiddenFromAi");
        return listCodexIdsHiddenFromAi({
          entryIds: ids,
          projectId,
          sceneId:
            currentSceneId === undefined
              ? useTreeStore.getState().activeSceneId
              : currentSceneId,
        });
      },
      // core は getTreeState().nodes の参照をそのまま渡す（memo が外れない）。
      getReadingOrder: (nodes) =>
        getSharedReadingOrder(nodes as TreeNodeData[]),
      // 引数の個数も今までどおり（全件のときは projectId だけで呼ぶ）。
      listParticipants: (projectId, eventIds) =>
        eventIds === undefined
          ? listEventParticipantsForProject(projectId)
          : listEventParticipantsForProject(projectId, eventIds),
      listRelations: (projectId) => listEventRelations(projectId),
      getCalendar: (projectId) => getProjectCalendar(projectId),
    },
  };
}

export const LEGACY_CHRONICLE_READ_CONTEXT = createLegacyChronicleReadContext();
