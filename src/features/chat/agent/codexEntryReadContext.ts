import { db } from "@/db/client";
import { listRawDetailValuesByEntryIds } from "@/features/codex/detailApi";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import {
  listDetailOverridesByPhaseIds,
  listPhasesByEntryIds,
} from "@/features/codex/phaseApi";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { CoreCodexEntryContext } from "@/../electron/shared/mastraRead/ports";
import { countTokens } from "../contextBuilder";

type RendererCodexEntryContext = CoreCodexEntryContext & {
  getProjectEpoch: () => number;
};

/** `get_codex_entry` の renderer ports。store・DB・抽出器は呼出し時に読む。 */
export const LEGACY_CODEX_ENTRY_CONTEXT: RendererCodexEntryContext = {
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
  codex: {
    listPhases: (entryIds) => listPhasesByEntryIds([...entryIds]),
    listPhaseDetailOverrides: (phaseIds) =>
      listDetailOverridesByPhaseIds([...phaseIds]),
    listRawDetailValues: (entryIds) =>
      listRawDetailValuesByEntryIds([...entryIds]),
  },
  extractPlainText: (json) => extractPlainText(json),
};
