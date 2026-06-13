import { db } from "@/db/client";
import {
  authorshipSpans,
  chatMessages,
  generationLogs,
  treeNodes,
  mapBoards,
  mapStickies,
} from "@/db/schema";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { AuthorshipSource } from "./AuthorshipMark";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type {
  AuthorshipTotals,
  ProjectAuthorshipReport,
} from "./projectAuthorship";
import { buildProjectAuthorshipReport } from "./projectAuthorship";
import { getMessagePrompt } from "@/features/chat/chatApi";
import type { LayerBreakdown } from "@/features/chat/contextBuilder";

export interface SpanRef {
  id: string;
  nodeId: string;
  from: number;
  to: number;
  source: AuthorshipSource | string;
  model: string | null;
  chatMsgId: string | null;
  traceId: string | null;
  timestamp: string | null;
}

export interface GenerationLogLookup {
  traceId: string;
  kind: "inline-ai" | "beat";
  commandId: string | null;
  instruction: string | null;
  model: string | null;
  /** Full prompt sent to the model. Null for generations made before
   * promptFull capture was wired (legacy rows). */
  promptFull?: string | null;
}

export interface ChatMessageLookup {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  model: string | null;
  createdAt: string;
}

export type ProvenanceKind =
  | "chat"
  | "inline-ai"
  | "beat"
  | "orphan-chat"
  | "unknown";

export interface ResolvedProvenance {
  kind: ProvenanceKind;
  traceId?: string;
  commandId?: string | null;
  instruction?: string | null;
  model?: string | null;
  chatMessage?: ChatMessageLookup;
  precedingUserPrompt?: string | null;
  /** Full prompt sent for inline-ai/beat passages. Null for legacy rows. */
  promptFull?: string | null;
}

/**
 * Per-passage process-disclosure payload: the prompt that produced this AI
 * passage and its output. Attached by `buildProvenanceBreakdown` only when
 * `includePrompts` is requested. Lets the export show "what was asked / what
 * the AI produced" for contest 制作過程開示 requirements.
 */
export interface PassageDisclosure {
  /** What the author asked: chat → the preceding user utterance; inline-ai/beat
   * → the instruction. Null when not recoverable. */
  userPrompt: string | null;
  /** The AI output that became this body span (full text, not truncated). */
  output: string;
  /** Full sent prompt. chat → the system-prompt snapshot; inline-ai/beat → the
   * captured promptFull. Null when not requested or not recorded. */
  sentSystemPrompt: string | null;
  /** Context-layer token breakdown for chat passages (snapshot). Null otherwise. */
  layers: LayerBreakdown[] | null;
  /** True when a full prompt was requested AND available for this passage. */
  promptRecorded: boolean;
}

export interface ResolvedPassage {
  id: string;
  nodeId: string;
  from: number;
  to: number;
  charCount: number;
  excerpt: string;
  model: string | null;
  provenance: ResolvedProvenance;
  /** Scene title looked up from the project report. Absent when the caller
   * did not provide a label map (e.g. the scene-scope UI panel). */
  sceneTitle?: string;
  /** Chapter (top-most folder) title. `null` means the scene is unparented. */
  chapterTitle?: string | null;
  /** Process-disclosure payload (prompt + output). Present only when the
   * report was built with `includePrompts`. */
  disclosure?: PassageDisclosure;
}

export interface ProvenanceLookups {
  generationLogs: Map<string, GenerationLogLookup>;
  chatMessages: Map<string, ChatMessageLookup>;
  precedingUserPrompts: Map<string, string | null>;
}

export interface ProvenanceBreakdown {
  chat: number;
  inlineAi: number;
  beat: number;
  orphanChat: number;
  unknownAi: number;
}

export interface MapAiSticky {
  stickyId: string;
  boardId: string;
  boardTitle: string;
  stickyTitle: string;
  charCount: number;
  model: string | null;
}

