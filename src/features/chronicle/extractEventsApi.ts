import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { createEvent, deleteEvent, linkScenesToEvent, listEvents } from "./api";
import { useTreeStore } from "@/features/tree/treeStore";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";

export interface ExtractEventsRequest {
  scenes: Array<{
    sceneId: string;
    title: string;
    bodyText: string;
    orderIndex: number;
  }>;
  existingTitles: string[];
}

export interface EventProposal {
  title: string;
  /** 出来事の根拠となるシーン id（req.scenes の id のみ）。 */
  evidenceSceneIds: string[];
  note?: string;
}

export type EventProposalParseDiagnostic =
  | {
      readonly code: "unknown-scene-reference";
      readonly eventIndex: number;
      readonly value: string;
    }
  | {
      readonly code: "missing-evidence";
      readonly eventIndex: number;
    };

export type EventProposalParseResult =
  | {
      readonly status: "parsed";
      readonly proposals: readonly EventProposal[];
      readonly diagnostics: readonly EventProposalParseDiagnostic[];
    }
  | {
      readonly status: "invalid";
      readonly reason:
        | "json-not-found"
        | "json-parse-failed"
        | "events-not-array";
    };

/**
 * LLM 応答テキストから出来事候補を抽出・検証する純関数。
 * 許可 sceneId 外（ハルシネーション）は落とす。title 空 / events 非配列は除外。
 */
export function parseEventProposalsResult(
  responseText: string,
  allowedSceneIds: Set<string>,
): EventProposalParseResult {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return { status: "invalid", reason: "json-not-found" };
  let parsed: { events?: unknown };
  try {
    parsed = JSON.parse(jsonText) as { events?: unknown };
  } catch {
    return { status: "invalid", reason: "json-parse-failed" };
  }
  if (!Array.isArray(parsed.events)) {
    return { status: "invalid", reason: "events-not-array" };
  }
  const out: EventProposal[] = [];
  const diagnostics: EventProposalParseDiagnostic[] = [];
  for (const [eventIndex, raw] of parsed.events.entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    const ids = Array.isArray(o.evidenceSceneIds) ? o.evidenceSceneIds : [];
    const seen = new Set<string>();
    const evidenceSceneIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string") continue;
      if (!allowedSceneIds.has(id)) {
        diagnostics.push({
          code: "unknown-scene-reference",
          eventIndex,
          value: id,
        });
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      evidenceSceneIds.push(id);
    }
    if (evidenceSceneIds.length === 0) {
      diagnostics.push({ code: "missing-evidence", eventIndex });
    }
    const note =
      typeof o.note === "string" ? o.note.trim() || undefined : undefined;
    out.push(
      note ? { title, evidenceSceneIds, note } : { title, evidenceSceneIds },
    );
  }
  return { status: "parsed", proposals: out, diagnostics };
}

export function parseEventProposals(
  responseText: string,
  allowedSceneIds: Set<string>,
): EventProposal[] {
  const result = parseEventProposalsResult(responseText, allowedSceneIds);
  return result.status === "parsed" ? [...result.proposals] : [];
}

/** 出来事抽出プロンプトを組む純関数（catalog に依らずローカル定義）。 */
export function buildExtractEventsPrompt(args: {
  scenes: ExtractEventsRequest["scenes"];
  existingTitles: string[];
  customInstruction?: string;
}): string {
  const sceneTexts = args.scenes
    .map(
      (s) =>
        `--- sceneId=${s.sceneId}, title=${s.title}, order=${s.orderIndex} ---\n${s.bodyText}`,
    )
    .join("\n\n");
  const existing =
    args.existingTitles.length > 0
      ? args.existingTitles.map((t) => `- ${t}`).join("\n")
      : "(なし)";
  const custom = args.customInstruction?.trim()
    ? `\n\n# 追加指示\n${args.customInstruction.trim()}`
    : "";
  return `あなたは小説の作中年表アシスタントです。以下のシーン本文から「作中で起きた出来事」を抽出してください。
各出来事には簡潔なタイトルと、その根拠となるシーンの id（evidenceSceneIds・与えた id のみ）を付けます。
既存の出来事と重複しないものだけを挙げてください。

# 既存の出来事
${existing}

# シーン本文
${sceneTexts}
${custom}

# 出力（JSON のみ・他の文字を含めない）
{"events":[{"title":"出来事のタイトル","evidenceSceneIds":["sceneId"],"note":"任意の補足"}]}`;
}

