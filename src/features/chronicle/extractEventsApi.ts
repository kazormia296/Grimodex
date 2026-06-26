import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { createEvent, linkSceneToEvent } from "./api";

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

/**
 * LLM 応答テキストから出来事候補を抽出・検証する純関数。
 * 許可 sceneId 外（ハルシネーション）は落とす。title 空 / events 非配列は除外。
 */
export function parseEventProposals(
  responseText: string,
  allowedSceneIds: Set<string>,
): EventProposal[] {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return [];
  let parsed: { events?: unknown };
  try {
    parsed = JSON.parse(jsonText) as { events?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.events)) return [];
  const out: EventProposal[] = [];
  for (const raw of parsed.events) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    const ids = Array.isArray(o.evidenceSceneIds) ? o.evidenceSceneIds : [];
    const seen = new Set<string>();
    const evidenceSceneIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string") continue;
      if (!allowedSceneIds.has(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      evidenceSceneIds.push(id);
    }
    const note =
      typeof o.note === "string" ? o.note.trim() || undefined : undefined;
    out.push(
      note ? { title, evidenceSceneIds, note } : { title, evidenceSceneIds },
    );
  }
  return out;
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

  const ov = resolveRoleSendOverride("plot_thread_propose");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
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
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

  return parseEventProposals(response.text, allowedSceneIds);
}

/**
 * 抽出候補を events として一括作成し、根拠シーンを scene_events で結ぶ。
 * 作成した出来事数を返す。
 */
export async function importExtractedEvents(
  projectId: string,
  proposals: EventProposal[],
): Promise<number> {
  let count = 0;
  for (const p of proposals) {
    const ev = await createEvent({
      projectId,
      title: p.title,
      note: p.note ?? null,
    });
    for (const sid of p.evidenceSceneIds) {
      await linkSceneToEvent(sid, ev.id);
    }
    count++;
  }
  return count;
}