/**
 * Map AI-authored content disclosure, kept SEPARATE from the body-text-only
 * totals/breakdown. Map stickies are not manuscript prose and their authorship
 * spans carry no traceId/chatMsgId (the resolver can't classify them), so
 * folding them into the body-text denominator would corrupt the "how much of
 * the manuscript is AI" ratio. Reported as its own lane instead.
 */
export interface MapProvenance {
  /** AI-authored character count summed across all map stickies. */
  totalAiChars: number;
  /** Distinct stickies that contain AI-authored content. */
  stickyCount: number;
  stickies: MapAiSticky[];
}

export interface ProvenanceDisclosureReport {
  projectId: string;
  projectTitle: string;
  generatedAt: string;
  scope: "body-text-only";
  totals: AuthorshipTotals;
  breakdown: ProvenanceBreakdown;
  orphanChatCount: number;
  passages?: ResolvedPassage[];
  /** Present only when the project has AI-authored map content. Independent of
   * `totals`/`breakdown` (which remain body-text-only). */
  map?: MapProvenance;
  /** When true, each passage carries a `disclosure` payload (prompt + output)
   * and renderers emit the process-disclosure sections. */
  includePrompts?: boolean;
  /** When true, the full sent prompt is included in each passage's disclosure
   * (heavier; may contain other scenes' context). */
  includeFullSystemPrompt?: boolean;
}

export type ExcerptFor = (
  nodeId: string,
  from: number,
  to: number,
) => string | Promise<string>;

export async function resolveProvenanceFromLookups(
  spans: SpanRef[],
  lookups: ProvenanceLookups,
  excerptFor: ExcerptFor,
): Promise<ResolvedPassage[]> {
  const passages: ResolvedPassage[] = [];

  for (const span of spans) {
    if (span.source !== "ai") continue;

    let provenance: ResolvedProvenance;
    if (span.traceId) {
      const log = lookups.generationLogs.get(span.traceId);
      provenance = log
        ? {
            kind: log.kind,
            traceId: span.traceId,
            commandId: log.commandId,
            instruction: log.instruction,
            model: log.model,
            promptFull: log.promptFull ?? null,
          }
        : { kind: "unknown", traceId: span.traceId };
    } else if (span.chatMsgId) {
      const message = lookups.chatMessages.get(span.chatMsgId);
      provenance = message
        ? {
            kind: "chat",
            chatMessage: message,
            precedingUserPrompt:
              lookups.precedingUserPrompts.get(span.chatMsgId) ?? null,
            model: message.model,
          }
        : { kind: "orphan-chat" };
    } else {
      provenance = { kind: "unknown" };
    }

    passages.push({
      id: span.id,
      nodeId: span.nodeId,
      from: span.from,
      to: span.to,
      charCount: Math.max(0, span.to - span.from),
      excerpt: await excerptFor(span.nodeId, span.from, span.to),
      model: span.model,
      provenance,
    });
  }

  return passages;
}

export async function resolveProvenance(
  spans: SpanRef[],
  excerptFor: ExcerptFor,
): Promise<ResolvedPassage[]> {
  const aiSpans = spans.filter((s) => s.source === "ai");
  const traceIds = [...new Set(aiSpans.map((s) => s.traceId).filter(Boolean))];
  const chatMsgIds = [
    ...new Set(aiSpans.map((s) => s.chatMsgId).filter(Boolean)),
  ];

  const logRows =
    traceIds.length > 0
      ? await db
          .select({
            traceId: generationLogs.traceId,
            kind: generationLogs.kind,
            commandId: generationLogs.commandId,
            instruction: generationLogs.instruction,
            model: generationLogs.model,
            promptFull: generationLogs.promptFull,
          })
          .from(generationLogs)
          .where(inArray(generationLogs.traceId, traceIds as string[]))
      : [];

  const messageRows =
    chatMsgIds.length > 0
      ? await db
          .select({
            id: chatMessages.id,
            sessionId: chatMessages.sessionId,
            role: chatMessages.role,
            content: chatMessages.content,
            model: chatMessages.model,
            createdAt: chatMessages.createdAt,
          })
          .from(chatMessages)
          .where(inArray(chatMessages.id, chatMsgIds as string[]))
      : [];

  const precedingPairs = await Promise.all(
    messageRows.map(
      async (message) =>
        [message.id, await loadPrecedingUserPrompt(message)] as const,
    ),
  );

  return resolveProvenanceFromLookups(
    spans,
    {
      generationLogs: new Map(logRows.map((row) => [row.traceId, row])),
      chatMessages: new Map(messageRows.map((row) => [row.id, row])),
      precedingUserPrompts: new Map(precedingPairs),
    },
    excerptFor,
  );
}

