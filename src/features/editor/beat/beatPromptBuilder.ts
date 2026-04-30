import type { BeatType } from "@/features/editor/SceneBeatNode";

export interface BeatPromptInput {
  /** Beat instructions (the editable text inside the sceneBeat node). */
  instructions: string;
  /** Beat type — drives prompt tweaks (Phase A: only `free` is fully wired). */
  beatType: BeatType;
  /** Project title for system prompt grounding. */
  projectTitle: string;
  /** Scene title for system prompt grounding. */
  sceneTitle: string;
  /** Full scene body up to (and not including) the beat itself. */
  sceneTextSoFar: string;
  /**
   * POV character name to inject. `null` means "no POV override / scene POV
   * already applies to the body". The Beat-side `attrs.pov` resolution
   * happens at the call site (NodeView reads codex to map id → name).
   */
  povName: string | null;
}

/**
 * Beat type 別のスタイル指示。Phase A は `free` のみ実装し、他は同じ文言を返す
 * （Settings から差し替え可能にするのは Phase B）。
 */
function beatTypeGuidance(beatType: BeatType): string {
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

export function buildBeatSystemPrompt(input: BeatPromptInput): string {
  const lines: string[] = [
    `あなたは小説執筆アシスタントです。プロジェクト「${input.projectTitle}」のシーン「${input.sceneTitle}」の本文をビート指示に従って執筆します。`,
  ];
  if (input.povName) {
    lines.push(`このビートの視点 (POV) は「${input.povName}」です。`);
  }
  const guidance = beatTypeGuidance(input.beatType);
  if (guidance) lines.push(guidance);
  return lines.join("\n");
}

export function buildBeatUserPrompt(input: BeatPromptInput): string {
  const sections: string[] = [];
  if (input.sceneTextSoFar.trim().length > 0) {
    sections.push(`## このビート直前までのシーン本文\n${input.sceneTextSoFar}`);
  }
  sections.push(`## ビート指示\n${input.instructions}`);
  sections.push(
    "上記指示に従い、自然な散文として続きを書いてください（おおむね 500 ワード）。本文のみを出力し、メタコメントや見出しは出力しないでください。",
  );
  return sections.join("\n\n");
}

export function buildBeatMessages(
  input: BeatPromptInput,
): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: buildBeatSystemPrompt(input) },
    { role: "user", content: buildBeatUserPrompt(input) },
  ];
}
