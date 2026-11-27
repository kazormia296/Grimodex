import {
  CHRONICLE_READ_TOOL_NAMES,
  createChronicleReadExecutors,
  type ChronicleReadToolName,
} from "@/../electron/shared/readDomain/core/chronicleReadExecutors";
import { CoreProjectRequiredError } from "@/../electron/shared/mastraRead/ports";
import {
  createLegacyChronicleReadContext,
  LEGACY_CHRONICLE_READ_CONTEXT,
} from "./chronicleReadContext";
import type { ChatToolRunContext } from "./chatTurnToolScope";
import type { AgentToolAuthorization } from "./agentTypes";
import type { ToolResult } from "./agentTypes";

/**
 * renderer の年表 read tool 4 本の薄い層（MP-4b PR-7a、DR-MP4-37）。本体は共有 core
 * （`electron/shared/readDomain/core/chronicleTools.ts`）にあり、ここは renderer の ports
 * （`chronicleReadContext.ts`）を渡し、turn context の scene を固定する。project が無いときの core の
 * throw は従来の `No active project` の結果に戻す。
 */
type ToolReturn = Omit<ToolResult, "toolCallId">;

const CHRONICLE_EXECUTORS = createChronicleReadExecutors(
  LEGACY_CHRONICLE_READ_CONTEXT,
);

/**
 * project が無いときの結果の content（core は projectId を必須にして throw する）。
 * project の検査は引数の検査より先なので、順序は移す前のまま。毎回新しく作る
 * （呼び手が書き換えても次の結果に漏れない）。
 */
export const CHRONICLE_NO_PROJECT_CONTENT: Record<
  ChronicleReadToolName,
  () => unknown
> = {
  list_events: () => ({ events: [] }),
  get_event_detail: () => null,
  get_character_timeline: () => ({ events: [] }),
  get_chronicle_state: () => null,
};

function chronicleReadExecutor(
  name: ChronicleReadToolName,
): (
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
  context?: ChatToolRunContext,
) => Promise<ToolReturn> {
  return async (params, _requestId, _authorization, context) => {
    const currentSceneId =
      context?.currentSceneId !== undefined
        ? context.currentSceneId
        : context?.scope?.currentSceneId;
    const run =
      currentSceneId === undefined
        ? CHRONICLE_EXECUTORS[name]
        : createChronicleReadExecutors(
            createLegacyChronicleReadContext(currentSceneId),
          )[name];
    try {
      return await run(params);
    } catch (e) {
      if (e instanceof CoreProjectRequiredError) {
        return {
          name,
          content: CHRONICLE_NO_PROJECT_CONTENT[name](),
          summary: "No active project",
          tokensUsed: 0,
        };
      }
      throw e;
    }
  };
}

/** 作中順イベント一覧（kind フィルタ可）。XPROJ=listEvents が project gate。 */
export const listEventsTool = chronicleReadExecutor("list_events");
/** 単一イベント詳細（参加者/紐づきシーン/因果）。XPROJ=project の events に在ること。 */
export const getEventDetailTool = chronicleReadExecutor("get_event_detail");
/** 人物の作中経歴（primary/participant で関与した出来事を作中順・各時点の年齢）。 */
export const getCharacterTimelineTool = chronicleReadExecutor(
  "get_character_timeline",
);
/** 現在(または指定)シーンの作中時刻における世界状態スナップショット（構造化JSON）。 */
export const getChronicleStateTool = chronicleReadExecutor(
  "get_chronicle_state",
);

export { CHRONICLE_READ_TOOL_NAMES };