/**
 * The most recent user message before a given (assistant) message in the same
 * session — i.e. the turn that produced it. Returns its id and content so the
 * process-disclosure path can both show the utterance and fetch the sent-prompt
 * snapshot (`chat_message_prompts` is keyed by the user message id).
 */
export async function loadPrecedingUserMessage(
  message: Pick<ChatMessageLookup, "sessionId" | "createdAt">,
): Promise<{ id: string; content: string } | null> {
  const rows = await db
    .select({ id: chatMessages.id, content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.sessionId, message.sessionId),
        eq(chatMessages.role, "user"),
        lt(chatMessages.createdAt, message.createdAt),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);

  const row = rows[0];
  return row ? { id: row.id, content: row.content } : null;
}

export async function loadPrecedingUserPrompt(
  message: Pick<ChatMessageLookup, "sessionId" | "createdAt">,
): Promise<string | null> {
  return (await loadPrecedingUserMessage(message))?.content ?? null;
}

export function extractSpansFromDoc(
  doc: ProseMirrorNode,
  nodeId: string,
): SpanRef[] {
  const spans: SpanRef[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const len = node.text?.length ?? 0;
    const mark = node.marks.find((m) => m.type.name === "authorship");
    if (!mark) return;
    spans.push({
      id: `${nodeId}:${pos}:${pos + len}`,
      nodeId,
      from: pos,
      to: pos + len,
      source: mark.attrs.source as AuthorshipSource,
      model: mark.attrs.model ?? null,
      chatMsgId: mark.attrs.chatMessageId ?? null,
      traceId: mark.attrs.traceId ?? null,
      timestamp: mark.attrs.timestamp ?? null,
    });
  });

  return spans;
}

export async function extractSpansFromDb(
  sceneIds: string[],
): Promise<SpanRef[]> {
  if (sceneIds.length === 0) return [];
  const rows = await db
    .select()
    .from(authorshipSpans)
    .where(inArray(authorshipSpans.nodeId, sceneIds));

  return rows.flatMap((row) => {
    if (!row.nodeId) return [];
    return [
      {
        id: row.id,
        nodeId: row.nodeId,
        from: row.fromPos,
        to: row.toPos,
        source: row.source,
        model: row.model,
        chatMsgId: row.chatMsgId,
        traceId: row.traceId,
        timestamp: row.timestamp,
      },
    ];
  });
}

/**
 * Read AI-authored map content for a project. authorship_spans rows for Map AI
 * Branch content are keyed by `stickyId` (nodeId null), so the body-text reader
 * (`extractSpansFromDb`, nodeId-scoped) never sees them. We walk
 * board → stickies → stickyId spans (authorship_spans has no projectId) and
 * aggregate AI characters per sticky. Generation side is untouched.
 */
