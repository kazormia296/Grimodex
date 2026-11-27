import { invoke } from "@/lib/tauri";
import { loadSceneContent, loadSceneContents } from "@/features/tree/api";
import { db } from "@/db/client";
import {
  createReadExecutors,
  type CoreReadToolName,
} from "@/../electron/shared/readDomain/core/readExecutors";
import {
  createCodexReadExecutors,
  type CodexReadToolName,
} from "@/../electron/shared/readDomain/core/codexReadExecutors";
import { LEGACY_CODEX_READ_CONTEXT } from "./codexReadContext";
import { createCodexEntryExecutors } from "@/../electron/shared/readDomain/core/codexEntryExecutors";
import { LEGACY_CODEX_ENTRY_CONTEXT } from "./codexEntryReadContext";
import {
  CoreProjectRequiredError,
  type CoreReadContext,
} from "@/../electron/shared/mastraRead/ports";
import { countTokens } from "../contextBuilder";
import { useTreeStore } from "@/features/tree/treeStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import {
  readForeshadowListWithLabelsWire,
  readOpenForeshadowWire,
} from "@/features/foreshadow/api";
import type { AgentToolAuthorization, ToolResult } from "./agentTypes";
import type {
  ChatReadOnlyToolRunContext,
  ChatToolRunContext,
  ChatTurnToolScope,
} from "./chatTurnToolScope";
import {
  CHAT_AGENT_IR_CHRONICLE_IDS_MAX,
  isChronicleEventIdList,
} from "@/../electron/shared/chatAgentIrWire";
import { CHAT_AGENT_IR_ENABLED } from "./chatAgentIrAvailability";
import {
  CHAT_IR_MAX_CALLS_PER_TURN,
  CHAT_IR_MAX_CHARS_PER_TURN,
  capExceededResult,
  fitChatIrContent,
  precheckChatIrContent,
  type ChatIrOutcomeShape,
  type ChatIrToolContentResult,
} from "./chatIrToolResult";
import {
  agentCreateCodexEntry,
  agentUpdateCodexEntry,
} from "@/features/agent-writes/codex";
import { agentCreateSnippet } from "@/features/agent-writes/snippet";
import { agentMarkdownToProseMirrorJson } from "@/features/agent-writes/richTextInput";
import { normalizeMastraAgentWriteInput } from "@/../electron/shared/agentWriteNormalization";
import {
  agentCreateForeshadow,
  agentUpdateForeshadow,
  type AgentForeshadowLoadBearing,
} from "@/features/agent-writes/foreshadow";
import {
  listEventsTool,
  getEventDetailTool,
  getCharacterTimelineTool,
  getChronicleStateTool,
} from "./chronicleReadTools";
import {
  chronicleSearchExecutor,
  denseEventHitsOrEmpty,
} from "./chronicleSearchPort";
import {
  eventSearchFetchLimit,
  eventSearchLimit,
} from "@/../electron/shared/readDomain/core/chronicleSearchTools";
import { agentApplyTreePlan } from "@/features/agent-writes/tree";
import { agentProposeSceneBody } from "@/features/agent-writes/prose";
import { useProseStagingStore } from "@/features/agent-writes/proseStagingStore";
import type { AiTreePlan } from "@/features/tree/aiScaffold/types";
import type { EventSearchHit } from "@/features/semantic-search/api";
import {
  isEventBeforeOrAtScene,
  passesIrExclusionApproximation,
} from "@/features/chronicle/chronicleReadingPosition";
import { chronicleRevealMarks } from "@/../electron/shared/readDomain/features/chronicle/chronicleRevealMark";
import {
  getSharedEvents,
  getSharedSceneEvents,
  getSharedReadingOrder,
  invalidateChronicleToolCache,
} from "./chronicleToolCache";

// ---------------------------------------------------------------------------
// Codex の read tool は共有 core へ移した。
// ---------------------------------------------------------------------------

/**
 * search_events の年表の候補（IR の位置 filter の後で、`slice(limit)` の前）。
 * 空の query・project 無しは、そのまま返す応答（`empty`）。呼ぶ位置が挙動の一部なので、
 * await の順は変えない（定数 false の間は今と byte 同一）。
 */
type ChronicleCandidates =
  | { readonly kind: "empty"; readonly result: Omit<ToolResult, "toolCallId"> }
  | {
      readonly kind: "ready";
      readonly query: string;
      readonly projectId: string;
      readonly currentSceneId: string;
      /** model の `limit`（年表の側の値。IR の枠の下限 1 は呼び手が決める）。 */
      readonly limit: number;
      /** IR の位置 filter の後、`slice` の前（30 件以下）。 */
      readonly visible: readonly EventSearchHit[];
      /** △7 (4) の近似の規則（secret の event だけに掛かる）。 */
      readonly passesApproximation: (hit: EventSearchHit) => boolean;
      /** 開示シーンの印（共有の core の search_events と同じ。DR-CPL-6）。 */
      readonly revealOf: ReturnType<typeof chronicleRevealMarks>;
    };

