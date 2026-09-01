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
import type { GroupIndex } from "@/features/editor/tabStore";
import { META_SKIP } from "@/features/editor/TrashBinCapturePlugin";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export interface InlineAiProjectionAuthority {
  keyRef: { current: string };
  readyRef: { current: boolean };
  writableRef?: { current: boolean };
}

function isProjectionCurrent(
  projection: InlineAiProjectionAuthority | undefined,
  projectionKey: string | null,
): boolean {
  return (
    projection == null ||
    (projection.readyRef.current && projection.keyRef.current === projectionKey)
  );
}

function isProjectionWritable(
  projection: InlineAiProjectionAuthority | undefined,
): boolean {
  return projection?.writableRef?.current ?? true;
}

function isSessionOwnedByEditor(
  editor: Editor,
  projection: InlineAiProjectionAuthority | undefined,
  projectionKey: string | null,
): boolean {
  const state = useInlineAiStore.getState();
  // activeEditor=null is the legacy single-editor contract. Once a caller
  // supplies a projection authority, a session must also carry that exact key.
  const editorMatches =
    state.activeEditor === editor ||
    (projection == null && state.activeEditor === null);
  return (
    editorMatches &&
    state.projectionKey === projectionKey &&
    isProjectionCurrent(projection, projectionKey)
  );
}

/**
 * Remove an unaccepted preview only when the session still owns the editor.
 * If the projection has already changed, the old absolute range is no longer
 * meaningful and must not be applied to the new document; the canonical load
 * will replace that document instead. `inlineAiRollback` is consumed by the
 * editor update policy so cleanup never becomes a persisted body edit.
 */
export function rollbackInlineAiSession(
  editor: Editor | null,
  projection: InlineAiProjectionAuthority | undefined,
  expectedSessionId?: string | null,
): boolean {
  if (!editor) return false;
  const state = useInlineAiStore.getState();
  const editorMatches =
    state.activeEditor === editor ||
    (projection == null && state.activeEditor === null);
  if (!editorMatches) return false;
  if (expectedSessionId != null && state.sessionId !== expectedSessionId) {
    return false;
  }

  const generatedRange = state.generatedRange;
  const canDeletePreview =
    generatedRange != null &&
    generatedRange.from < generatedRange.to &&
    !editor.isDestroyed &&
    isEditorViewReady(editor) &&
    isProjectionCurrent(projection, state.projectionKey) &&
    generatedRange.to <= editor.state.doc.content.size;

  state.reset();
  if (editor.isDestroyed || !isEditorViewReady(editor)) return true;

  try {
    const transaction = editor.state.tr
      .setMeta("inlineAiDiffUpdate", true)
      .setMeta("inlineAiRollback", true)
      .setMeta("preventUpdate", true)
      .setMeta("addToHistory", false);
    if (canDeletePreview) {
      transaction.delete(generatedRange!.from, generatedRange!.to);
    }
    editor.view.dispatch(transaction);
  } catch {
    // The editor may be destroyed between the readiness check and dispatch.
    // The store reset is still the safe outcome; never rethrow during cleanup.
  }
  return true;
}

/**
 * Manages the full Inline AI lifecycle:
 * - Plugin registration
 * - Streaming text generation + chunk insertion (history-less)
 * - Accept / Reject / Retry / Abort
 */