export async function buildMapProvenance(
  projectId: string,
): Promise<MapProvenance> {
  const empty: MapProvenance = {
    totalAiChars: 0,
    stickyCount: 0,
    stickies: [],
  };

  const boards = await db
    .select({ id: mapBoards.id, title: mapBoards.title })
    .from(mapBoards)
    .where(eq(mapBoards.projectId, projectId));
  if (boards.length === 0) return empty;
  const boardTitle = new Map(boards.map((b) => [b.id, b.title]));

  const stickies = await db
    .select({
      id: mapStickies.id,
      boardId: mapStickies.boardId,
      title: mapStickies.title,
      previewText: mapStickies.previewText,
    })
    .from(mapStickies)
    .where(
      inArray(
        mapStickies.boardId,
        boards.map((b) => b.id),
      ),
    );
  if (stickies.length === 0) return empty;
  const stickyMeta = new Map(stickies.map((s) => [s.id, s]));

  const spans = await db
    .select({
      stickyId: authorshipSpans.stickyId,
      fromPos: authorshipSpans.fromPos,
      toPos: authorshipSpans.toPos,
      model: authorshipSpans.model,
    })
    .from(authorshipSpans)
    .where(
      and(
        inArray(
          authorshipSpans.stickyId,
          stickies.map((s) => s.id),
        ),
        eq(authorshipSpans.source, "ai"),
      ),
    );

  // A sticky can carry more than one AI span; sum their characters.
  const perSticky = new Map<string, { chars: number; model: string | null }>();
  for (const span of spans) {
    if (!span.stickyId) continue;
    const chars = Math.max(0, span.toPos - span.fromPos);
    const cur = perSticky.get(span.stickyId);
    if (cur) {
      cur.chars += chars;
      cur.model = cur.model ?? span.model;
    } else {
      perSticky.set(span.stickyId, { chars, model: span.model });
    }
  }

  let totalAiChars = 0;
  const result: MapAiSticky[] = [];
  for (const [stickyId, agg] of perSticky) {
    const meta = stickyMeta.get(stickyId);
    if (!meta) continue;
    totalAiChars += agg.chars;
    result.push({
      stickyId,
      boardId: meta.boardId,
      boardTitle: boardTitle.get(meta.boardId) ?? "",
      stickyTitle:
        (meta.title ?? meta.previewText ?? "").trim() || "(untitled)",
      charCount: agg.chars,
      model: agg.model,
    });
  }
  result.sort(
    (a, b) =>
      a.boardTitle.localeCompare(b.boardTitle) || b.charCount - a.charCount,
  );

  return { totalAiChars, stickyCount: result.length, stickies: result };
}

function emptyBreakdown(): ProvenanceBreakdown {
  return {
    chat: 0,
    inlineAi: 0,
    beat: 0,
    orphanChat: 0,
    unknownAi: 0,
  };
}

function addToBreakdown(
  breakdown: ProvenanceBreakdown,
  passage: ResolvedPassage,
): void {
  switch (passage.provenance.kind) {
    case "chat":
      breakdown.chat += passage.charCount;
      break;
    case "inline-ai":
      breakdown.inlineAi += passage.charCount;
      break;
    case "beat":
      breakdown.beat += passage.charCount;
      break;
    case "orphan-chat":
      breakdown.orphanChat += passage.charCount;
      break;
    case "unknown":
      breakdown.unknownAi += passage.charCount;
      break;
  }
}

function sceneIdsFromTotals(report: {
  chapters: { scenes: { id: string }[] }[];
  unparentedScenes: { id: string }[];
}): string[] {
  return [
    ...report.chapters.flatMap((chapter) => chapter.scenes.map((s) => s.id)),
    ...report.unparentedScenes.map((s) => s.id),
  ];
}

export interface DocumentLabel {
  sceneTitle: string;
  /** `null` indicates the scene lives at the project root with no chapter folder. */
  chapterTitle: string | null;
}

/**
 * Build a sceneId → {sceneTitle, chapterTitle} lookup from a project
 * authorship report so disclosure renderers can stamp "which document each
 * passage came from" without re-querying the tree.
 */
export function buildSceneLabelMap(
  report: ProjectAuthorshipReport,
): Map<string, DocumentLabel> {
  const map = new Map<string, DocumentLabel>();
  for (const chapter of report.chapters) {
    for (const scene of chapter.scenes) {
      map.set(scene.id, {
        sceneTitle: scene.title,
        chapterTitle: chapter.title,
      });
    }
  }
  for (const scene of report.unparentedScenes) {
    map.set(scene.id, { sceneTitle: scene.title, chapterTitle: null });
  }
  return map;
}

