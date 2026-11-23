import { invoke } from "@/lib/tauri";
import { loadSceneContent, loadSceneContents } from "@/features/tree/api";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { db } from "@/db/client";
import {
  codexEntries,
  codexDetailDefinitions,
  codexDetailValues,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  createReadExecutors,
  type CoreReadToolName,
} from "@/../electron/shared/readDomain/core/readExecutors";
import {
  createCodexReadExecutors,
  type CodexReadToolName,
} from "@/../electron/shared/readDomain/core/codexReadExecutors";
import { LEGACY_CODEX_READ_CONTEXT } from "./codexReadContext";
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
import { readOpenForeshadowWire } from "@/features/foreshadow/api";
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
import {
  createEventTool,
  updateEventTool,
  deleteEventTool,
  stampSceneEventTool,
  unstampSceneEventTool,
  setEventParticipantsTool,
  addEventRelationTool,
  removeEventRelationTool,
} from "./chronicleWriteTools";
import { agentApplyTreePlan } from "@/features/agent-writes/tree";
import { agentProposeSceneBody } from "@/features/agent-writes/prose";
import { useProseStagingStore } from "@/features/agent-writes/proseStagingStore";
import type { AiTreePlan } from "@/features/tree/aiScaffold/types";
import type { EventSearchHit } from "@/features/semantic-search/api";
import {
  dropCodexHiddenFromAi,
  resolveCodexForAi,
  type CodexTextForAi,
} from "@/features/codex/context/codexHiddenFromAi";
import { isEventHiddenFromAi } from "@/features/chronicle/chronicleSecrecy";
import {
  isEventBeforeOrAtScene,
  passesIrExclusionApproximation,
} from "@/features/chronicle/chronicleReadingPosition";
import {
  getSharedEvents,
  getSharedSceneEvents,
  getSharedReadingOrder,
  invalidateChronicleToolCache,
} from "./chronicleToolCache";

// ---------------------------------------------------------------------------
// Codex tools（search_codex・list_codex_by_type・search_codex_by_tags・find_related_entries は
// MP-4b PR-8b で共有 core へ移した。ここに残るのは get_codex_entry と、hidden の判定の補助）
// ---------------------------------------------------------------------------

/**
 * search_events の年表の候補（秘匿の filter と位置の filter の後で、`slice(limit)` の前）。
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
      /** 秘匿・位置の filter の後、`slice` の前（30 件以下）。 */
      readonly visible: readonly EventSearchHit[];
      /** △7 (4) の近似の規則（secret の event だけに掛かる）。 */
      readonly passesApproximation: (hit: EventSearchHit) => boolean;
    };

