import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { buildVsInstruction, type VsOptions } from "@/lib/verbalizedSampling";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { invokeSingleShotChat } from "@/features/chat/singleShotTransport";
import {
  captureAiOperationAuthority,
  aiAuditContextForOperation,
  type AiOperationAuthority,
} from "@/features/ai-audit/projectScope";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type { AiBranchCard } from "./mapApi";

interface LLMResponsePayload {
  blocks: Array<
    | { type: "text"; content: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "thinking"; content: string }
  >;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * AI Branch 生成で LLM が空応答(text ブロック 0 件)を返したときに投げる。
 *
 * 推論モデル(gpt-5 等)は hidden reasoning トークンも出力トークン上限(max_tokens)に
 * 課金されるため、上限が小さいと reasoning で使い切って `content` が空
 * (finish_reason:length)になる。従来は {@link parseCards} がこの空テキストを黙って
 * プレースホルダ("アイデア N" + 空 doc)で埋め、失敗を完全に隠していた。
 * これを明示エラー化し、呼び出し側(MapCanvas)でトーストできるようにする。
 *
 * count 未満の partial(1 枚でも実カードがある)は従来どおり parseCards が補完する。
 * 投げるのは「実カード 0 枚 = 完全な空応答」のときだけ。
 */
export class AiBranchEmptyResponseError extends Error {
  constructor() {
    super("AI returned an empty response (no idea text was produced).");
    this.name = "AiBranchEmptyResponseError";
  }
}

export interface AiBranchSeed {
  type: "scene" | "note" | "codex" | "sticky" | "snippet" | "ai_branch";
  title: string;
  /** Plain-text body extracted from the source entity. Empty when only a
   *  title is known (e.g. seeds without a meaningful body). */
  body?: string;
}

export interface AiBranchProjectContext {
  title: string;
  genre?: string | null;
  pov?: string | null;
  tense?: string | null;
  synopsis?: string | null;
  styleGuide?: string | null;
  aiInstructions?: string | null;
  /**
   * ユーザー定義の AI Branch 追記指示 (project_settings: aiPrompt.custom.aiBranch)。
   * system prompt 末尾に「# ユーザー追加指示」として注入される。
   * 既存の aiInstructions (「# 追加指示」, 横断的プロジェクト指示) とは別建て。
   */
  customInstruction?: string | null;
  /** project 言語 (ja/en/...). en 系のときプロンプトを英語で組む。 */
  language?: string | null;
}

// 生成カードは本文として board に書き込まれるため、プロンプトの言語は PROJECT
// 言語に従う (en プロジェクトで日本語指示の下に英語以外のカードが生成されるのを防ぐ)。
const TYPE_LABELS: Record<"ja" | "en", Record<AiBranchSeed["type"], string>> = {
  ja: {
    scene: "シーン",
    note: "ノート",
    codex: "Codex",
    sticky: "Sticky",
    snippet: "スニペット",
    ai_branch: "AI Branch",
  },
  en: {
    scene: "Scene",
    note: "Note",
    codex: "Codex",
    sticky: "Sticky",
    snippet: "Snippet",
    ai_branch: "AI Branch",
  },
};

interface MapAiStrings {
  intro: string;
  projectInfo: string;
  title: (v: string) => string;
  genre: (v: string) => string;
  pov: (v: string) => string;
  tense: (v: string) => string;
  synopsis: string;
  styleGuide: string;
  addl: string;
  userAddl: string;
  spotlight: string;
  spotlightDesc: string;
  untitled: string;
  seedNodes: string;
  seedDesc: string;
  task: string;
  taskDesc: (count: number) => string;
  theme: (v: string) => string;
  outputFormat: string;
  outputDesc: (count: number) => string;
  outputTitle: string;
  outputBody: string;
  outputTail: string;
  /** VS 有効時のみ: タイトル直下に挟む確率行の例。 */
  outputProb: string;
  /** VS 有効時のみ: 確率の意味を説明する補足行。 */
  outputProbNote: string;
  padTitle: (n: number) => string;
}

const STRINGS: Record<"ja" | "en", MapAiStrings> = {
  ja: {
    intro:
      "あなたは小説執筆を支援する AI アシスタントです。読者の興味を引き、物語の世界観を尊重したアイデアを提案してください。",
    projectInfo: "# プロジェクト情報",
    title: (v) => `- タイトル: ${v}`,
    genre: (v) => `- ジャンル: ${v}`,
    pov: (v) => `- 視点: ${v}`,
    tense: (v) => `- 時制: ${v}`,
    synopsis: "# プロジェクト概要",
    styleGuide: "# 文体ガイド",
    addl: "# 追加指示",
    userAddl: "# ユーザー追加指示",
    spotlight: "# 常時参照する設定 (Spotlight)",
    spotlightDesc:
      "以下はユーザーが Chat で pin した「常時参照したい世界観要素」です。回答にあたって尊重してください。",
    untitled: "(無題)",
    seedNodes: "# 種ノード",
    seedDesc:
      "以下のノードを「種」として、関連するアイデアを派生させてください。",
    task: "# 課題",
    taskDesc: (count) =>
      `以下のテーマについて、異なる視点から ${count} 個のアイデアを生成してください。種ノードがある場合は、その内容を踏まえて関連性のあるアイデアにしてください。`,
    theme: (v) => `テーマ: ${v}`,
    outputFormat: "# 出力形式",
    outputDesc: (count) =>
      `各アイデアは次の形式で出力してください（必ず ${count} 個、区切りは "---" のみ）:`,
    outputTitle: "## タイトル",
    outputBody: "本文テキスト",
    outputTail: '最後の区切り "---" は不要です。余分な説明は不要です。',
    outputProb: "確率: 0.07",
    outputProbNote:
      "「確率」はタイトルの直後の行に置き、0〜1 の数値でその案の典型度を表してください（低いほど珍しい）。",
    padTitle: (n) => `アイデア ${n}`,
  },
  en: {
    intro:
      "You are an AI assistant that supports novel writing. Propose ideas that engage the reader and respect the story's world. Write all ideas in English.",
    projectInfo: "# Project Information",
    title: (v) => `- Title: ${v}`,
    genre: (v) => `- Genre: ${v}`,
    pov: (v) => `- POV: ${v}`,
    tense: (v) => `- Tense: ${v}`,
    synopsis: "# Project Synopsis",
    styleGuide: "# Style Guide",
    addl: "# Additional Instructions",
    userAddl: "# User Additional Instructions",
    spotlight: "# Always-Referenced Settings (Spotlight)",
    spotlightDesc:
      "The following are world elements the user pinned in Chat to always reference. Respect them in your answer.",
    untitled: "(untitled)",
    seedNodes: "# Seed Nodes",
    seedDesc:
      "Use the following nodes as seeds and derive related ideas from them.",
    task: "# Task",
    taskDesc: (count) =>
      `Generate ${count} ideas about the following theme from different perspectives. If seed nodes are given, make the ideas relevant to their content.`,
    theme: (v) => `Theme: ${v}`,
    outputFormat: "# Output Format",
    outputDesc: (count) =>
      `Output each idea in the following format (exactly ${count}, separated only by "---"):`,
    outputTitle: "## Title",
    outputBody: "Body text",
    outputTail:
      'No trailing "---" is needed. Do not add any extra explanation.',
    outputProb: "probability: 0.07",
    outputProbNote:
      'Put "probability" on the line right after the title, as a 0–1 number indicating how typical the idea is (lower = rarer).',
    padTitle: (n) => `Idea ${n}`,
  },
};

function langKey(project: AiBranchProjectContext | null): "ja" | "en" {
  return project?.language?.startsWith("en") ? "en" : "ja";
}

export function buildSystemPrompt(
  project: AiBranchProjectContext | null,
  spotlight: AiBranchSeed[],
  vs: VsOptions | null = null,
): string {
  const lang = langKey(project);
  const S = STRINGS[lang];
  const labels = TYPE_LABELS[lang];
  const lines: string[] = [S.intro];

  if (project) {
    const info: string[] = [S.title(project.title)];
    if (project.genre) info.push(S.genre(project.genre));
    if (project.pov) info.push(S.pov(project.pov));
    if (project.tense) info.push(S.tense(project.tense));
    if (info.length > 0) {
      lines.push("");
      lines.push(S.projectInfo);
      lines.push(...info);
    }

    if (project.synopsis && project.synopsis.trim()) {
      lines.push("");
      lines.push(S.synopsis);
      lines.push(project.synopsis.trim());
    }

    if (project.styleGuide && project.styleGuide.trim()) {
      lines.push("");
      lines.push(S.styleGuide);
      lines.push(project.styleGuide.trim());
    }

    if (project.aiInstructions && project.aiInstructions.trim()) {
      lines.push("");
      lines.push(S.addl);
      lines.push(project.aiInstructions.trim());
    }

    if (project.customInstruction && project.customInstruction.trim()) {
      lines.push("");
      lines.push(S.userAddl);
      lines.push(project.customInstruction.trim());
    }
  }

  if (spotlight.length > 0) {
    lines.push("");
    lines.push(S.spotlight);
    lines.push(S.spotlightDesc);
    lines.push("");
    spotlight.forEach((s, i) => {
      lines.push(`## ${i + 1}. [${labels[s.type]}] ${s.title || S.untitled}`);
      if (s.body && s.body.trim()) {
        lines.push(s.body.trim());
      }
      lines.push("");
    });
    // 末尾の空行をトリム (join 後の余白を抑える)
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }

  // Verbalized Sampling: 多様性指示は末尾に置き、直前の世界観/指示を踏まえた上で
  // 「裾からサンプリングせよ」を最後に効かせる。
  if (vs) {
    lines.push("");
    lines.push(buildVsInstruction(lang, vs));
  }

  return lines.join("\n");
}

export function buildUserPrompt(
  userPrompt: string,
  count: number,
  seeds: AiBranchSeed[],
  lang: "ja" | "en",
  emitProbability = false,
): string {
  const S = STRINGS[lang];
  const labels = TYPE_LABELS[lang];
  const parts: string[] = [];

  if (seeds.length > 0) {
    parts.push(S.seedNodes);
    parts.push(S.seedDesc);
    parts.push("");
    seeds.forEach((s, i) => {
      parts.push(`## ${i + 1}. [${labels[s.type]}] ${s.title || S.untitled}`);
      if (s.body && s.body.trim()) {
        parts.push(s.body.trim());
      }
      parts.push("");
    });
  }

  parts.push(S.task);
  parts.push(S.taskDesc(count));
  parts.push("");
  parts.push(S.theme(userPrompt));
  parts.push("");
  parts.push(S.outputFormat);
  parts.push(S.outputDesc(count));
  parts.push("");
  parts.push(S.outputTitle);
  if (emitProbability) parts.push(S.outputProb);
  parts.push(S.outputBody);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(S.outputTail);
  if (emitProbability) parts.push(S.outputProbNote);

  return parts.join("\n");
}

// VS 有効時にカードのタイトル直下へ来る確率行 ("確率: 0.07" / "probability: 0.07")。
// 行頭一致のみ・"prob" を最短キーワードにして本文の偶発一致を避ける。
const PROBABILITY_LINE_RE =
  /^(?:確率|probability|prob)\s*[:：]\s*([0-9]*\.?[0-9]+)/i;

export function parseCards(
  text: string,
  count: number,
  lang: "ja" | "en",
  emitProbability = false,
): AiBranchCard[] {
  const segments = text
    .split(/\n---\n|\n---$/)
    .map((s) => s.trim())
    .filter(Boolean);

  const parsed: AiBranchCard[] = segments.slice(0, count).map((seg) => {
    const lines = seg.split("\n");
    const isHeader = lines[0].startsWith("## ") || lines[0].startsWith("# ");
    const title = isHeader
      ? lines[0].replace(/^#{1,3}\s*/, "").trim()
      : lines[0].trim();

    // VS 有効時 (emitProbability) のみ、タイトル直下に来る確率行
    // "確率: 0.07" / "probability: 0.07" を抽出して本文から除去する。
    // VS 無効時は LLM に確率行を出させていないため抽出しない (本文が偶然
    // "確率: …" で始まっても剥がさない = データロス防止)。
    let probability: number | undefined;
    let rest = lines.slice(1);
    if (emitProbability && rest.length > 0) {
      const m = rest[0].match(PROBABILITY_LINE_RE);
      if (m) {
        probability = parseFloat(m[1]);
        rest = rest.slice(1);
      }
    }

    const bodyText = rest
      .join("\n")
      .trim()
      .replace(/^[\s\n]+/, "");

    const paragraphs = bodyText
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    const content =
      paragraphs.length > 0
        ? paragraphs.map((p) => ({
            type: "paragraph",
            content: [{ type: "text", text: p }],
          }))
        : [{ type: "paragraph", content: [] }];

    const body = JSON.stringify({ type: "doc", content });

    return { title, body, probability };
  });

  // VS: 全カードに確率が揃っている場合のみ「珍しい(低確率)順」に並べ替える。
  // 一部だけ確率がある (LLM 出力が不完全) ときは並べ替えず入力順を保つ
  // ── 未確定カードを末尾へ飛ばさないため。確率が無い従来フォーマットも順序保持。
  const allHaveProbability =
    parsed.length > 0 && parsed.every((c) => c.probability !== undefined);
  const cards: AiBranchCard[] = allHaveProbability
    ? [...parsed].sort(
        (a, b) => (a.probability ?? Infinity) - (b.probability ?? Infinity),
      )
    : parsed;

  // Pad with empty cards if LLM returned fewer than requested
  while (cards.length < count) {
    cards.push({
      title: STRINGS[lang].padTitle(cards.length + 1),
      body: '{"type":"doc","content":[]}',
    });
  }

  return cards;
}

export async function generateAiBranchCards(
  prompt: string,
  count: number,
  seeds: AiBranchSeed[] = [],
  project: AiBranchProjectContext | null = null,
  spotlight: AiBranchSeed[] = [],
  vs: VsOptions | null = null,
  auditAuthority?: AiOperationAuthority,
): Promise<AiBranchCard[]> {
  if (blockIfPolicyOff("chat")) {
    throw new Error("chat policy is off");
  }

  // Keep direct callers safe while production orchestration passes the
  // authority captured for the board before its first await.
  const authority =
    auditAuthority ??
    captureAiOperationAuthority(getCurrentProjectId(), "map_branch");

  const lang = langKey(project);
  // VS 有効時はカードに確率を添えさせ (パース→珍しい順に並べ替え)。
  const vsForBranch: VsOptions | null = vs
    ? { ...vs, emitProbability: true }
    : null;
  const systemPrompt = buildSystemPrompt(project, spotlight, vsForBranch);
  const userPrompt = buildUserPrompt(
    prompt,
    count,
    seeds,
    lang,
    vsForBranch != null,
  );

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const ov = resolveRoleSendOverride("map_branch");
  const response: LLMResponsePayload = await invokeSingleShotChat(
    {
      messages,
      thinking: null,
      effort: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      apiVariant: ov.apiVariant,
      model: ov.model,
      provider: ov.provider,
      endpointId: ov.endpointId,
    },
    {
      ...aiAuditContextForOperation(authority, "map_branch"),
      pathId: "map_branch",
    },
  );

  // N4: 従来 response の usage は捨てられていた。台帳に記録する。
  void recordAiUsage({
    surface: "map_branch",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");

  // 空応答(推論モデルが reasoning で出力上限を使い切る等)を silent-pad で隠さず
  // 明示的に失敗させる。reasoning は thinking ブロックに入る場合があるが、それは
  // ユーザー向けの回答ではないため text 0 件は失敗として扱う。
  if (!text.trim()) {
    throw new AiBranchEmptyResponseError();
  }

  return parseCards(text, count, lang, vsForBranch != null);
}