function attachDocumentLabels(
  passages: ResolvedPassage[],
  labels: Map<string, DocumentLabel>,
): ResolvedPassage[] {
  return passages.map((passage) => {
    const entry = labels.get(passage.nodeId);
    if (!entry) return passage;
    return {
      ...passage,
      sceneTitle: entry.sceneTitle,
      chapterTitle: entry.chapterTitle,
    };
  });
}

/**
 * Build the process-disclosure payload (prompt + output) for one passage.
 * - chat: userPrompt = the preceding user utterance; full prompt (when asked)
 *   = the sent-prompt snapshot keyed by that user message id.
 * - inline-ai/beat: userPrompt = the instruction; full prompt = captured
 *   promptFull (null for generations made before capture was wired).
 * - orphan-chat/unknown: only the output text is recoverable.
 */
async function buildPassageDisclosure(
  passage: ResolvedPassage,
  contentByScene: Map<string, string>,
  includeFullSystemPrompt: boolean,
): Promise<PassageDisclosure> {
  const output = fullTextFromPmJson(
    contentByScene.get(passage.nodeId) ?? "",
    passage.from,
    passage.to,
  );
  const prov = passage.provenance;

  let userPrompt: string | null = null;
  let sentSystemPrompt: string | null = null;
  let layers: LayerBreakdown[] | null = null;

  if (prov.kind === "chat") {
    userPrompt = prov.precedingUserPrompt ?? null;
    if (includeFullSystemPrompt && prov.chatMessage) {
      // chat_message_prompts is keyed by the *user* message id, so hop from
      // the assistant message (chatMsgId) back to the turn that produced it.
      const userMsg = await loadPrecedingUserMessage(prov.chatMessage);
      const snapshot = userMsg ? await getMessagePrompt(userMsg.id) : null;
      sentSystemPrompt = snapshot?.systemPrompt ?? null;
      layers = snapshot?.layers ?? null;
    }
  } else if (prov.kind === "inline-ai" || prov.kind === "beat") {
    userPrompt = prov.instruction ?? null;
    if (includeFullSystemPrompt) {
      sentSystemPrompt = prov.promptFull ?? null;
    }
  }

  return {
    userPrompt,
    output,
    sentSystemPrompt,
    layers,
    promptRecorded: sentSystemPrompt !== null,
  };
}

export async function buildProvenanceBreakdown(
  projectId: string,
  options: {
    includePassageExcerpts?: boolean;
    includePrompts?: boolean;
    includeFullSystemPrompt?: boolean;
  } = {},
): Promise<ProvenanceDisclosureReport> {
  const authorshipReport = await buildProjectAuthorshipReport(projectId);
  const sceneIds = sceneIdsFromTotals(authorshipReport);
  const spans = await extractSpansFromDb(sceneIds);
  const includePassageExcerpts = options.includePassageExcerpts === true;
  const includePrompts = options.includePrompts === true;
  const includeFullSystemPrompt =
    includePrompts && options.includeFullSystemPrompt === true;
  // Prompts need the scene bodies too (for full output text), so load content
  // whenever either excerpts or prompts are requested.
  const needContent = includePassageExcerpts || includePrompts;

  let contentByScene = new Map<string, string>();
  if (needContent && sceneIds.length > 0) {
    const rows = await db
      .select({ id: treeNodes.id, content: treeNodes.content })
      .from(treeNodes)
      .where(inArray(treeNodes.id, sceneIds));
    contentByScene = new Map(rows.map((row) => [row.id, row.content]));
  }

  const passagesRaw = await resolveProvenance(spans, (nodeId, from, to) => {
    if (!needContent) return "";
    return excerptFromPmJson(contentByScene.get(nodeId) ?? "", from, to);
  });

  let passages = attachDocumentLabels(
    passagesRaw,
    buildSceneLabelMap(authorshipReport),
  );

  if (includePrompts) {
    passages = await Promise.all(
      passages.map(async (passage) => ({
        ...passage,
        disclosure: await buildPassageDisclosure(
          passage,
          contentByScene,
          includeFullSystemPrompt,
        ),
      })),
    );
  }

  const breakdown = emptyBreakdown();
  for (const passage of passages) addToBreakdown(breakdown, passage);

  // Map AI content is disclosed as its own lane (never folded into the
  // body-text totals/breakdown above). Only attach when there is any.
  const map = await buildMapProvenance(projectId);

  return {
    projectId,
    projectTitle: authorshipReport.projectTitle,
    generatedAt: new Date().toISOString(),
    scope: "body-text-only",
    totals: authorshipReport.totals,
    breakdown,
    orphanChatCount: passages.filter((p) => p.provenance.kind === "orphan-chat")
      .length,
    ...((includePassageExcerpts || includePrompts) && { passages }),
    ...(map.stickyCount > 0 && { map }),
    ...(includePrompts && { includePrompts: true }),
    ...(includeFullSystemPrompt && { includeFullSystemPrompt: true }),
  };
}

