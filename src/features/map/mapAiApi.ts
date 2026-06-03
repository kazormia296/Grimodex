import { invoke } from "@/lib/tauri";
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
}

const TYPE_LABELS: Record<AiBranchSeed["type"], string> = {
  scene: "シーン",
  note: "ノート",
  codex: "Codex",
  sticky: "Sticky",
  snippet: "スニペット",
  ai_branch: "AI Branch",
};

function buildSystemPrompt(
  project: AiBranchProjectContext | null,
  spotlight: AiBranchSeed[],
): string {
  const lines: string[] = [
    "あなたは小説執筆を支援する AI アシスタントです。読者の興味を引き、物語の世界観を尊重したアイデアを提案してください。",
  ];

  if (project) {
    const info: string[] = [`- タイトル: ${project.title}`];
    if (project.genre) info.push(`- ジャンル: ${project.genre}`);
    if (project.pov) info.push(`- 視点: ${project.pov}`);
    if (project.tense) info.push(`- 時制: ${project.tense}`);
    if (info.length > 0) {
      lines.push("");
      lines.push("# プロジェクト情報");
      lines.push(...info);
    }

    if (project.synopsis && project.synopsis.trim()) {
      lines.push("");
      lines.push("# プロジェクト概要");
      lines.push(project.synopsis.trim());
    }

    if (project.styleGuide && project.styleGuide.trim()) {
      lines.push("");
      lines.push("# 文体ガイド");
      lines.push(project.styleGuide.trim());
    }

    if (project.aiInstructions && project.aiInstructions.trim()) {
      lines.push("");
      lines.push("# 追加指示");
      lines.push(project.aiInstructions.trim());
    }

    if (project.customInstruction && project.customInstruction.trim()) {
      lines.push("");
      lines.push("# ユーザー追加指示");
      lines.push(project.customInstruction.trim());
    }
  }

  if (spotlight.length > 0) {
    lines.push("");
    lines.push("# 常時参照する設定 (Spotlight)");
    lines.push(
      "以下はユーザーが Chat で pin した「常時参照したい世界観要素」です。回答にあたって尊重してください。",
    );
    lines.push("");
    spotlight.forEach((s, i) => {
      lines.push(
        `## ${i + 1}. [${TYPE_LABELS[s.type]}] ${s.title || "(無題)"}`,
      );
      if (s.body && s.body.trim()) {
        lines.push(s.body.trim());
      }
      lines.push("");
    });
    // 末尾の空行をトリム (join 後の余白を抑える)
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }

  return lines.join("\n");
}

function buildUserPrompt(
  userPrompt: string,
  count: number,
  seeds: AiBranchSeed[],
): string {
  const parts: string[] = [];

  if (seeds.length > 0) {
    parts.push("# 種ノード");
    parts.push(
      "以下のノードを「種」として、関連するアイデアを派生させてください。",
    );
    parts.push("");
    seeds.forEach((s, i) => {
      parts.push(
        `## ${i + 1}. [${TYPE_LABELS[s.type]}] ${s.title || "(無題)"}`,
      );
      if (s.body && s.body.trim()) {
        parts.push(s.body.trim());
      }
      parts.push("");
    });
  }

  parts.push("# 課題");
  parts.push(
    `以下のテーマについて、異なる視点から ${count} 個のアイデアを生成してください。種ノードがある場合は、その内容を踏まえて関連性のあるアイデアにしてください。`,
  );
  parts.push("");
  parts.push(`テーマ: ${userPrompt}`);
  parts.push("");
  parts.push("# 出力形式");
  parts.push(
    `各アイデアは次の形式で出力してください（必ず ${count} 個、区切りは "---" のみ）:`,
  );
  parts.push("");
  parts.push("## タイトル");
  parts.push("本文テキスト");
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push('最後の区切り "---" は不要です。余分な説明は不要です。');

  return parts.join("\n");
}

function parseCards(text: string, count: number): AiBranchCard[] {
  const segments = text
    .split(/\n---\n|\n---$/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cards: AiBranchCard[] = segments.slice(0, count).map((seg) => {
    const lines = seg.split("\n");
    const isHeader = lines[0].startsWith("## ") || lines[0].startsWith("# ");
    const title = isHeader
      ? lines[0].replace(/^#{1,3}\s*/, "").trim()
      : lines[0].trim();
    const bodyLines = lines.slice(1);

    const bodyText = bodyLines
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

    return { title, body };
  });

  // Pad with empty cards if LLM returned fewer than requested
  while (cards.length < count) {
    cards.push({
      title: `アイデア ${cards.length + 1}`,
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
): Promise<AiBranchCard[]> {
  const systemPrompt = buildSystemPrompt(project, spotlight);
  const userPrompt = buildUserPrompt(prompt, count, seeds);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await invoke<LLMResponsePayload>("send_chat_message", {
    messages,
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
  });

  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");

  return parseCards(text, count);
}
