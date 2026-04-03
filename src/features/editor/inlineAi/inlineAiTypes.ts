export type InlineAiStatus = "idle" | "generating" | "diffShown" | "error";
export type InlineAiMode = "insert" | "replace";

export interface InlineAiCommand {
  id: string;
  label: string;
  description: string;
  mode: InlineAiMode;
  needsSelection: boolean;
  /** Whether the command requires an extra argument (e.g. target name, tone) */
  needsArg?: boolean;
  argPlaceholder?: string;
}

export interface InlineAiContext {
  projectTitle: string;
  sceneTitle: string;
  sceneText: string;
  codexSummaries: string;
  selectedText?: string;
  cursorContext?: string;
  arg?: string;
}

export interface InlineAiState {
  status: InlineAiStatus;
  mode: InlineAiMode;
  activeCommandId: string | null;
  /** Original selection range for replace-mode commands */
  originalRange: { from: number; to: number } | null;
  /** Text before generation started (for reject/undo) */
  originalText: string;
  /** Accumulated generated text */
  generatedText: string;
  /** Insert position for insert-mode commands */
  insertPos: number | null;
  /** Absolute range of generated text in the doc (set after insertion) */
  generatedRange: { from: number; to: number } | null;
  error: string | null;
  model: string | null;
}
