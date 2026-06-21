import { useEffect, useCallback, useRef } from "react";
import type { Editor } from "@tiptap/core";
import i18next from "i18next";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { useInlineAiStore } from "./inlineAiStore";
import {
  inlineAiDiffKey,
  createInlineAIDiffPlugin,
} from "./InlineAIDiffPlugin";
import { generateInlineAi } from "./inlineAiApi";
import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";
import { useTreeStore } from "@/features/tree/treeStore";
import { getProject } from "@/features/project/api";
import { insertGenerationLog } from "@/features/attribution/generationLogApi";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Manages the full Inline AI lifecycle:
 * - Plugin registration
 * - Streaming text generation + chunk insertion (history-less)
 * - Accept / Reject / Retry / Abort
 */
export function useInlineAiDiff(editor: Editor | null) {
  const lastCallRef = useRef<{
    command: InlineAiCommand;
    context: InlineAiContext;
    traceId: string;
    sceneNodeId: string | null;
    /** Full prompt sent to the model, captured on a successful generation so
     * the process-disclosure export can show it. Set after generateInlineAi
     * resolves; absent on abort/error. */
    promptText?: string;
  } | null>(null);

  useEffect(() => {
    if (!editor || !isEditorViewReady(editor)) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === inlineAiDiffKey,
    );
    if (!existing) {
      editor.registerPlugin(createInlineAIDiffPlugin(editor));
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

  /**
   * 生成中のチャンクを履歴に残さない形で挿入する。
   * `addToHistory:false` によって Undo スタックを汚染せず、Accept 時の
   * 1トランザクションのみが Undo 1 ステップになる。
   */
  const insertChunkHistoryLess = useCallback(
    (ed: Editor, pos: number, chunk: string) => {
      const { tr } = ed.state;
      tr.insertText(chunk, pos);
      tr.setMeta("addToHistory", false);
      tr.setMeta("inlineAiInsert", true);
      tr.setMeta("programmaticInsert", true);
      ed.view.dispatch(tr);
    },
    [],
  );

  const generate = useCallback(
    async (command: InlineAiCommand, context: InlineAiContext) => {
      if (!editor) return;
      // Defense: bodyWrite がポリシーで OFF なら本文生成を弾く。UI の hide とは
      // 独立した実アクションのゲートで、slash / palette からの直接発火経路を
      // 塞ぐ。store 変異 (startGeneration) より前に判定する。
      if (blockIfPolicyOff("bodyWrite")) return;
      if (blockIfUnlicensed()) return;
      const traceId = crypto.randomUUID();
      const sceneNodeId = useTreeStore.getState().activeSceneId || null;
      lastCallRef.current = { command, context, traceId, sceneNodeId };

      const { from, to } = editor.state.selection;
      const isReplace = command.mode === "replace" && from !== to;
      const originalText = isReplace
        ? editor.state.doc.textBetween(from, to)
        : "";
      const originalRange = isReplace ? { from, to } : null;
      const insertPos = isReplace ? null : from;

      const abortController = new AbortController();
      useInlineAiStore.getState().startGeneration({
        commandId: command.id,
        mode: isReplace ? "replace" : "insert",
        originalRange,
        originalText,
        insertPos,
        abortController,
        activeEditor: editor,
      });

      try {
        // 置換モードでは元テキストを残したまま選択末尾の直後に生成テキストを
        // 挿入していく。こうすることで設計書1089-1100 の「元=赤取消 / 新=緑」
        // 同時表示が可能になる。Accept 時に元テキストを一括削除＋authorship
        // 付与を1トランザクションで行い、Undo は1ステップで戻せる。
        // 挿入モードでは従来通り選択位置（= 選択なしなら caret 位置）に挿入。
        const insertedFrom = isReplace ? (originalRange?.to ?? from) : from;
        let insertedTo = insertedFrom;

        let project;
        try {
          project = await getProject(useTreeStore.getState().projectId);
        } catch {
          // ignore
        }
        const lang = project?.language ?? "ja";
        const result = await generateInlineAi(
          command,
          context,
          (chunk) => {
            // Abort 後に遅れて届いた chunk を受け取って挿入してしまう race を
            // 防ぐ。store の status が generating 以外になっていれば破棄する。
            if (useInlineAiStore.getState().status !== "generating") return;
            useInlineAiStore.getState().appendChunk(chunk);
            insertChunkHistoryLess(editor, insertedTo, chunk);
            insertedTo += chunk.length;
            useInlineAiStore
              .getState()
              .setGeneratedRange({ from: insertedFrom, to: insertedTo });
          },
          abortController.signal,
          lang,
        );

        // 成功した生成の実送信プロンプトを捕捉する (accept 時の generation log
        // に promptFull として載せる)。後発の generate が lastCallRef を差し替え
        // ていれば書かない。
        if (lastCallRef.current?.traceId === traceId) {
          lastCallRef.current.promptText = result.promptText;
        }

        // Toolbar からの早押し abort が先に店じまいを終えているケースは
        // ここで再遷移させない（reset 後だった場合に idle → diffShown と
        // 戻してしまうのを防ぐ）。
        if (useInlineAiStore.getState().status === "generating") {
          useInlineAiStore.getState().setGeneratedRange({
            from: insertedFrom,
            to: insertedTo,
          });
          if (result.stopReason === "stopped") {
            useInlineAiStore.getState().abortGeneration(result.model);
          } else {
            useInlineAiStore.getState().finishGeneration(result.model);
          }
          dispatchDiffUpdate(editor);
        }
      } catch (err) {
        // AbortController.abort() 起因のキャンセルは generateInlineAi 内部で
        // onDone("stopped") に化けるため、ここには来ない想定。通信エラー等のみ。
        const msg =
          err instanceof Error
            ? err.message
            : i18next.t("inlineAi.generateFailed");
        useInlineAiStore.getState().setError(msg);
      }
    },
    [editor, dispatchDiffUpdate, insertChunkHistoryLess],
  );

  const accept = useCallback(() => {
    if (!editor) return;
    const state = useInlineAiStore.getState();
    const { generatedRange, originalRange, mode, model } = state;
    const authorshipType = editor.schema.marks["authorship"];
    const lastCall = lastCallRef.current;
    const traceId = lastCall?.traceId ?? null;
    const resolvedModel = model ?? DEFAULT_MODEL;

    // 先に store を idle に戻す。これによって後続の実編集トランザクションが
    // filterTransaction を素通りし、通常の onUpdate 経路に乗ってオートセーブが
    // 再開する。装飾（diff-add/diff-remove）も status=idle で消える。
    useInlineAiStore.getState().reset();
    dispatchDiffUpdate(editor);

    if (generatedRange) {
      const { from: gFrom, to: gTo } = generatedRange;

      if (mode === "replace" && originalRange) {
        // 元テキスト削除 → 新テキストへの authorship 付与 を1トランザクションで。
        // 元テキストを消すと生成テキストの doc 位置が左に shift するので、
        // addMark の範囲は shift 後の座標で計算する。
        const shift = originalRange.to - originalRange.from;
        const newFrom = gFrom - shift;
        const newTo = gTo - shift;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(originalRange.from, originalRange.to);
            if (authorshipType && newFrom < newTo) {
              tr.addMark(
                newFrom,
                newTo,
                authorshipType.create({
                  source: "ai",
                  model: resolvedModel,
                  traceId,
                }),
              );
            }
            return true;
          })
          .run();
      } else if (authorshipType && gFrom < gTo) {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.addMark(
              gFrom,
              gTo,
              authorshipType.create({
                source: "ai",
                model: resolvedModel,
                traceId,
              }),
            );
            return true;
          })
          .run();
      }

      // generatedRange が無い時は mark が付かないので孤児ログを生まないよう
      // 同条件で gate する。
      if (lastCall && traceId && generatedRange) {
        void Promise.resolve(
          insertGenerationLog({
            kind: "inline-ai",
            commandId: lastCall.command.id,
            instruction: lastCall.context.arg ?? null,
            sceneNodeId: lastCall.sceneNodeId,
            model: resolvedModel,
            traceId,
            promptFull: lastCall.promptText ?? null,
          }),
        ).catch((err: unknown) => {
          console.warn("inline AI generation log failed", err);
        });
      }
    }
  }, [editor, dispatchDiffUpdate]);

  const reject = useCallback(() => {
    if (!editor) return;
    const { generatedRange } = useInlineAiStore.getState();

    // accept と同じく、先に idle に戻してから削除トランザクションを発行する。
    useInlineAiStore.getState().reset();
    dispatchDiffUpdate(editor);

    if (generatedRange) {
      const { from, to } = generatedRange;
      if (from < to) {
        editor.chain().focus().deleteRange({ from, to }).run();
      }
    }
  }, [editor, dispatchDiffUpdate]);

  /**
   * ストリーミング中 Escape 時に呼ばれる想定。
   * - status === generating → ストリーム中止（受信済みテキストは保持して diffShown）
   * - status === diffShown → reject と同じ挙動
   */
  const rejectOrAbort = useCallback(() => {
    if (!editor) return;
    const status = useInlineAiStore.getState().status;
    if (status === "generating") {
      useInlineAiStore.getState().abortGeneration(DEFAULT_MODEL);
      dispatchDiffUpdate(editor);
    } else {
      reject();
    }
  }, [editor, dispatchDiffUpdate, reject]);

  const retry = useCallback(async () => {
    if (!lastCallRef.current) return;
    reject();
    const { command, context } = lastCallRef.current;
    setTimeout(() => generate(command, context), 50);
  }, [generate, reject]);

  /**
   * Show pre-generated agent/MCP text in the diff UI (no streaming).
   */
  const showProvidedText = useCallback(
    (
      text: string,
      opts: {
        mode: "insert" | "replace";
        stagingId?: string;
        originalRange?: { from: number; to: number };
        insertPos?: number;
        model?: string;
      },
    ) => {
      if (!editor) return;
      if (blockIfPolicyOff("bodyWrite")) return;
      if (blockIfUnlicensed()) return;

      const isReplace = opts.mode === "replace" && opts.originalRange != null;
      const originalRange = isReplace ? opts.originalRange! : null;
      const originalText =
        isReplace && originalRange
          ? editor.state.doc.textBetween(originalRange.from, originalRange.to)
          : "";
      const insertPos = isReplace
        ? null
        : (opts.insertPos ?? editor.state.selection.from);

      useInlineAiStore.getState().startGeneration({
        commandId: "agent-prose",
        mode: isReplace ? "replace" : "insert",
        originalRange,
        originalText,
        insertPos,
        abortController: new AbortController(),
        activeEditor: editor,
      });
      if (opts.stagingId) {
        useInlineAiStore.setState({ stagingId: opts.stagingId });
      }

      const insertedFrom = isReplace
        ? (originalRange?.to ?? editor.state.selection.to)
        : (insertPos ?? editor.state.selection.from);
      let insertedTo = insertedFrom;

      if (text) {
        insertChunkHistoryLess(editor, insertedTo, text);
        insertedTo += text.length;
      }

      useInlineAiStore.getState().setGeneratedRange({
        from: insertedFrom,
        to: insertedTo,
      });
      useInlineAiStore.getState().finishGeneration(opts.model ?? DEFAULT_MODEL);
      dispatchDiffUpdate(editor);
    },
    [editor, dispatchDiffUpdate, insertChunkHistoryLess],
  );

  const getActiveStagingId = useCallback(
    () => useInlineAiStore.getState().stagingId,
    [],
  );

  return {
    generate,
    accept,
    reject,
    rejectOrAbort,
    retry,
    showProvidedText,
    getActiveStagingId,
  };
}