async function chronicleCandidates(
  params: Record<string, unknown>,
  scope?: ChatTurnToolScope,
  turnSceneId?: string | null,
): Promise<ChronicleCandidates> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      kind: "empty",
      result: {
        name: "search_events",
        content: [],
        summary: "0 events found",
        tokensUsed: 0,
      },
    };

  // project は IR scope、Scene は turn 固定値があればそれ、無ければ scope/store を使う。
  const projectId = chronicleProjectId(scope);
  if (!projectId)
    return {
      kind: "empty",
      result: {
        name: "search_events",
        content: [],
        summary: "No active project",
        tokensUsed: 0,
      },
    };

  const limit = eventSearchLimit(params);

  // IR の位置 filter で hit が減る場合に備えて over-fetch（≤30=backendMax）→ filter → slice(limit)。
  const fetchLimit = eventSearchFetchLimit(limit);
  const hits = await denseEventHitsOrEmpty({
    projectId,
    query,
    limit: fetchLimit,
  });

  const allEvents = await getSharedEvents(projectId);
  const sceneEvents = await getSharedSceneEvents(projectId);
  const nodes = useTreeStore.getState().nodes;
  const readingOrder = getSharedReadingOrder(nodes);
  // scene pin が無い呼び手だけ、従来どおり await の後で今の Scene を読む。
  const currentSceneId = chronicleSceneId(scope, turnSceneId);
  const visible = hits
    // 位置の filter（chat IR S1-B）。slice(limit) の前。
    // 定数が false の間は掛けない（今の挙動のまま）。
    .filter(
      (h) =>
        !CHAT_AGENT_IR_ENABLED ||
        isEventBeforeOrAtScene({ id: h.eventId }, currentSceneId, {
          readingOrder,
          sceneEvents,
        }),
    );
  const eventById = new Map(allEvents.map((e) => [e.id, e]));
  return {
    kind: "ready",
    query,
    projectId,
    currentSceneId,
    limit,
    visible,
    revealOf: chronicleRevealMarks(
      visible.flatMap((h) => eventById.get(h.eventId) ?? []),
      () => ({
        nodes,
        currentSceneId: currentSceneId || null,
        readingOrder,
      }),
    ),
    // 行が見つからない hit は近似の対象外として扱う。
    passesApproximation: (h) =>
      passesIrExclusionApproximation(
        eventById.get(h.eventId) ?? { id: h.eventId, secret: false },
        currentSceneId,
        { readingOrder, sceneEvents },
      ),
  };
}

/** search_events が model に返す年表の 1 件（今の形のまま）。 */
interface ChronicleEntry {
  eventId: string;
  title: string;
  kind: string;
  score: number;
  revealScene?: ReturnType<
    ReturnType<typeof chronicleRevealMarks>
  >["revealScene"];
}

/**
 * Native へ渡す候補（DR-CHATIR-S1-41）：重複を除き、wire の 1 件の条件（空白だけでない・200 UTF-16
 * 以下）に合わない ID と、30 件を超える分は送らない。送らなかった event は年表にそのまま残る。
 * 条件に合わない ID が 1 つでも混じると wrapper が IPC の前に拒むので、ここで外す。
 */
function chronicleCandidateIds(hits: readonly EventSearchHit[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.eventId)) continue;
    seen.add(hit.eventId);
    if (!isChronicleEventIdList([hit.eventId])) continue;
    ids.push(hit.eventId);
    if (ids.length >= CHAT_AGENT_IR_CHRONICLE_IDS_MAX) break;
  }
  return ids;
}

function chronicleEntries(
  hits: readonly EventSearchHit[],
  limit: number,
  revealOf: ReturnType<typeof chronicleRevealMarks>,
): ChronicleEntry[] {
  return hits.slice(0, limit).map((h) => ({
    eventId: h.eventId,
    title: h.title,
    kind: h.kind,
    score: h.score,
    ...revealOf(h.eventId),
  }));
}

/**
 * 作中年表 (Chronicle) 出来事の dense セマンティック検索 (Phase 3)。
 * `events_semantic_search` を叩く dense-only ツール (codex のような FTS 融合なし)。
 * feature 無効ビルド / 未 index / モデル不在では reject → 空配列にグレースフルに退避。
 *
 * IR を呼ばない呼び手（research sub-agent など）の経路でもある。定数が true で turn の
 * scope があるときは、IR の除外の結果が得られないので、secret の event に近似の規則
 * （結ばれた Scene がすべて今の Scene より前）を掛ける（chat IR S1-A2b、DR-CHATIR-S1-45）。
 * 掛ける位置は (4) と同じで、`slice(limit)` の前（落とした分は後ろの候補で補う）。
 * 定数が false の間は何も掛けない（今と byte 同一）。
 */
async function searchEvents(
  params: Record<string, unknown>,
  context?: ChatToolRunContext,
): Promise<Omit<ToolResult, "toolCallId">> {
  // No IR scope: preserve the shared core path, while pinning its Chronicle ports to the turn scene.
  if (!CHAT_AGENT_IR_ENABLED && !context?.scope)
    return chronicleSearchExecutor(params, context?.currentSceneId);
  const candidates = await chronicleCandidates(
    params,
    context?.scope,
    context?.currentSceneId,
  );
  if (candidates.kind === "empty") return candidates.result;
  const pool =
    CHAT_AGENT_IR_ENABLED && context?.scope
      ? candidates.visible.filter(candidates.passesApproximation)
      : candidates.visible;
  const content = chronicleEntries(pool, candidates.limit, candidates.revealOf);
  const json = JSON.stringify(content);
  return {
    name: "search_events",
    content,
    summary: `${content.length} events found`,
    tokensUsed: countTokens(json),
  };
}

/** search_events の基準の project。scope があればそれ、無ければ今の tree store。 */
function chronicleProjectId(scope?: ChatTurnToolScope): string | null {
  return scope ? scope.projectId || null : useTreeStore.getState().projectId;
}

/** search_events の基準の Scene。scope が無ければ読んだ時点の tree store を使う。 */
function chronicleSceneId(
  scope?: ChatTurnToolScope,
  turnSceneId?: string | null,
): string {
  return turnSceneId !== undefined
    ? (turnSceneId ?? "")
    : scope
      ? (scope.currentSceneId ?? "")
      : (useTreeStore.getState().activeSceneId ?? "");
}

/**
 * turn の累積の文字数上限（DR-CHATIR-S1-38）は合計で守る：先頭から、残りの枠に収まる item
 * だけを残す。item はあったのに 1 件も収まらなければ `turn-limit`。
 */
function withinTurnChars(
  status: ChatIrOutcomeShape["status"],
  items: ChatIrOutcomeShape["items"],
  usedChars: number,
): ChatIrOutcomeShape {
  if (!items || items.length === 0) return { status, items };
  let left = CHAT_IR_MAX_CHARS_PER_TURN - usedChars;
  const kept: NonNullable<ChatIrOutcomeShape["items"]>[number][] = [];
  for (const item of items) {
    const chars = JSON.stringify(item).length;
    if (chars > left) break;
    kept.push(item);
    left -= chars;
  }
  return kept.length > 0 ? { status, items: kept } : { status: "turn-limit" };
}

