import { useEffect, useCallback, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { useInlineAiStore } from "./inlineAiStore";
import {
  inlineAiDiffKey,
  createInlineAIDiffPlugin,
} from "./InlineAIDiffPlugin";
import { generateInlineAi } from "./inlineAiApi";
import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";

/**
 * Manages the full Inline AI lifecycle:
 * - Plugin registration
 * - Text generation + streaming insertion
 * - Accept / Reject / Retry
 */
export function useInlineAiDiff(editor: Editor | null) {
  // Keep a ref to the last command+context for Retry
  const lastCallRef = useRef<{
    command: InlineAiCommand;
    context: InlineAiContext;
  } | null>(null);

  // Register diff decoration plugin
  useEffect(() => {
    if (!editor) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === inlineAiDiffKey,
    );
    if (!existing) {
      editor.registerPlugin(createInlineAIDiffPlugin());
    }
    return () => {
      editor.unregisterPlugin(inlineAiDiffKey);
    };
  }, [editor]);

  const dispatchDiffUpdate = useCallback((ed: Editor) => {
    const { tr } = ed.state;
    tr.setMeta("inlineAiDiffUpdate", true);
    ed.view.dispatch(tr);
  }, []);

  const generate = useCallback(
    async (command: InlineAiCommand, context: InlineAiContext) => {
      if (!editor) return;
      lastCallRef.current = { command, context };

      const { from, to } = editor.state.selection;
      const isReplace = command.mode === "replace" && from !== to;
      const originalText = isReplace
        ? editor.state.doc.textBetween(from, to)
        : "";
      const originalRange = isReplace ? { from, to } : null;
      const insertPos = isReplace ? null : from;

      useInlineAiStore.getState().startGeneration({
        commandId: command.id,
        mode: isReplace ? "replace" : "insert",
        originalRange,
        originalText,
        insertPos,
      });

      // In replace mode, delete selected text first
      if (isReplace) {
        editor.chain().focus().deleteRange({ from, to }).run();
      }

      try {
        const cursorFrom = editor.state.selection.from;
        const insertedFrom = cursorFrom;
        let insertedTo = cursorFrom;

        await generateInlineAi(command, context, (chunk) => {
          useInlineAiStore.getState().appendChunk(chunk);
          // Insert chunk at current cursor position
          editor
            .chain()
            .focus()
            .insertContentAt(insertedTo, chunk, {
              updateSelection: false,
            })
            .run();
          insertedTo = insertedTo + chunk.length;
        });

        useInlineAiStore.getState().setGeneratedRange({
          from: insertedFrom,
          to: insertedTo,
        });
        useInlineAiStore.getState().finishGeneration("claude-sonnet-4-6");
        dispatchDiffUpdate(editor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "生成に失敗しました";
        useInlineAiStore.getState().setError(msg);
      }
    },
    [editor, dispatchDiffUpdate],
  );

  const accept = useCallback(() => {
    if (!editor) return;
    const { generatedRange, model } = useInlineAiStore.getState();
    if (generatedRange) {
      const { from, to } = generatedRange;
      const authorshipType = editor.schema.marks["authorship"];
      if (authorshipType && from < to) {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.addMark(
              from,
              to,
              authorshipType.create({
                source: "ai",
                model: model ?? undefined,
              }),
            );
            return true;
          })
          .run();
      }
    }
    useInlineAiStore.getState().reset();
    dispatchDiffUpdate(editor);
  }, [editor, dispatchDiffUpdate]);

  const reject = useCallback(() => {
    if (!editor) return;
    const { generatedRange, originalText, mode } = useInlineAiStore.getState();

    if (generatedRange) {
      const { from, to } = generatedRange;
      // Remove generated text and restore original if replace mode
      editor.chain().focus().deleteRange({ from, to }).run();
      if (mode === "replace" && originalText) {
        editor.chain().focus().insertContentAt(from, originalText).run();
      }
    }
    useInlineAiStore.getState().reset();
    dispatchDiffUpdate(editor);
  }, [editor, dispatchDiffUpdate]);

  const retry = useCallback(async () => {
    if (!lastCallRef.current) return;
    reject();
    const { command, context } = lastCallRef.current;
    // Small delay to let reject settle before re-generating
    setTimeout(() => generate(command, context), 50);
  }, [generate, reject]);

  return { generate, accept, reject, retry };
}