export function useInlineAiDiff(
  editor: Editor | null,
  activeEditorGroup: GroupIndex | null = null,
  projection?: InlineAiProjectionAuthority,
) {
  const lastCallRef = useRef<{
    command: InlineAiCommand;
    context: InlineAiContext;
    traceId: string;
    sceneNodeId: string | null;
    ownerEditor: Editor;
    projectionKey: string | null;
    sessionId: string;
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

  const rollback = useCallback(
    (expectedSessionId?: string | null) =>
      rollbackInlineAiSession(editor, projection, expectedSessionId),
    [editor, projection],
  );

  const generate = useCallback(
    async (command: InlineAiCommand, context: InlineAiContext) => {
      if (!editor) return;
      // Defense: bodyWrite がポリシーで OFF なら本文生成を弾く。UI の hide とは
      // 独立した実アクションのゲートで、slash / palette からの直接発火経路を
      // 塞ぐ。store 変異 (startGeneration) より前に判定する。
      if (blockIfPolicyOff("bodyWrite")) return;
      if (blockIfUnlicensed()) return;
      if (
        (projection && !projection.readyRef.current) ||
        !isProjectionWritable(projection)
      ) {
        return;
      }
      const existingState = useInlineAiStore.getState();
      if (existingState.status !== "idle") {
        existingState.requestAttention();
        return;
      }
      const projectionKey = projection?.keyRef.current ?? null;
      const sessionId = crypto.randomUUID();
      const traceId = crypto.randomUUID();
      const sceneNodeId = useTreeStore.getState().activeSceneId || null;
      lastCallRef.current = {
        command,
        context,
        traceId,
        sceneNodeId,
        ownerEditor: editor,
        projectionKey,
        sessionId,
      };

      const { from, to } = editor.state.selection;
      const isReplace = command.mode === "replace" && from !== to;
      const originalText = isReplace
        ? editor.state.doc.textBetween(from, to)
        : "";
      const originalRange = isReplace ? { from, to } : null;
      const insertPos = isReplace ? null : from;

      const abortController = new AbortController();
      const started = useInlineAiStore.getState().startGeneration({
        commandId: command.id,
        mode: isReplace ? "replace" : "insert",
        originalRange,
        originalText,
        insertPos,
        abortController,
        activeEditor: editor,
        activeEditorGroup,
        projectionKey,
        sessionId,
      });
      if (!started) return;

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
            const state = useInlineAiStore.getState();
            if (
              state.status !== "generating" ||
              state.activeEditor !== editor ||
              state.projectionKey !== projectionKey ||
              state.sessionId !== sessionId ||
              !isProjectionCurrent(projection, projectionKey) ||
              !isProjectionWritable(projection)
            ) {
              abortController.abort();
              if (
                state.activeEditor === editor &&
                state.projectionKey === projectionKey &&
                state.sessionId === sessionId
              ) {
                rollback(sessionId);
              }
              return;
            }
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

        const stateAfterGeneration = useInlineAiStore.getState();
        if (
          stateAfterGeneration.activeEditor !== editor ||
          stateAfterGeneration.projectionKey !== projectionKey ||
          stateAfterGeneration.sessionId !== sessionId ||
          !isProjectionCurrent(projection, projectionKey) ||
          !isProjectionWritable(projection)
        ) {
          abortController.abort();
          if (
            stateAfterGeneration.activeEditor === editor &&
            stateAfterGeneration.projectionKey === projectionKey &&
            stateAfterGeneration.sessionId === sessionId
          ) {
            rollback(sessionId);
          }
          return;
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
        const stateAfterError = useInlineAiStore.getState();
        if (
          stateAfterError.activeEditor !== editor ||
          stateAfterError.projectionKey !== projectionKey ||
          stateAfterError.sessionId !== sessionId ||
          !isProjectionCurrent(projection, projectionKey)
        ) {
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : i18next.t("inlineAi.generateFailed");
        if (!isProjectionWritable(projection)) {
          rollback(sessionId);
        } else {
          useInlineAiStore.getState().setError(msg);
        }
      }
    },
    [
      activeEditorGroup,
      editor,
      dispatchDiffUpdate,
      insertChunkHistoryLess,
      projection,
      rollback,
    ],
  );

  const accept = useCallback(() => {
    if (!editor) return;
    const state = useInlineAiStore.getState();
    const projectionKey = projection?.keyRef.current ?? null;
    if (
      !isSessionOwnedByEditor(editor, projection, projectionKey) ||
      !isProjectionWritable(projection)
    ) {
      rollback(state.sessionId);
      return;
    }
    const { generatedRange, originalRange, mode, model } = state;
    const authorshipType = editor.schema.marks["authorship"];
    const lastCall =
      lastCallRef.current?.ownerEditor === editor &&
      lastCallRef.current.projectionKey === projectionKey &&
      lastCallRef.current.sessionId === state.sessionId
        ? lastCallRef.current
        : null;
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
  }, [editor, dispatchDiffUpdate, projection, rollback]);

  const reject = useCallback(() => {
    if (!editor) return;
    const state = useInlineAiStore.getState();
    const projectionKey = projection?.keyRef.current ?? null;
    if (!isSessionOwnedByEditor(editor, projection, projectionKey)) {
      rollback(state.sessionId);
      return;
    }
    const { generatedRange } = state;

    // accept と同じく、先に idle に戻してから削除トランザクションを発行する。
    useInlineAiStore.getState().reset();
    dispatchDiffUpdate(editor);

    if (generatedRange) {
      const { from, to } = generatedRange;
      if (from < to) {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            // Rejecting an inline-AI preview is a programmatic rollback, not
            // a user deletion. Keep it out of Trash Bin capture while
            // preserving normal Delete/Backspace capture for human edits.
            tr.setMeta(META_SKIP, true);
            return true;
          })
          .deleteRange({ from, to })
          .run();
      }
    }
  }, [editor, dispatchDiffUpdate, projection, rollback]);

  /**
   * ストリーミング中 Escape 時に呼ばれる想定。
   * - status === generating → ストリーム中止（受信済みテキストは保持して diffShown）
   * - status === diffShown → reject と同じ挙動
   */
  const rejectOrAbort = useCallback(() => {
    if (!editor) return;
    const state = useInlineAiStore.getState();
    const projectionKey = projection?.keyRef.current ?? null;
    if (!isSessionOwnedByEditor(editor, projection, projectionKey)) {
      rollback(state.sessionId);
      return;
    }
    const status = state.status;
    if (status === "generating") {
      useInlineAiStore.getState().abortGeneration(DEFAULT_MODEL);
      dispatchDiffUpdate(editor);
    } else {
      reject();
    }
  }, [editor, dispatchDiffUpdate, projection, reject, rollback]);

  const retry = useCallback(async () => {
    const lastCall = lastCallRef.current;
    if (!lastCall || !editor) return;
    const projectionKey = projection?.keyRef.current ?? null;
    const state = useInlineAiStore.getState();
    if (
      lastCall.ownerEditor !== editor ||
      lastCall.projectionKey !== projectionKey ||
      !isSessionOwnedByEditor(editor, projection, projectionKey) ||
      state.projectionKey !== projectionKey
    ) {
      return;
    }
    reject();
    setTimeout(() => {
      if (!isProjectionCurrent(projection, projectionKey)) return;
      const current = useInlineAiStore.getState();
      if (
        current.status !== "idle" ||
        current.activeEditor !== null ||
        current.projectionKey !== null
      ) {
        return;
      }
      void generate(lastCall.command, lastCall.context);
    }, 50);
  }, [editor, generate, projection, reject]);

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
      if (
        (projection && !projection.readyRef.current) ||
        !isProjectionWritable(projection)
      ) {
        return;
      }
      const existingState = useInlineAiStore.getState();
      if (existingState.status !== "idle") {
        existingState.requestAttention();
        return;
      }
      const projectionKey = projection?.keyRef.current ?? null;
      const sessionId = crypto.randomUUID();

      const isReplace = opts.mode === "replace" && opts.originalRange != null;
      const originalRange = isReplace ? opts.originalRange! : null;
      const originalText =
        isReplace && originalRange
          ? editor.state.doc.textBetween(originalRange.from, originalRange.to)
          : "";
      const insertPos = isReplace
        ? null
        : (opts.insertPos ?? editor.state.selection.from);

      const started = useInlineAiStore.getState().startGeneration({
        commandId: "agent-prose",
        mode: isReplace ? "replace" : "insert",
        originalRange,
        originalText,
        insertPos,
        abortController: new AbortController(),
        activeEditor: editor,
        activeEditorGroup,
        projectionKey,
        sessionId,
      });
      if (!started) return;
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
    [
      activeEditorGroup,
      editor,
      dispatchDiffUpdate,
      insertChunkHistoryLess,
      projection,
    ],
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
    rollback,
    getActiveStagingId,
  };
}