/** The renderer's own refusals before the IPC: not a call of Native, not counted. */
const CHAT_IR_PREFLIGHT_STATUSES: ReadonlySet<string> = new Set([
  "no-current-scene",
  "query-invalid",
  "no-workspace",
]);

/**
 * search_events に承認済みの IR を合流する版（main agent の `EXECUTORS` だけ。
 * chat IR S1-B・S1-A2b、定数が true で IR の capability がある呼び手のときだけ）。
 *
 * 順は直列：年表の候補（IR の位置 filter、`slice` の前）→ 事前判定 → turn の累積上限 →
 * Native を 1 回（候補の eventId を渡す）→ assertCurrent → 除外 → 切り → cap と統合 →
 * noteUsedIds → content（B-T13）。IR の失敗は tool の失敗にせず、status を content に載せる。
 * IR の capability が無い呼び手（sub-agent など）は共有の `searchEvents`（今の配列）。
 *
 * 年表から除くもの（DR-CHATIR-S1-44・45）：
 * - Native が除外の配列を返したとき：本来の (4)。配列の event を `slice` の前に除き、後ろの候補で補う。
 * - 配列が無く、model が起こせる不明（事前判定の `cap-exceeded`・呼ぶ前の `turn-limit`・
 *   `query-invalid`・Native の `ledger-full`）のとき：Native の答えの代わりに、secret の event に
 *   近似の規則を同じ位置で掛ける。`ledger-full` は、Native の ledger（4096 件、追い出し無し）を
 *   model が query を変え続けて満たせるので、満ちた後は process の終わりまで続く（T20）。
 * - それ以外の失敗（一時的・構造的）：何も除かない（今の年表のまま。U-a）。
 */
async function searchEventsWithIr(
  params: Record<string, unknown>,
  _requestId?: string,
  _authorization?: AgentToolAuthorization,
  context?: ChatToolRunContext,
): Promise<Omit<ToolResult, "toolCallId">> {
  const ir = context?.ir;
  if (!CHAT_AGENT_IR_ENABLED || !ir) {
    return searchEvents(params, context);
  }
  const candidates = await chronicleCandidates(
    params,
    context.scope,
    context.currentSceneId,
  );
  // 空の query・project 無しは、年表の側の応答（空の配列）のまま返す。
  if (candidates.kind === "empty") return candidates.result;
  const { query, projectId, currentSceneId, visible, revealOf } = candidates;
  // 0 < limit < 1 の小数は年表では 0 件になるが、IR には 1 件分の枠を残す（空の available を避ける）。
  const yearLimit = candidates.limit;
  const limit = Math.max(1, yearLimit);
  const withoutApproximation = chronicleEntries(visible, yearLimit, revealOf);
  const approximated = () =>
    chronicleEntries(
      visible.filter(candidates.passesApproximation),
      yearLimit,
      revealOf,
    );
  const rest = { tokenCap: ir.tokenCap, countTokens };

  let fitted: ChatIrToolContentResult<ChronicleEntry>;
  // 暫定の年表（近似の前）で測る。近似後の年表が大きくなる場合もある。Native を呼ばない場合も
  // 近似は適用し、失うのは Native の 1 回（回数と ledger の枠）だけ。
  if (precheckChatIrContent({ events: withoutApproximation, ...rest })) {
    // 呼ばなければ (4) は掛からないので、model が起こせる不明として近似の規則に進む。
    fitted = capExceededResult(approximated(), ir.tokenCap, countTokens, false);
  } else {
    let outcome: ChatIrOutcomeShape;
    let events: readonly ChronicleEntry[];
    let eventIds: Readonly<Record<string, string>> = {};
    if (
      ir.counter.calls >= CHAT_IR_MAX_CALLS_PER_TURN ||
      ir.counter.chars >= CHAT_IR_MAX_CHARS_PER_TURN
    ) {
      outcome = { status: "turn-limit" };
      events = approximated();
    } else {
      // 定数の枝の中でだけ wrapper を読む（false の間は bundle に入らない）。
      const { selectChatAgentIr } = await import("@/lib/chatIr");
      const answer = await selectChatAgentIr({
        query,
        projectId,
        expectedWorkspacePath: ir.workspacePath ?? "",
        currentSceneId,
        // IR の位置 filter 後の年表の候補だけ。
        chronicleEventIds: chronicleCandidateIds(visible),
      });
      if (
        !(
          answer.kind === "not-answered" &&
          CHAT_IR_PREFLIGHT_STATUSES.has(answer.status)
        )
      ) {
        ir.counter.calls += 1;
      }
      // project／workspace が turn のものでなくなっていれば、item を返さず tool を失敗にする。
      ir.assertCurrent();
      const excluded =
        answer.kind === "answered" ? answer.excludedEventIds : null;
      if (answer.kind === "answered") {
        eventIds = answer.eventIds;
        outcome = withinTurnChars(
          answer.status,
          answer.items,
          ir.counter.chars,
        );
      } else {
        outcome = { status: answer.status };
      }
      if (excluded !== null) {
        // 本来の (4)。Native が答えたので、turn の文字数の枠で 0 件になったときも配列は手元にある。
        const gone = new Set(excluded);
        events = chronicleEntries(
          visible.filter((hit) => !gone.has(hit.eventId)),
          yearLimit,
          revealOf,
        );
      } else if (
        answer.status === "query-invalid" ||
        answer.status === "ledger-full"
      ) {
        // 除外を返さなかった、model が起こせる不明（DR-CHATIR-S1-45）：renderer の検査か Native が
        // query を拒んだ（query-invalid）、または model が query を変え続けて Native の ledger を
        // 満たした（ledger-full。item の digest は query に依る score を含む。T20）。
        events = approximated();
      } else {
        // 一時的・構造的な失敗：(4) も近似の規則も掛けない。
        events = withoutApproximation;
      }
    }
    const byRevision = new Map(Object.entries(eventIds));
    fitted = fitChatIrContent({
      outcome,
      limit,
      events,
      ...rest,
      merge: {
        eventIdOfItem: (item) => byRevision.get(item.revisionId),
        eventIdOfEvent: (event) => event.eventId,
      },
    });
  }

  const { items } = fitted;
  if (items.length > 0) {
    ir.counter.chars += items.reduce(
      (sum, item) => sum + JSON.stringify(item).length,
      0,
    );
    ir.noteUsedIds(
      params,
      items.map((item) => item.revisionId),
      // model が見たものだけ：統合した item の event（重複は 1 つ）。
      [...new Set(Object.values(fitted.eventIds))],
    );
  }
  const json = JSON.stringify(fitted.content);
  return {
    name: "search_events",
    content: fitted.content,
    // 件数だけ。status・本文・題は入れない（契約 §3.5）。
    summary: `manuscript ${items.length}, chronicle ${fitted.content.events.length}`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Mutating executors (knowledgeWrite policy gated)
// ---------------------------------------------------------------------------

function optionalMarkdownBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("content must be a Markdown string");
  }
  return agentMarkdownToProseMirrorJson(value);
}

