import type { BeatPromptInput } from "@/features/editor/beat/beatPromptBuilder";
import type { BeatType } from "@/features/editor/SceneBeatNode";

function beatTypeGuidanceJa(beatType: BeatType): string {
  switch (beatType) {
    case "summary":
      return "指示を簡潔な記述に展開し、冗長表現を避けてください。";
    case "guided":
      return "指示の順序とトーンを厳密に守って書いてください。";
    case "dialogue":
      return "会話と動作描写を中心に、地の文を抑えて書いてください。";
    case "setting":
      return "五感描写と空間配置を重視し、会話を抑えて書いてください。";
    case "micro":
      return "100語以内で簡潔に書いてください。";
    case "free":
    default:
      return "";
  }
}

export function buildBeatSystemPromptJa(input: BeatPromptInput): string {
  const lines: string[] = [
    `あなたは小説執筆アシスタントです。プロジェクト「${input.projectTitle}」のシーン「${input.sceneTitle}」の本文をビート指示に従って執筆します。`,
  ];
  if (input.povName) {
    lines.push(`このビートの視点 (POV) は「${input.povName}」です。`);
  }
  const guidance = beatTypeGuidanceJa(input.beatType);
  if (guidance) lines.push(guidance);
  if (input.codexSummaries?.trim()) {
    lines.push(`\n## 関連設定\n${input.codexSummaries.trim()}`);
  }
  // ユーザー定義の追記指示 (aiPrompt.custom.beat)。空なら何も足さない。
  if (input.customInstruction?.trim()) {
    lines.push(`\n## 追加指示\n${input.customInstruction.trim()}`);
  }
  return lines.join("\n");
}

export function buildBeatUserPromptJa(input: BeatPromptInput): string {
  const sections: string[] = [];
  if (input.sceneTextSoFar.trim().length > 0) {
    sections.push(`## このビート直前までのシーン本文\n${input.sceneTextSoFar}`);
  }
  if (
    input.pendingBeatsSection &&
    input.pendingBeatsSection.trim().length > 0
  ) {
    sections.push(input.pendingBeatsSection.trim());
  }
  sections.push(`## ビート指示\n${input.instructions}`);
  sections.push(
    "上記指示に従い、自然な散文として続きを書いてください（おおむね 500 ワード）。本文のみを出力し、メタコメントや見出しは出力しないでください。",
  );
  return sections.join("\n\n");
}
