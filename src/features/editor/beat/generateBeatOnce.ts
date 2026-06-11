import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";
import { insertGenerationLog } from "@/features/attribution/generationLogApi";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { buildBeatMessages } from "./beatPromptBuilder";
import { buildBeatContextForGeneration } from "./buildBeatContext";
import { appendBeatChunk, ensureGeneratedBlock } from "./insertBeatStream";

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Fire-and-forget beat generation without React hook state.
 * Used by "Place at end and generate" from the Unplaced beat menu.
 * Errors are surfaced via toast rather than component state.
 */
export async function generateBeatOnce(
  editor: Editor,
  beatId: string,
  sceneId: string,
): Promise<void> {
  // On-demand body prose generation — gate on bodyWrite like its sibling
  // useBeatGeneration.ts (the hook path). This fire-and-forget entry was the
  // one Beat path missing the gate.
  if (blockIfPolicyOff("bodyWrite")) return;
  if (blockIfUnlicensed()) return;

  const result = await buildBeatContextForGeneration(editor, beatId, sceneId);
  if (!result.ok) return;
  const ctx = result.ctx;
  const { instructions, beatType, beatModel } = ctx;

  const messages = buildBeatMessages({
    instructions,
    beatType,
    projectTitle: ctx.projectTitle,
    sceneTitle: ctx.sceneTitle,
    sceneTextSoFar: ctx.sceneTextSoFar,
    povName: ctx.povName,
    lang: ctx.lang,
    codexSummaries: ctx.codexSummaries,
    customInstruction: useSettingsStore
      .getState()
      .get("aiPrompt.custom.beat", ""),
  });

  if (!ensureGeneratedBlock(editor, beatId)) return;

  const traceId = crypto.randomUUID();
  // Single source of truth for the listener cleanup. `released` guards the
  // (theoretical) race where onDone/onError fire before the awaited Promise
  // resolves: in that case we fall through and call cleanup synchronously
  // from the .then handler instead of leaking listeners.
  let cleanup: (() => void) | null = null;
  let released = false;
  const release = () => {
    released = true;
    cleanup?.();
    cleanup = null;
  };

  try {
    const c = await sendInlineAiStream(
      messages,
      {
        onTextDelta: (delta) => {
          if (released) return;
          const ok = appendBeatChunk(editor, beatId, delta, {
            model: beatModel ?? DEFAULT_MODEL,
            traceId,
          });
          if (!ok) release();
        },
        onDone: (info) => {
          release();
          // N4: Beat 生成 (one-shot) の usage を台帳に記録する。
          void recordAiUsage({
            surface: "beat",
            model: beatModel ?? DEFAULT_MODEL,
            tokensIn: info.inputTokens,
            tokensOut: info.outputTokens,
            costUsd: info.cost ?? null,
            sceneNodeId: sceneId,
            traceId,
          });
          void Promise.resolve(
            insertGenerationLog({
              kind: "beat",
              commandId: beatType,
              instruction: instructions,
              sceneNodeId: sceneId,
              model: beatModel ?? DEFAULT_MODEL,
              traceId,
            }),
          ).catch((err: unknown) => {
            console.warn("beat generation log failed", err);
          });
        },
        onError: (message) => {
          release();
          toast.error(message);
        },
      },
      beatModel ? { model: beatModel } : undefined,
    );
    if (released) c();
    else cleanup = c;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(msg);
  }
}