async function createCodexEntryTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
  const type = String(params["type"] ?? "").trim();
  const name = String(params["name"] ?? "").trim();
  if (!type || !name) {
    return {
      name: "create_codex_entry",
      content: null,
      summary: "type and name are required",
      tokensUsed: 0,
      error: "type and name are required",
    };
  }
  try {
    const normalized = normalizeMastraAgentWriteInput(
      "create_codex_entry",
      params,
    );
    if (!requestId) {
      throw new Error("create_codex_entry request identity is missing");
    }
    const entry = await agentCreateCodexEntry(
      {
        requestId,
        type,
        name,
        summary: params["summary"] ? String(params["summary"]) : undefined,
        content:
          params["content"] === null
            ? undefined
            : (normalized["content"] as string | undefined),
        aliases: normalized["aliases"] as string | undefined,
        parentId: params["parentId"] ? String(params["parentId"]) : undefined,
      },
      authorization?.chatMessageId,
      authorization
        ? {
            agentAuthorityCapability: authorization.capability,
            chatMessageId: authorization.chatMessageId,
            toolCallId: authorization.toolCallId,
            executionId: authorization.executionId,
            mainOwnedProvenanceId: authorization.mainOwnedProvenanceId,
          }
        : undefined,
    );
    const content = { id: entry.id, name: entry.name, type: entry.type };
    const json = JSON.stringify(content);
    return {
      name: "create_codex_entry",
      content,
      summary: `Created codex entry '${entry.name}' (${entry.type})`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "create_codex_entry",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  } finally {
    // DB 書込成功後に store 再ロード等で throw しても stale 化しないよう finally で破棄。
    invalidateChronicleToolCache();
  }
}

async function updateCodexEntryTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
  const id = String(params["id"] ?? "").trim();
  if (!id) {
    return {
      name: "update_codex_entry",
      content: null,
      summary: "id is required",
      tokensUsed: 0,
      error: "id is required",
    };
  }
  try {
    const normalized = normalizeMastraAgentWriteInput(
      "update_codex_entry",
      params,
    );
    const entry = await agentUpdateCodexEntry(
      {
        requestId,
        entryId: id,
        name: params["name"] !== undefined ? String(params["name"]) : undefined,
        summary:
          params["summary"] !== undefined
            ? String(params["summary"])
            : undefined,
        content:
          params["content"] !== undefined
            ? params["content"] === null
              ? undefined
              : (normalized["content"] as string)
            : undefined,
        aliases: normalized["aliases"] as string | undefined,
      },
      authorization?.chatMessageId,
      {
        writeOpts: authorization
          ? {
              agentAuthorityCapability: authorization.capability,
              chatMessageId: authorization.chatMessageId,
              toolCallId: authorization.toolCallId,
              executionId: authorization.executionId,
              mainOwnedProvenanceId: authorization.mainOwnedProvenanceId,
            }
          : undefined,
      },
    );
    const content = { id: entry.id, name: entry.name, type: entry.type };
    const json = JSON.stringify(content);
    return {
      name: "update_codex_entry",
      content,
      summary: `Updated codex entry '${entry.name}'`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "update_codex_entry",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  } finally {
    invalidateChronicleToolCache();
  }
}

// ---------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------

type Executor = (
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
  context?: ChatToolRunContext,
) => Promise<Omit<ToolResult, "toolCallId">>;

// ---------------------------------------------------------------------------
// 共有 core の read tool（MP-4b PR-4。B1・B2 の 7 本、PR-5a で B3 の search_scenes・search_snippets、PR-5b で B4 の list_open_foreshadows・get_foreshadow_detail）
// ---------------------------------------------------------------------------

/**
 * renderer の ports。getter は呼出しの時点で live な値を返す（store・`db`・本文の
 * barrier 付き読取り）。import は arrow の中で読む：tool の実行時に束縛を引くので、
 * 試験の `vi.mock`（`@/db/client` の chain、`@/features/tree/api` の部分 mock、
 * `useTreeStore` の差し替え）が今までどおり効く。本文は renderer の
 * `loadSceneContent(s)`（未着の書込みを待ってから SELECT する）のまま。
 */