interface PMNodeJson {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeJson[];
}

function isLeafBlock(type: string | undefined): boolean {
  return type === "paragraph" || type === "heading" || type === "codeBlock";
}

// PM size の規約に厳密に従う walker。`extractDbSpans` が
// `doc.descendants` から保存する fromPos/toPos と同じ座標系で抽出する。
//   - doc: top-level container, opening/closing なし
//   - text: size = text.length
//   - atom (ruby / horizontalRule / sceneBreak): size = 1
//   - 通常 block (paragraph/heading/codeBlock 等): opening +1 + content + closing +1
//   - 空 leaf block: size = 2
//   - sceneBeat: 著者の構成意図のため抜粋テキストには含めないが、size は
//     通常 block と同じく opening + content + closing で進める。
function textBetweenPmPositions(
  doc: PMNodeJson,
  from: number,
  to: number,
): string {
  const parts: string[] = [];
  let suppressText = false;

  function addText(text: string, pos: number): number {
    const end = pos + text.length;
    if (!suppressText && end > from && pos < to) {
      parts.push(
        text.slice(Math.max(0, from - pos), Math.min(text.length, to - pos)),
      );
    }
    return end;
  }

  function walk(node: PMNodeJson, pos: number): number {
    if (node.type === "text") return addText(node.text ?? "", pos);

    if (node.type === "ruby") {
      const base = (node.attrs?.base as string | undefined) ?? "";
      if (!suppressText && base && pos + 1 > from && pos < to) {
        parts.push(base);
      }
      return pos + 1;
    }
    if (node.type === "horizontalRule" || node.type === "sceneBreak") {
      return pos + 1;
    }

    const isTopLevel = node.type === "doc";
    const skipText = node.type === "sceneBeat";
    const children = node.content ?? [];

    if (children.length === 0) {
      if (isTopLevel) return pos;
      return isLeafBlock(node.type) ? pos + 2 : pos;
    }

    const prevSuppress = suppressText;
    if (skipText) suppressText = true;
    let cursor = pos + (isTopLevel ? 0 : 1);
    for (const child of children) cursor = walk(child, cursor);
    if (skipText) suppressText = prevSuppress;
    return cursor + (isTopLevel ? 0 : 1);
  }

  walk(doc, 0);
  return parts.join("");
}

export function excerptFromPmJson(
  contentJson: string,
  from: number,
  to: number,
): string {
  if (!contentJson || contentJson === "{}") return "";
  try {
    const doc = JSON.parse(contentJson) as PMNodeJson;
    const text = textBetweenPmPositions(doc, from, to)
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch {
    return "";
  }
}

/**
 * Full span text for the process-disclosure "output" — same extraction as
 * `excerptFromPmJson` but without the 120-char truncation or whitespace
 * collapsing, so the disclosure shows the AI output verbatim.
 */
export function fullTextFromPmJson(
  contentJson: string,
  from: number,
  to: number,
): string {
  if (!contentJson || contentJson === "{}") return "";
  try {
    const doc = JSON.parse(contentJson) as PMNodeJson;
    return textBetweenPmPositions(doc, from, to).trim();
  } catch {
    return "";
  }
}