async function chronicleCandidates(
  params: Record<string, unknown>,
  scope?: ChatTurnToolScope,
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

  // 基準の project・Scene は、秘匿の filter も位置の filter も同じ値を使う。
  // turn の文脈（scope）があればその値、無ければ今の tree store。
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

  // AI 秘匿: hidden な secret イベントは hit から除外するため over-fetch（≤30=backendMax）→
  // visible filter → slice(limit)。索引自体は全件のまま（title 漏洩を返却段で防ぐ）。
  const fetchLimit = eventSearchFetchLimit(limit);
  const hits = await denseEventHitsOrEmpty({
    projectId,
    query,
    limit: fetchLimit,
  });

  // 現在シーン（currentSceneId）文脈で hidden な event id 集合を算出（spec §2.5）。
  const allEvents = await getSharedEvents(projectId);
  const sceneEvents = await getSharedSceneEvents(projectId);
  const readingOrder = getSharedReadingOrder(useTreeStore.getState().nodes);
  // scope が無い呼び手は、従来どおり await の後で今の Scene を読む（定数 false の間は今と同一）。
  const currentSceneId = chronicleSceneId(scope);
  const hidden = new Set(
    allEvents
      .filter((e) =>
        isEventHiddenFromAi(e, currentSceneId, { readingOrder, sceneEvents }),
      )
      .map((e) => e.id),
  );

  const visible = hits
    .filter((h) => !hidden.has(h.eventId))
    // 位置の filter（chat IR S1-B）。秘匿の filter の後、slice(limit) の前。
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
    // 行が見つからない hit は、秘匿の filter と同じく secret でないものとして扱う。
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
): ChronicleEntry[] {
  return hits.slice(0, limit).map((h) => ({
    eventId: h.eventId,
    title: h.title,
    kind: h.kind,
    score: h.score,
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
  scope?: ChatTurnToolScope,
): Promise<Omit<ToolResult, "toolCallId">> {
  // 旗が false で scope なしの呼出しは read core へ（MP-4b PR-7b、DR-MP4-38）。旗は呼出しごとに評価する
  // （`READ_ONLY_EXECUTORS` が load 時に 1 度作られることと混同しない）。scope があるときは、旗が false の
  // 試験でも今までどおり下の経路（scope の project・場面で動く）。`scope` の真偽は `chronicleProjectId` と同じ。
  if (!CHAT_AGENT_IR_ENABLED && !scope) return chronicleSearchExecutor(params);
  const candidates = await chronicleCandidates(params, scope);
  if (candidates.kind === "empty") return candidates.result;
  const pool =
    CHAT_AGENT_IR_ENABLED && scope
      ? candidates.visible.filter(candidates.passesApproximation)
      : candidates.visible;
  const content = chronicleEntries(pool, candidates.limit);
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

/**
 * search_events の基準の Scene。scope があればそれ、無ければ読んだ時点の tree store。
 * 呼ぶ位置が挙動の一部なので、scope が無い呼び手では await の後で呼ぶ（DR-CHATIR-S1-34）。
 */
function chronicleSceneId(scope?: ChatTurnToolScope): string {
  return scope
    ? (scope.currentSceneId ?? "")
    : (useTreeStore.getState().activeSceneId ?? "");
}

/**
 * 作者が hidden（AI に秘匿）と印した Codex を、tool の結果から落とす。判定は chat の
 * 通常の文脈と同じ正本（`listCodexIdsHiddenFromAi`）。現在の場面は年表の tool と同じ規則で、
 * 呼ぶ位置が挙動の一部なので、結果を作り終えた後（await の後）で呼ぶ。
 */
function dropHiddenCodex<T extends { id: string }>(
  rows: readonly T[],
  projectId: string,
  scope?: ChatTurnToolScope,
): Promise<T[]> {
  return dropCodexHiddenFromAi(rows, {
    projectId,
    sceneId: chronicleSceneId(scope),
  });
}

/**
 * id の Codex を AI へ渡してよい形で返す。hidden なら null（読めない・存在しない id と同じ
 * 「見つからない」扱いにする）。summary と本文は Phase 解決後（現在の場面があればその場面）で、
 * base が hidden で Phase が解除したものも base の文を返さない。
 */
async function resolveCodexTextForAi(
  id: string,
  projectId: string,
  scope?: ChatTurnToolScope,
  /** hidden でないのに解決結果が無いときの代わり（通常は起きない）。 */
  fallback: CodexTextForAi = {
    summary: null,
    content: "",
    released: false,
    mode: "",
  },
  withDetails = false,
): Promise<CodexTextForAi | null> {
  const { hidden, texts } = await resolveCodexForAi({
    entryIds: [id],
    projectId,
    sceneId: chronicleSceneId(scope),
    withContent: true,
    withDetails,
  });
  if (hidden.has(id)) return null;
  return texts.get(id) ?? fallback;
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
 * 順は直列：年表の候補（秘匿 → 位置、`slice` の前）→ 事前判定 → turn の累積上限 →
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
    return searchEvents(params, context?.scope);
  }
  const candidates = await chronicleCandidates(params, context.scope);
  // 空の query・project 無しは、年表の側の応答（空の配列）のまま返す。
  if (candidates.kind === "empty") return candidates.result;
  const { query, projectId, currentSceneId, visible } = candidates;
  // 0 < limit < 1 の小数は年表では 0 件になるが、IR には 1 件分の枠を残す（空の available を避ける）。
  const yearLimit = candidates.limit;
  const limit = Math.max(1, yearLimit);
  const withoutApproximation = chronicleEntries(visible, yearLimit);
  const approximated = () =>
    chronicleEntries(visible.filter(candidates.passesApproximation), yearLimit);
  const rest = { tokenCap: ir.tokenCap, countTokens };

  let fitted: ChatIrToolContentResult<ChronicleEntry>;
  // 暫定の年表（除去の前）で測る。除去で小さくなるとは限らない（後ろの候補で補充するので、
  // 除去の後の年表が大きいこともある）。そのときも秘匿の漏れにはならず、失うのは Native の
  // 1 回（回数と ledger の枠）だけ。
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
        // 秘匿と位置の filter の後の年表の候補だけ（隠れた event の ID は送らない）。
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

async function getCodexEntry(
  params: Record<string, unknown>,
  scope?: ChatTurnToolScope,
): Promise<Omit<ToolResult, "toolCallId">> {
  const id = String(params["id"] ?? "").trim();
  if (!id)
    return {
      name: "get_codex_entry",
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    };

  const projectId = useTreeStore.getState().projectId;
  if (!projectId)
    return {
      name: "get_codex_entry",
      content: null,
      summary: "No active project",
      tokensUsed: 0,
    };

  const [entry] = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  // hidden は存在しない id と同じ応答にする（存在を明かさない）。
  const resolvedText = entry
    ? await resolveCodexTextForAi(
        id,
        projectId,
        scope,
        {
          summary: entry.summary,
          content: entry.content,
          released: false,
          mode: entry.contextMode,
        },
        true,
      )
    : null;
  if (!entry || !resolvedText)
    return {
      name: "get_codex_entry",
      content: null,
      summary: "Entry not found",
      tokensUsed: 0,
    };

  // Detail definitions for this type
  const defs = await db
    .select()
    .from(codexDetailDefinitions)
    .where(eq(codexDetailDefinitions.typeSlug, entry.type));

  // Detail values for this entry
  const vals = await db
    .select()
    .from(codexDetailValues)
    .where(eq(codexDetailValues.entryId, id));

  const details = defs
    .filter((d) => d.includeInContext)
    .map((d) => {
      // Phase で hidden を解除された項目は、base（秘匿した状態）の詳細でなく Phase 解決後の
      // 詳細（null は Phase による消去）を返す。ほかの項目は今までどおり base の値。
      const resolvedDetails = resolvedText.detailValues;
      if (resolvedText.released && resolvedDetails) {
        return { field: d.name, value: resolvedDetails.get(d.id) ?? null };
      }
      const val = vals.find((v) => v.definitionId === d.id);
      return { field: d.name, value: val?.value ?? null };
    });

  // Child entries (summaries only)
  const children = await dropHiddenCodex(
    await db
      .select({
        id: codexEntries.id,
        name: codexEntries.name,
        type: codexEntries.type,
        summary: codexEntries.summary,
      })
      .from(codexEntries)
      .where(eq(codexEntries.parentId, id)),
    projectId,
    scope,
  );

  // 本体テキスト (ProseMirror JSON → plain text)。Tool description が
  // "full content body" と謳う以上、ここで抜けてはいけない。
  const body = resolvedText.content
    ? extractPlainText(resolvedText.content)
    : "";

  const result = {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    aliases: entry.aliases ? (JSON.parse(entry.aliases) as string[]) : [],
    summary: resolvedText.summary ?? "",
    body,
    details,
    children: children.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      summary: c.summary ?? "",
    })),
  };
  const json = JSON.stringify(result);
  return {
    name: "get_codex_entry",
    content: result,
    summary: `${entry.name} (${entry.type})`,
    tokensUsed: countTokens(json),
  };
}

// ---------------------------------------------------------------------------
// Mutating executors (knowledgeWrite policy gated)
// ---------------------------------------------------------------------------

const MAX_CODEX_ALIASES = 100;
const MAX_CODEX_ALIAS_BYTES = 64_000;

function optionalMarkdownBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("content must be a Markdown string");
  }
  return agentMarkdownToProseMirrorJson(value);
}