const LEGACY_READ_CONTEXT: CoreReadContext = {
  getDb: () => db,
  getTreeState: () => useTreeStore.getState(),
  body: {
    barrier: "pending-writes-awaited",
    readSceneBody: (sceneId) => loadSceneContent(sceneId),
    // 一括読みの失敗は空の Map に握る（移す前の `loadSceneContents(...).catch(...)` と同じ。
    // get_thread_scenes は空の excerpt で成功する）。握るのは legacy の port の側で、
    // core は port の error をそのまま伝える（DR-MP4-32b。main の port は握らない）。
    readSceneBodies: (sceneIds) =>
      loadSceneContents([...sceneIds]).catch(() => new Map<string, string>()),
  },
  // fts は args を加工せずそのまま渡す（command・引数・scope・limit は core が決める）。
  // invoke は arrow の中で読むので、試験の `vi.mock("@/lib/tauri")` が効く。
  // foreshadow の ports は wire を返すだけ（組み立ては core）。arrow の中で読むことで試験の mock が効く。
  native: {
    fts: (args) => invoke("fts_search", args),
    foreshadowOpen: (args) => readOpenForeshadowWire(args.projectId),
    foreshadowListWithLabels: (args) =>
      readForeshadowListWithLabelsWire(args.projectId),
  },
  countTokens: (text) => countTokens(text),
};

const CORE_READ_EXECUTORS = createReadExecutors(LEGACY_READ_CONTEXT);

/**
 * project が無いときの結果（core は projectId を必須にして throw する。DR-MP4-3）。
 * 引数の検査は core が先に行い、project の検査はその次なので、順序は移す前のまま。
 * content は毎回新しく作る（呼び手が書き換えても次の結果に漏れない）。
 */
const LEGACY_NO_PROJECT_CONTENT: Record<CoreReadToolName, () => unknown> = {
  list_codex_tags: () => [],
  list_chapters: () => [],
  get_chapter_summaries: () => [],
  get_scene_timeline_neighbors: () => ({
    previous: [],
    next: [],
    currentSceneStoryTimeLabel: null,
  }),
  // 他の list_* ツールと揃えて空配列を返す（null だと「列挙失敗」に見える）。
  list_plot_threads: () => [],
  get_thread_scenes: () => null,
  get_scene: () => null,
  search_scenes: () => [],
  search_snippets: () => [],
  list_open_foreshadows: () => [],
  get_foreshadow_detail: () => null,
};

function coreReadExecutor(name: CoreReadToolName): Executor {
  const run = CORE_READ_EXECUTORS[name];
  return async (params) => {
    try {
      return await run(params);
    } catch (e) {
      if (e instanceof CoreProjectRequiredError) {
        return {
          name,
          content: LEGACY_NO_PROJECT_CONTENT[name](),
          summary: "No active project",
          tokensUsed: 0,
        };
      }
      throw e;
    }
  };
}

// ---------------------------------------------------------------------------
// Codex の hidden を通る read tool 4 本（MP-4b PR-8b、DR-MP4-40）。本体は共有 core
// （`electron/shared/readDomain/core/codexTools.ts`）。renderer の ports は `codexReadContext.ts`。
// ---------------------------------------------------------------------------

/** scope が無いときの 4 本（load 時に 1 度作る。作るだけでは何も読まない）。 */
const CORE_CODEX_EXECUTORS = createCodexReadExecutors(
  LEGACY_CODEX_READ_CONTEXT,
);
const CORE_CODEX_ENTRY_EXECUTORS = createCodexEntryExecutors(
  LEGACY_CODEX_ENTRY_CONTEXT,
);

/**
 * project が無いときの結果の content（core は projectId を必須にして throw する。DR-MP4-3）。
 * 引数の検査は core が先に行い、project の検査はその次なので、順序は移す前のまま。
 */
const CODEX_NO_PROJECT_CONTENT: Record<CodexReadToolName, () => unknown> = {
  search_codex: () => [],
  list_codex_by_type: () => [],
  search_codex_by_tags: () => [],
  find_related_entries: () => [],
};

/**
 * 4 本の executor。turn scene があればその値にした ctx を呼出しごとに作る
 * （作るだけでは何も読まない）。projectId は今までどおり store から読む。
 * null・空・空白だけの scene は core が「場面を解決できない」として同じに扱う。
 */
function codexReadExecutor(name: CodexReadToolName): Executor {
  return async (params, _requestId, _authorization, context) => {
    const currentSceneId = turnSceneId(context);
    const run = (
      currentSceneId !== undefined
        ? createCodexReadExecutors({
            ...LEGACY_CODEX_READ_CONTEXT,
            getTreeState: () => ({
              ...useTreeStore.getState(),
              activeSceneId: currentSceneId,
            }),
          })
        : CORE_CODEX_EXECUTORS
    )[name];
    try {
      return await run(params);
    } catch (e) {
      if (e instanceof CoreProjectRequiredError) {
        return {
          name,
          content: CODEX_NO_PROJECT_CONTENT[name](),
          summary: "No active project",
          tokensUsed: 0,
        };
      }
      throw e;
    }
  };
}

/** `get_codex_entry` は turn scene と store の project を既存の読取規則のまま渡す。 */
function codexEntryExecutor(): Executor {
  return async (params, _requestId, _authorization, context) => {
    const currentSceneId = turnSceneId(context);
    let scopedTreeState: ReturnType<typeof useTreeStore.getState> | undefined;
    const run =
      currentSceneId !== undefined
        ? createCodexEntryExecutors({
            ...LEGACY_CODEX_ENTRY_CONTEXT,
            getTreeState: () => {
              scopedTreeState ??= useTreeStore.getState();
              return {
                ...scopedTreeState,
                activeSceneId: currentSceneId,
              };
            },
          }).get_codex_entry
        : CORE_CODEX_ENTRY_EXECUTORS.get_codex_entry;
    try {
      return await run(params);
    } catch (e) {
      if (e instanceof CoreProjectRequiredError) {
        return {
          name: "get_codex_entry",
          content: null,
          summary: "No active project",
          tokensUsed: 0,
        };
      }
      throw e;
    }
  };
}

function turnSceneId(
  context?: ChatToolRunContext | ChatReadOnlyToolRunContext,
): string | null | undefined {
  return context?.currentSceneId !== undefined
    ? context.currentSceneId
    : context?.scope?.currentSceneId;
}

