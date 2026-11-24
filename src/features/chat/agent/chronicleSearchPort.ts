import { eventsSemanticSearch } from "@/features/semantic-search/api";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  CHRONICLE_SEARCH_TOOL_NAMES,
  createChronicleSearchExecutors,
  type ChronicleSearchToolName,
} from "@/../electron/shared/readDomain/core/chronicleReadExecutors";
import {
  CoreProjectRequiredError,
  type CoreChronicleSearchContext,
} from "@/../electron/shared/mastraRead/ports";
import { LEGACY_CHRONICLE_READ_CONTEXT } from "./chronicleReadContext";
import type { ToolResult } from "./agentTypes";

/**
 * renderer の search_events（IR なし・scope なしの部分）の薄い層（MP-4b PR-7b、DR-MP4-38）。本体は
 * 共有 core（`electron/shared/readDomain/core/chronicleSearchTools.ts`）にあり、ここは
 * (1) dense の失敗を「warn して空」に握る port（唯一の置き場）、(2) project が無いときの core
 * の throw を従来の `No active project` の結果に戻す、の 2 つだけ。core と main は dense の失敗を
 * 握らない（cancel・
 * timeout・workspace の変更が「0 件」に化けない）。
 */
type ToolReturn = Omit<ToolResult, "toolCallId">;

/**
 * dense（`events_semantic_search`）。feature 無効ビルド・未 index・モデル不在などの reject は、
 * warn して空配列に退避する（検索の失敗でチャットを止めない）。scope あり・IR 経路の
 * `chronicleCandidates` も同じ関数を使う（握りの置き場を 1 つにする）。
 */
export function denseEventHitsOrEmpty(args: {
  projectId: string;
  query: string;
  limit: number;
}): ReturnType<typeof eventsSemanticSearch> {
  return eventsSemanticSearch(args).catch((e) => {
    debugLog.warn(
      "search_events",
      "dense events search failed (empty fallback)",
      errorDetail(e),
    );
    return [] as Awaited<ReturnType<typeof eventsSemanticSearch>>;
  });
}

/**
 * renderer の ports：tree・token 数は年表 4 本の ctx（`chronicleReadContext.ts`）から使い、
 * dense だけを握りつきの上の関数にする。`@/db/client` は import しない。
 */
export const LEGACY_CHRONICLE_SEARCH_CONTEXT: CoreChronicleSearchContext = {
  getTreeState: LEGACY_CHRONICLE_READ_CONTEXT.getTreeState,
  countTokens: LEGACY_CHRONICLE_READ_CONTEXT.countTokens,
  native: { eventsSemantic: (args) => denseEventHitsOrEmpty(args) },
};

/**
 * project が無いときの結果の content（core は projectId を必須にして throw する）。
 * 毎回新しく作る（呼び手が書き換えても次の結果に漏れない）。
 */
export const CHRONICLE_SEARCH_NO_PROJECT_CONTENT: Record<
  ChronicleSearchToolName,
  () => unknown
> = {
  search_events: () => [],
};

const CHRONICLE_SEARCH_EXECUTORS = createChronicleSearchExecutors(
  LEGACY_CHRONICLE_SEARCH_CONTEXT,
);

/**
 * 旗が false で scope なしの search_events（呼出しごとに評価する分岐は `toolExecutors.ts` の
 * `searchEvents` の先頭にある）。空の query は core が先に答える（project の検査より前）。
 */
export async function chronicleSearchExecutor(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  try {
    return await CHRONICLE_SEARCH_EXECUTORS.search_events(params);
  } catch (e) {
    if (e instanceof CoreProjectRequiredError) {
      return {
        name: "search_events",
        content: CHRONICLE_SEARCH_NO_PROJECT_CONTENT.search_events(),
        summary: "No active project",
        tokensUsed: 0,
      };
    }
    throw e;
  }
}

export { CHRONICLE_SEARCH_TOOL_NAMES };