function optionalAliases(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("aliases must be an array of strings");
  }
  if (value.length > MAX_CODEX_ALIASES) {
    throw new Error(`aliases must contain at most ${MAX_CODEX_ALIASES} items`);
  }
  const aliases = value.map((item) => item.trim()).filter(Boolean);
  const serialized = JSON.stringify(aliases);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CODEX_ALIAS_BYTES) {
    throw new Error(`aliases exceed ${MAX_CODEX_ALIAS_BYTES} bytes`);
  }
  return serialized;
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
    if (!requestId) {
      throw new Error("create_codex_entry request identity is missing");
    }
    const entry = await agentCreateCodexEntry(
      {
        requestId,
        type,
        name,
        summary: params["summary"] ? String(params["summary"]) : undefined,
        content: optionalMarkdownBody(params["content"]),
        aliases: optionalAliases(params["aliases"]),
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
            ? optionalMarkdownBody(params["content"])
            : undefined,
        aliases: optionalAliases(params["aliases"]),
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
  // foreshadowOpen は wire を返すだけ（組み立ては core。Native なら `{ projectId }` だけで 1 回の invoke、
  // それ以外は Drizzle の 2 list）。`readOpenForeshadowWire` は arrow の中で読む（試験の mock が効く）。
  native: {
    fts: (args) => invoke("fts_search", args),
    foreshadowOpen: (args) => readOpenForeshadowWire(args.projectId),
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
 * 4 本の executor。scope があるときは、現在の場面を scope の値にした ctx を**呼出しごとに**作る
 * （作るだけでは何も読まない）。**projectId は scope でなく今までどおり store**（legacy の非対称を保つ。
 * scope の `currentSceneId`（null がありうる）はそのまま `activeSceneId` に渡す：null・空・空白だけは、
 * core の判定が「場面を解決できない」として同じに扱う）。scope は `CHAT_AGENT_IR_ENABLED` が false の間
 * 作られない（`chatAgentToolHandlers.ts` の生成の手前の分岐）ので到達しないが、特性試験が固定している
 * （DR-MP4-21：閉じた経路は renderer の薄い層が自分の分岐を持つ）。
 */
function codexReadExecutor(name: CodexReadToolName): Executor {
  return async (params, _requestId, _authorization, context) => {
    const scope = context?.scope;
    const run = (
      scope
        ? createCodexReadExecutors({
            ...LEGACY_CODEX_READ_CONTEXT,
            getTreeState: () => ({
              ...useTreeStore.getState(),
              activeSceneId: scope.currentSceneId,
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
  get_codex_entry: (params, _requestId, _authorization, context) =>
    getCodexEntry(params, context?.scope),
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
    searchEvents(params, context?.scope),
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

async function createForeshadowTool(
  params: Record<string, unknown>,
  requestId?: string,
  authorization?: AgentToolAuthorization,
): Promise<Omit<ToolResult, "toolCallId">> {
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
      secret:
        typeof params["secret"] === "boolean" ? params["secret"] : undefined,
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
    const content = { id: item.id, title: item.title, secret: item.secret };
    const json = JSON.stringify(content);
    return {
      name: "create_foreshadow",
      content,
      summary: `Created foreshadow '${item.title}'${item.secret ? " (secret)" : ""}`,
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
  const id = String(params["id"] ?? "").trim();
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
      secret:
        typeof params["secret"] === "boolean" ? params["secret"] : undefined,
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
export const MUTATING_EXECUTORS: Record<string, Executor> = {
  create_codex_entry: createCodexEntryTool,
  update_codex_entry: updateCodexEntryTool,
  create_foreshadow: createForeshadowTool,
  update_foreshadow: updateForeshadowTool,
  create_snippet: createSnippetTool,
  apply_ai_tree_plan: applyAiTreePlanTool,
  propose_scene_body: proposeSceneBodyTool,
  create_event: createEventTool,
  update_event: updateEventTool,
  delete_event: deleteEventTool,
  stamp_scene_event: stampSceneEventTool,
  unstamp_scene_event: unstampSceneEventTool,
  set_event_participants: setEventParticipantsTool,
  add_event_relation: addEventRelationTool,
  remove_event_relation: removeEventRelationTool,
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