/**
 * ツール名 → executor の dispatch マップ。
 *
 * 契約（security review F-2）: **ここに載る executor は全て read-only でなければ
 * ならない**。本文・DB を変更する mutating tool を追加する場合は、必ず次の 3 点を
 * 同時に満たすこと:
 *   1. `toolExecutors.test.ts` の read-only allowlist テストを更新する
 *      （allowlist を更新しないとテストが落ちるので、追加が意識的になる）。
 *   2. `agentLoop.ts` の declaredToolNames ゲートにより、その mutating tool が
 *      宣言されたターンでのみ発火することを確認する。
 *   3. AiPolicy bodyWrite ゲート（[[grimodex-bodywrite-chat-suppression]]）と連動させ、
 *      bodyWrite=off のとき呼ばれない／無効化されることを保証する。
 *
 * `ask_user` は意図的にここに含めない（mutating ではなく、chatStore の
 * guardedExecuteTool が UI 往復として横取りする）。
 */
/** Read-only tools — frozen allowlist (security review F-2). */
export const READ_ONLY_EXECUTORS: Record<string, Executor> = {
  search_codex: codexReadExecutor("search_codex"),
  list_codex_by_type: codexReadExecutor("list_codex_by_type"),
  get_codex_entry: codexEntryExecutor(),
  list_codex_tags: coreReadExecutor("list_codex_tags"),
  search_codex_by_tags: codexReadExecutor("search_codex_by_tags"),
  find_related_entries: codexReadExecutor("find_related_entries"),
  list_chapters: coreReadExecutor("list_chapters"),
  get_scene: coreReadExecutor("get_scene"),
  search_scenes: coreReadExecutor("search_scenes"),
  search_snippets: coreReadExecutor("search_snippets"),
  get_chapter_summaries: coreReadExecutor("get_chapter_summaries"),
  list_open_foreshadows: coreReadExecutor("list_open_foreshadows"),
  get_foreshadow_detail: coreReadExecutor("get_foreshadow_detail"),
  get_scene_timeline_neighbors: coreReadExecutor(
    "get_scene_timeline_neighbors",
  ),
  list_plot_threads: coreReadExecutor("list_plot_threads"),
  get_thread_scenes: coreReadExecutor("get_thread_scenes"),
  list_events: listEventsTool,
  get_event_detail: getEventDetailTool,
  get_character_timeline: getCharacterTimelineTool,
  get_chronicle_state: getChronicleStateTool,
  search_events: (params, _requestId, _authorization, context) =>
    searchEvents(params, context),
  // アプリの使い方ヘルプ。実装（ヘルプ文書・locale の展開）は初回の呼び出しで読む。
  get_app_help_index: async (params) =>
    (await import("./appHelpTools")).getAppHelpIndexTool(params),
  get_app_help: async (params) =>
    (await import("./appHelpTools")).getAppHelpTool(params),
  get_ui_state: async () => (await import("./appHelpTools")).getUiStateTool(),
};
Object.freeze(READ_ONLY_EXECUTORS);

