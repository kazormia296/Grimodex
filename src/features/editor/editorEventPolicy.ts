import type { InlineAiStatus } from "@/features/editor/inlineAi/inlineAiTypes";
import type { Domain } from "@/features/timelapse/recorder";

export interface EditorUpdatePolicyInput {
  docChanged: boolean;
  isApplyingExternalUpdate: boolean;
  isInlineAiRollback?: boolean;
  inlineAiStatus: InlineAiStatus;
  activeEditor: unknown;
  editor: unknown;
}

/** True when the editor owns an unaccepted inline-AI preview. */
export function isInlineAiSaveBlocked({
  inlineAiStatus,
  activeEditor,
  editor,
}: Pick<
  EditorUpdatePolicyInput,
  "inlineAiStatus" | "activeEditor" | "editor"
>): boolean {
  return inlineAiStatus !== "idle" && activeEditor === editor;
}

/**
 * Shared contract for full-document autosave updates.
 *
 * This deliberately has no editor/store side effects. The caller owns the
 * save scheduling and dirty-state transition after this gate passes.
 */
export function shouldHandleEditorUpdate({
  docChanged,
  isApplyingExternalUpdate,
  isInlineAiRollback = false,
  inlineAiStatus,
  activeEditor,
  editor,
}: EditorUpdatePolicyInput): boolean {
  if (!docChanged || isApplyingExternalUpdate || isInlineAiRollback) {
    return false;
  }
  return !isInlineAiSaveBlocked({ inlineAiStatus, activeEditor, editor });
}

export interface EditorTimelapseCapture {
  domain: Extract<Domain, "editor" | "codex" | "snippet">;
  sceneId: string | null;
  entityType: "scene" | "codex_entry" | "snippet";
  entityId: string;
}

export interface EditorTimelapsePolicyInput {
  id: string | null;
  isEntryMode: boolean;
  isCodexMode: boolean;
  isSnippetMode: boolean;
  isChronicleEventMode: boolean;
  isApplyingExternalUpdate: boolean;
}

/** Classify a user body transaction for the timelapse recorder. */
export function getEditorTimelapseCapture({
  id,
  isEntryMode,
  isCodexMode,
  isSnippetMode,
  isChronicleEventMode,
  isApplyingExternalUpdate,
}: EditorTimelapsePolicyInput): EditorTimelapseCapture | null {
  if (!id || isApplyingExternalUpdate || isChronicleEventMode) return null;

  if (isCodexMode) {
    return {
      domain: "codex",
      sceneId: isEntryMode ? null : id,
      entityType: "codex_entry",
      entityId: id,
    };
  }

  if (isSnippetMode) {
    return {
      domain: "snippet",
      sceneId: isEntryMode ? null : id,
      entityType: "snippet",
      entityId: id,
    };
  }

  return {
    domain: "editor",
    sceneId: isEntryMode ? null : id,
    entityType: "scene",
    entityId: id,
  };
}

export interface TransactionStepLike {
  toJSON: () => unknown;
}

export function serializeTransactionSteps(
  steps: readonly TransactionStepLike[],
): unknown[] {
  return steps.map((step) => step.toJSON());
}