/**
 * 本文を LLM 解析し、作中の出来事候補を提案する。モデルルーティングは
 * 既存 'plot_thread_propose'（structured ロール）を流用（同種の構造化抽出）。
 * ライブ出力の品質検証は実機 QA（キー必須）に委ねる。
 *
 * @deprecated ChronicleExtractionRun を使用すること（`startChronicleExtraction`）。
 */
export async function proposeEvents(
  req: ExtractEventsRequest,
): Promise<EventProposal[]> {
  if (blockIfPolicyOff("analysis")) return [];
  const nonEmpty = req.scenes.filter((s) => s.bodyText.trim().length > 0);
  if (nonEmpty.length === 0) return [];
  const allowedSceneIds = new Set(nonEmpty.map((s) => s.sceneId));

  const customInstruction = useSettingsStore
    .getState()
    .get("aiPrompt.custom.chronicle", "");

  const prompt = buildExtractEventsPrompt({
    scenes: nonEmpty,
    existingTitles: req.existingTitles,
    customInstruction,
  });

  const ov = resolveRoleSendOverride("chronicle_extract");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId: requireAuditProjectId(useTreeStore.getState().projectId),
      pathId: "chronicle_extract",
    },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: "chronicle_extract",
    // 実際に送ったモデル/プロバイダ（経路 override）を台帳へ。未指定だと
    // recordAiUsage 側が既定チャットモデルへフォールバックし台帳が嘘になる。
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

  return parseEventProposals(response.text, allowedSceneIds);
}

/** 重複判定用のタイトル正規化（trim → NFC → 小文字）。 */
function normalizeEventTitle(title: string): string {
  return title.trim().normalize("NFC").toLowerCase();
}

/**
 * 抽出候補を events として一括作成し、根拠シーンを scene_events で結ぶ。
 * 作成した出来事数を返す（スキップ分は含めない）。
 *
 * 既存タイトルと重複する候補はプロンプトヒントだけでは弾けない（非準拠モデルが
 * 重複を返す）ため、ここで正規化タイトル一致を programmatic にスキップする。
 * `existingTitles` 未指定時は DB（listEvents）から取得＝呼び出し側を変えずに
 * 重複取り込みを防ぐ。同一バッチ内の重複も先勝ちでスキップする。
 *
 * @deprecated Narrative Commit を使用すること（`applyChronicleExtractionReview`）。
 */
export async function importExtractedEvents(
  projectId: string,
  proposals: EventProposal[],
  existingTitles?: string[],
): Promise<number> {
  const baseTitles =
    existingTitles ?? (await listEvents(projectId)).map((e) => e.title);
  const seen = new Set(baseTitles.map(normalizeEventTitle));
  let count = 0;
  const createdIds: string[] = [];
  try {
    for (const p of proposals) {
      const norm = normalizeEventTitle(p.title);
      if (seen.has(norm)) continue; // 既存（または本バッチ内）と重複 → スキップ
      seen.add(norm);
      const ev = await createEvent({
        projectId,
        title: p.title,
        note: p.note ?? null,
      });
      createdIds.push(ev.id);
      // 根拠シーンは一括リンク（per-scene の検証 SELECT ×2 を畳む）。
      await linkScenesToEvent(projectId, p.evidenceSceneIds, ev.id);
      count++;
    }
    return count;
  } catch (err) {
    await Promise.allSettled(
      createdIds.map((id) => deleteEvent(id, projectId)),
    );
    throw err;
  }
}

import type { ChronicleReviewProposal } from "./chronicleExtractionStore";

/** Feature flag: Run-based Chronicle extraction is the only product path (PR6). */
export const USE_NARRATIVE_EXTRACTION_RUN = true;