async function createSnippetTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
  const title = String(params["title"] ?? "").trim();
  if (!title) {
    return {
      name: "create_snippet",
      content: null,
      summary: "title is required",
      tokensUsed: 0,
      error: "title is required",
    };
  }
  try {
    if (!requestId) {
      throw new Error("create_snippet request identity is missing");
    }
    const snippet = await agentCreateSnippet(
      {
        requestId,
        title,
        content: optionalMarkdownBody(params["content"]),
        sceneId: params["sceneId"] ? String(params["sceneId"]) : undefined,
      },
      authorization?.chatMessageId,
      authorization
        ? {
            agentAuthorityCapability: authorization.capability,
            chatMessageId: authorization.chatMessageId,
            toolCallId: authorization.toolCallId,
            executionId: authorization.executionId,
            mainOwnedProvenanceId: authorization.mainOwnedProvenanceId,
          }
        : undefined,
    );
    const content = { id: snippet.id, title: snippet.title };
    const json = JSON.stringify(content);
    return {
      name: "create_snippet",
      content,
      summary: `Created snippet '${snippet.title}'`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "create_snippet",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

async function applyAiTreePlanTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
  const kind = params["kind"];
  const ops = params["ops"];
  if (kind !== "scaffold" && kind !== "reorganize") {
    return {
      name: "apply_ai_tree_plan",
      content: null,
      summary: "kind must be scaffold or reorganize",
      tokensUsed: 0,
      error: "invalid kind",
    };
  }
  if (!Array.isArray(ops)) {
    return {
      name: "apply_ai_tree_plan",
      content: null,
      summary: "ops must be an array",
      tokensUsed: 0,
      error: "invalid ops",
    };
  }
  try {
    const plan = { kind, ops } as AiTreePlan;
    const result = await agentApplyTreePlan(plan, {
      requestId,
      agentAuthorityCapability: authorization?.capability,
      chatMessageId: authorization?.chatMessageId,
      toolCallId: authorization?.toolCallId,
      executionId: authorization?.executionId,
      mainOwnedProvenanceId: authorization?.mainOwnedProvenanceId,
    });
    const content = result;
    const json = JSON.stringify(content);
    return {
      name: "apply_ai_tree_plan",
      content,
      summary: `Applied tree plan: ${result.createdIds.length} created, ${result.movedIds.length} moved, ${result.renamedIds.length} renamed`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "apply_ai_tree_plan",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  } finally {
    // tree 変更は readingOrder / scene 可視性判定に効くため共有キャッシュを破棄。
    invalidateChronicleToolCache();
  }
}

async function proposeSceneBodyTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
  const sceneId = String(params["sceneId"] ?? "").trim();
  const text = String(params["text"] ?? "").trim();
  if (!sceneId || !text) {
    return {
      name: "propose_scene_body",
      content: null,
      summary: "sceneId and text are required",
      tokensUsed: 0,
      error: "sceneId and text are required",
    };
  }
  const rawMode = params["mode"];
  const mode = rawMode === "insert" ? "insert" : "append";
  try {
    const result = await agentProposeSceneBody({
      requestId,
      sceneId,
      text,
      mode,
      agentAuthorityCapability: authorization?.capability,
      chatMessageId: authorization?.chatMessageId,
      toolCallId: authorization?.toolCallId,
      executionId: authorization?.executionId,
      mainOwnedProvenanceId: authorization?.mainOwnedProvenanceId,
    });
    useProseStagingStore.getState().enqueue({
      stagingId: result.stagingId,
      sceneId: result.sceneId,
      text,
      mode,
    });
    const content = {
      stagingId: result.stagingId,
      sceneId: result.sceneId,
      status: result.status,
    };
    const json = JSON.stringify(content);
    return {
      name: "propose_scene_body",
      content,
      summary: `Proposed body prose for scene (${mode}); awaiting user accept/reject`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "propose_scene_body",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

const UNSUPPORTED_FORESHADOW_SECRET_ERROR =
  "secret is no longer supported: foreshadows cannot be hidden from the AI. Omit it.";

async function createForeshadowTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
  if (Object.hasOwn(params, "secret") && params["secret"] !== false) {
    return {
      name: "create_foreshadow",
      content: null,
      summary: UNSUPPORTED_FORESHADOW_SECRET_ERROR,
      tokensUsed: 0,
      error: UNSUPPORTED_FORESHADOW_SECRET_ERROR,
    };
  }
  const title = String(params["title"] ?? "").trim();
  if (!title) {
    return {
      name: "create_foreshadow",
      content: null,
      summary: "title is required",
      tokensUsed: 0,
      error: "title is required",
    };
  }
  try {
    if (!requestId) {
      throw new Error("create_foreshadow request identity is missing");
    }
    const input = {
      requestId,
      foreshadowId: authorization?.expectedEntityId,
      title,
      intent: params["intent"] ? String(params["intent"]) : undefined,
      notes: params["notes"] ? String(params["notes"]) : undefined,
      loadBearing: params["loadBearing"]
        ? (String(params["loadBearing"]) as AgentForeshadowLoadBearing)
        : undefined,
      secret: false,
    };
    const item = authorization
      ? await agentCreateForeshadow(input, {
          agentAuthorityCapability: authorization.capability,
          chatMessageId: authorization.chatMessageId,
          toolCallId: authorization.toolCallId,
          executionId: authorization.executionId,
          mainOwnedProvenanceId: authorization.mainOwnedProvenanceId,
        })
      : await agentCreateForeshadow(input);
    const content = { id: item.id, title: item.title };
    const json = JSON.stringify(content);
    return {
      name: "create_foreshadow",
      content,
      summary: `Created foreshadow '${item.title}'`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "create_foreshadow",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

async function updateForeshadowTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
  if (Object.hasOwn(params, "secret")) {
    return {
      name: "update_foreshadow",
      content: null,
      summary: UNSUPPORTED_FORESHADOW_SECRET_ERROR,
      tokensUsed: 0,
      error: UNSUPPORTED_FORESHADOW_SECRET_ERROR,
    };
  }
  const id = String(
    normalizeMastraAgentWriteInput("update_foreshadow", params)[
      "foreshadowId"
    ] ?? "",
  ).trim();
  if (!id) {
    return {
      name: "update_foreshadow",
      content: null,
      summary: "id is required",
      tokensUsed: 0,
      error: "id is required",
    };
  }
  const baseVersion = params["baseVersion"];
  if (
    typeof baseVersion !== "number" ||
    !Number.isSafeInteger(baseVersion) ||
    baseVersion < 0
  ) {
    return {
      name: "update_foreshadow",
      content: null,
      summary: "baseVersion is required and must be a non-negative integer",
      tokensUsed: 0,
      error: "baseVersion is required and must be a non-negative integer",
    };
  }
  try {
    if (!requestId) {
      throw new Error("update_foreshadow request identity is missing");
    }
    const input = {
      requestId,
      foreshadowId: id,
      baseVersion,
      title:
        params["title"] !== undefined ? String(params["title"]) : undefined,
      intent:
        params["intent"] !== undefined ? String(params["intent"]) : undefined,
      notes:
        params["notes"] !== undefined ? String(params["notes"]) : undefined,
      loadBearing:
        params["loadBearing"] !== undefined
          ? (String(params["loadBearing"]) as AgentForeshadowLoadBearing)
          : undefined,
      payoffConfirmed:
        typeof params["payoffConfirmed"] === "boolean"
          ? params["payoffConfirmed"]
          : undefined,
      abandoned:
        typeof params["abandoned"] === "boolean"
          ? params["abandoned"]
          : undefined,
    };
    const item = authorization
      ? await agentUpdateForeshadow(input, {
          agentAuthorityCapability: authorization.capability,
          chatMessageId: authorization.chatMessageId,
          toolCallId: authorization.toolCallId,
          executionId: authorization.executionId,
          mainOwnedProvenanceId: authorization.mainOwnedProvenanceId,
        })
      : await agentUpdateForeshadow(input);
    const content = {
      id: item.id,
      title: item.title,
      payoffConfirmed: item.payoffConfirmed,
      abandoned: item.abandoned,
    };
    const json = JSON.stringify(content);
    return {
      name: "update_foreshadow",
      content,
      summary: `Updated foreshadow '${item.title}'`,
      tokensUsed: countTokens(json),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "update_foreshadow",
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
}

/** Mutating tools — knowledgeWrite / structureWrite / bodyWrite gated per tool. */
const chronicleWrite = () => import("./chronicleWriteTools");

export const MUTATING_EXECUTORS: Record<string, Executor> = {
  create_codex_entry: createCodexEntryTool,
  update_codex_entry: updateCodexEntryTool,
  create_foreshadow: createForeshadowTool,
  update_foreshadow: updateForeshadowTool,
  create_snippet: createSnippetTool,
  apply_ai_tree_plan: applyAiTreePlanTool,
  propose_scene_body: proposeSceneBodyTool,
  // 年表の書く道具。実装は初回の呼び出しで読む（起動時の JS の予算）。
  create_event: async (params, requestId, authorization) =>
    (await chronicleWrite()).createEventTool(params, requestId, authorization),
  update_event: async (params, requestId, authorization) =>
    (await chronicleWrite()).updateEventTool(params, requestId, authorization),
  delete_event: async (params, requestId, authorization) =>
    (await chronicleWrite()).deleteEventTool(params, requestId, authorization),
  stamp_scene_event: async (params, requestId, authorization) =>
    (await chronicleWrite()).stampSceneEventTool(
      params,
      requestId,
      authorization,
    ),
  unstamp_scene_event: async (params, requestId, authorization) =>
    (await chronicleWrite()).unstampSceneEventTool(
      params,
      requestId,
      authorization,
    ),
  set_event_participants: async (params, requestId, authorization) =>
    (await chronicleWrite()).setEventParticipantsTool(
      params,
      requestId,
      authorization,
    ),
  add_event_relation: async (params, requestId, authorization) =>
    (await chronicleWrite()).addEventRelationTool(
      params,
      requestId,
      authorization,
    ),
  remove_event_relation: async (params, requestId, authorization) =>
    (await chronicleWrite()).removeEventRelationTool(
      params,
      requestId,
      authorization,
    ),
  // アプリの UI 操作（view のみ）。実装（layout／tab の store）は初回の呼び出しで読む。
  run_app_command: async (params) =>
    (await import("./appUiTools")).runAppCommandTool(params),
  apply_layout_preset: async (params) =>
    (await import("./appUiTools")).applyLayoutPresetTool(params),
  // 設定変更の提案。設定は変えず、検証済みの提案を返す（適用は利用者のカードのクリック）。
  // 実装は初回の呼び出しまで読み込まない。DURABLE_MUTATION_TOOLS には入れない（DB を書かない）。
  propose_setting_change: async (params) =>
    (await import("./settingProposalTools")).proposeSettingChangeTool(params),
};
Object.freeze(MUTATING_EXECUTORS);

export const EXECUTORS: Record<string, Executor> = {
  ...READ_ONLY_EXECUTORS,
  ...MUTATING_EXECUTORS,
  // main agent の search_events だけ、承認済みの IR を合流する版で上書きする。
  // sub-agent の `executeReadOnlyTool` は READ_ONLY_EXECUTORS だけを見るので、IR は出ない。
  search_events: searchEventsWithIr,
};
// 実行時の mutation を封じる（read-only 不変条件の defense-in-depth）。
Object.freeze(EXECUTORS);

const DURABLE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "create_codex_entry",
  "update_codex_entry",
  "create_snippet",
  "create_foreshadow",
  "update_foreshadow",
  "create_event",
  "update_event",
  "delete_event",
  "stamp_scene_event",
  "unstamp_scene_event",
  "set_event_participants",
  "add_event_relation",
  "remove_event_relation",
  "apply_ai_tree_plan",
  "propose_scene_body",
]);

/**
 * 出典の会話（`source_chat_message_id`、`chat_messages` への検証／FK）に実行中の
 * assistant message を使う書き込み tool。実行の前にその行が保存されている必要がある。
 */
export const SOURCE_CHAT_MESSAGE_TOOLS: ReadonlySet<string> = new Set([
  "create_codex_entry",
  "create_snippet",
]);

async function toolMutationRequestId(
  toolName: string,
  toolCallId: string,
  projectId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${toolName}\0${projectId}\0${toolCallId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `agent-tool:${hex}`;
}

/** Execute a named tool and return a ToolResult (always succeeds — errors are wrapped). */
export async function executeTool(
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
  authorization?: AgentToolAuthorization,
  context?: ChatToolRunContext,
): Promise<ToolResult> {
  const executor = EXECUTORS[name];
  if (!executor) {
    const msg = `Unknown tool: ${name}`;
    return {
      toolCallId,
      name,
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
  try {
    const mutationAuthority = DURABLE_MUTATION_TOOLS.has(name)
      ? captureMutationAuthority(getCurrentProjectId(), getCurrentProjectId)
      : null;
    const requestId = mutationAuthority
      ? await toolMutationRequestId(
          name,
          toolCallId,
          mutationAuthority.projectId,
        )
      : undefined;
    // SHA-256 yields before the domain writer captures its own Project. Do not
    // let a pre-switch tool call resume against a replacement Project/Workspace.
    if (mutationAuthority && !isCurrentMutationAuthority(mutationAuthority)) {
      throw new Error("agent tool mutation authority changed");
    }
    const result = await executor(
      params,
      requestId,
      authorization ? { ...authorization, toolCallId } : undefined,
      context,
    );
    return { toolCallId, ...result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      toolCallId,
      name,
      content: null,
      summary: `Error: ${msg}`,
      tokensUsed: 0,
      error: msg,
    };
  }
}

/**
 * 読み取り専用ツールのみを dispatch する（リサーチ・サブエージェント用）。
 * READ_ONLY_EXECUTORS 以外（mutating / ask_user / run_research）は構造的に拒否し、
 * 子エージェントが書き込み・質問・再帰を行えないことを defense-in-depth で保証する。
 * サブエージェントには getResearchSubagentTools() の読み取りサブセットしか宣言しない
 * ため通常ここに非読み取りツールは来ないが、宣言ゲートが万一破られても
 * read-only 不変条件を二重に守る。
 */
export async function executeReadOnlyTool(
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
  context?: ChatReadOnlyToolRunContext,
): Promise<ToolResult> {
  const executor = READ_ONLY_EXECUTORS[name];
  if (!executor) {
    const msg = `Tool not available in research sub-agent (read-only): ${name}`;
    return {
      toolCallId,
      name,
      content: null,
      summary: msg,
      tokensUsed: 0,
      error: msg,
    };
  }
  try {
    const result = await executor(params, undefined, undefined, context);
    return { toolCallId, ...result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      toolCallId,
      name,
      content: null,
      summary: `Error: ${msg}`,
      tokensUsed: 0,
      error: msg,
    };
  }
}
