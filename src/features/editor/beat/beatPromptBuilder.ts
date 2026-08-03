import type { BeatType } from "./beatTypes";
import { getPromptCatalog } from "@/prompts/index";

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
  /**
   * Pre-rendered "pending beats" section string (C-1: buildPendingBeatsSection).
   * Empty string or undefined → omitted from prompt.
   */
  pendingBeatsSection?: string;
  /**
   * 検出 codex の `- name: summary` 行（buildBeatCodexSummaries の出力）。
   * inline AI の codexSummaries と同形式。空/未指定なら省略。
   */
  codexSummaries?: string;
  /** 執筆言語（project.language）。省略時は "ja" にフォールバック */
  lang?: string;
  /**
   * ユーザー定義のビート追記指示 (project_settings: aiPrompt.custom.beat)。
   * system prompt 末尾に追記される。空/未指定なら何も足さない。
   */
  customInstruction?: string;
}

export function buildBeatSystemPrompt(input: BeatPromptInput): string {
  return getPromptCatalog(input.lang ?? "ja").beat.buildSystemPrompt(input);
}

export function buildBeatUserPrompt(input: BeatPromptInput): string {
  return getPromptCatalog(input.lang ?? "ja").beat.buildUserPrompt(input);
}

export function buildBeatMessages(
  input: BeatPromptInput,
): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: buildBeatSystemPrompt(input) },
    { role: "user", content: buildBeatUserPrompt(input) },
  ];
}