export type { ChronicleReviewProposal } from "./chronicleExtractionStore";
export type { StartChronicleExtractionRequest } from "./chronicleExtractionStore";
export type { ChronicleExtractionReviewProjection } from "./chronicleExtractionStore";

export async function startChronicleExtraction(
  ...args: Parameters<
    typeof import("./chronicleExtractionApi").startChronicleExtraction
  >
): ReturnType<
  typeof import("./chronicleExtractionApi").startChronicleExtraction
> {
  const mod = await import("./chronicleExtractionApi");
  return mod.startChronicleExtraction(...args);
}

export async function getChronicleExtractionReview(
  ...args: Parameters<
    typeof import("./chronicleExtractionApi").getChronicleExtractionReview
  >
): ReturnType<
  typeof import("./chronicleExtractionApi").getChronicleExtractionReview
> {
  const mod = await import("./chronicleExtractionApi");
  return mod.getChronicleExtractionReview(...args);
}

export async function restoreChronicleExtractionReview(
  ...args: Parameters<
    typeof import("./chronicleExtractionApi").restoreChronicleExtractionReview
  >
): ReturnType<
  typeof import("./chronicleExtractionApi").restoreChronicleExtractionReview
> {
  const mod = await import("./chronicleExtractionApi");
  return mod.restoreChronicleExtractionReview(...args);
}

export async function buildChronicleExtractionReviewProjection(
  ...args: Parameters<
    typeof import("./chronicleExtractionApi").buildChronicleExtractionReviewProjection
  >
): Promise<
  ReturnType<
    typeof import("./chronicleExtractionApi").buildChronicleExtractionReviewProjection
  >
> {
  const mod = await import("./chronicleExtractionApi");
  return mod.buildChronicleExtractionReviewProjection(...args);
}

export async function recordChronicleProposalDecision(
  ...args: Parameters<
    typeof import("./chronicleExtractionApi").recordChronicleProposalDecision
  >
): ReturnType<
  typeof import("./chronicleExtractionApi").recordChronicleProposalDecision
> {
  const mod = await import("./chronicleExtractionApi");
  return mod.recordChronicleProposalDecision(...args);
}

export async function recordChronicleProposalRevision(
  ...args: Parameters<
    typeof import("./chronicleExtractionApi").recordChronicleProposalRevision
  >
): ReturnType<
  typeof import("./chronicleExtractionApi").recordChronicleProposalRevision
> {
  const mod = await import("./chronicleExtractionApi");
  return mod.recordChronicleProposalRevision(...args);
}

type CommitCoordinatorApi = {
  readonly isCommitCoordinatorReady: () => boolean;
  readonly applyChronicleExtractionCommit: (input: {
    readonly projectId: string;
    readonly proposals: readonly ChronicleReviewProposal[];
  }) => Promise<number>;
};

let commitCoordinatorOverride: CommitCoordinatorApi | null = null;

/** Tests may inject a stub commit coordinator. */
export function __setCommitCoordinatorForTests(
  api: CommitCoordinatorApi | null,
): void {
  commitCoordinatorOverride = api;
}

/**
 * Apply approved Run proposals via the real commit coordinator
 * (`prepareChronicleCommit` + `applyChronicleCommit`). Legacy
 * `importExtractedEvents` is not used on the product path.
 */
export async function applyChronicleExtractionReview(args: {
  readonly projectId: string;
  readonly proposals: readonly ChronicleReviewProposal[];
}): Promise<number> {
  const approved = args.proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.payload &&
      (proposal.match.status !== "probable-duplicate" ||
        proposal.probableDuplicateChoice === "create-as-new"),
  );

  if (
    commitCoordinatorOverride &&
    commitCoordinatorOverride.isCommitCoordinatorReady()
  ) {
    return commitCoordinatorOverride.applyChronicleExtractionCommit({
      projectId: args.projectId,
      proposals: approved,
    });
  }

  const mod = await import("./chronicleExtractionApi");
  return mod.applyChronicleExtractionCommit({
    projectId: args.projectId,
    proposals: approved,
  });
}

