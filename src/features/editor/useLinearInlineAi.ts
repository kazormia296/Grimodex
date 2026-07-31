import { useState, useEffect, useCallback, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import {
  useInlineAiDiff,
  type InlineAiProjectionAuthority,
} from "@/features/editor/inlineAi/useInlineAiDiff";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { buildInlineAiContext } from "@/features/editor/inlineAi/inlineAiContext";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLinearEditorStore } from "./linearEditorStore";

/**
 * リニアモードの 1 ブロック分の Inline AI 配線。
 *
 * 通常モード (EditorPane) は 1 エディタなので generate/accept/toolbar/palette を
 * そのまま 1 セットだけ配線すれば済むが、リニアは 1 シーン 1 エディタで複数
 * ブロックが同時マウントされ、`useInlineAiStore` はグローバル単一である。
 * そのため:
 * - diff プラグインは各エディタへ個別登録 (useInlineAiDiff をブロックごとに呼ぶ)。
 * - セッションは 1 度に 1 つ。生成中 (generating/diffShown) に別ブロックで新規
 *   コマンドを発火させると、後発の startGeneration が store をすげ替え、先発の
 *   遅延 chunk が別エディタへ漏れて本文を壊す — だから進行中は弾く。
 * - 「今の提案の主」を linearEditorStore.inlineAiOwnerSceneId で一意化し、
 *   ツールバーは owner ブロックだけがマウントする (画面に 1 個・keydown も 1 本)。
 * - owner ブロックがストリーミング中にスクロールアウトしてアンマウントされたら
 *   セッションを reset で中止する (破棄済みエディタへの chunk 挿入と、別 remount
 *   へ持ち越される stale な diff 範囲を防ぐ = 本文消失ガード)。
 *
 * @param editor       ブロックのエディタ (DOM/コンテキスト構築用)。
 * @param inlineAiEditor diff プラグインと generate を束ねるエディタ。file-backed
 *   シーンは authorship mark / slash 拡張を持たないため null を渡す (Inline AI 無効)。
 */
export function useLinearInlineAi(params: {
  sceneId: string;
  editor: Editor | null;
  inlineAiEditor: Editor | null;
  projection: InlineAiProjectionAuthority;
  projectionKey: string;
  projectionReady: boolean;
  projectionWritable: boolean;
}) {
  const {
    sceneId,
    editor,
    inlineAiEditor,
    projection,
    projectionKey,
    projectionReady,
    projectionWritable,
  } = params;
  const { generate, accept, rejectOrAbort, retry, rollback } = useInlineAiDiff(
    inlineAiEditor,
    null,
    projection,
  );

  const isOwner = useLinearEditorStore(
    (s) => s.inlineAiOwnerSceneId === sceneId,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteCommand, setPaletteCommand] = useState<InlineAiCommand | null>(
    null,
  );
  const seenProjectionKeyRef = useRef("");

  useEffect(() => {
    const projectionChanged =
      seenProjectionKeyRef.current !== "" &&
      seenProjectionKeyRef.current !== projectionKey;
    seenProjectionKeyRef.current = projectionKey;
    if (!projectionChanged && projectionReady && projectionWritable) return;

    setPaletteOpen(false);
    setPaletteCommand(null);
    const ai = useInlineAiStore.getState();
    if (
      inlineAiEditor &&
      ai.activeEditor === inlineAiEditor &&
      ai.status !== "idle"
    ) {
      rollback(ai.sessionId);
    }
  }, [
    inlineAiEditor,
    projectionKey,
    projectionReady,
    projectionWritable,
    rollback,
  ]);

  // 引数を組み立てて generate を叩く。EditorPane.onSlashCommand と同じ
  // コンテキスト構築 (projectTitle / sceneTitle / 検出 Codex / 選択 or カーソル)。
  const runGenerate = useCallback(
    (command: InlineAiCommand, arg?: string) => {
      if (!inlineAiEditor) return;
      const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
      const projectTitle =
        useWorkspaceStore.getState().activeWorkspaceName ?? "";
      const matchedCodexIds = useCodexHighlightStore.getState().matchedEntryIds;
      const codexEntries = useCodexStore.getState().entries;
      const context = buildInlineAiContext({
        editor: inlineAiEditor,
        projectTitle,
        sceneTitle: node?.title ?? "",
        matchedCodexIds,
        codexEntries,
        arg,
      });
      generate(command, context);
    },
    [inlineAiEditor, sceneId, generate],
  );

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const submitPalette = useCallback(
    (command: InlineAiCommand, prompt: string) => {
      setPaletteOpen(false);
      useLinearEditorStore.getState().setInlineAiOwner(sceneId);
      runGenerate(command, prompt || undefined);
    },
    [runGenerate, sceneId],
  );

  // SlashCommandExtension が各エディタの view.dom へ dispatch する
  // inlineai:slash-command を受けて実行する (EditorPane と同経路)。
  useEffect(() => {
    if (!editor) return;
    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      return;
    }
    function onSlashCommand(e: Event) {
      const cmd = (e as CustomEvent).detail?.command as
        | InlineAiCommand
        | undefined;
      if (!cmd) return;
      // 構造挿入 (sceneBeat) は AI パイプライン不要。
      if (cmd.kind === "insert-node") {
        if (cmd.id === "sceneBeat") {
          editor!.chain().focus().insertSceneBeat().run();
        }
        return;
      }
      // file-backed シーンは Inline AI 非対象 (slash 拡張も無いので通常届かない)。
      if (!inlineAiEditor) return;
      // UI を伴う進行中セッションを別の startGeneration で置き換えない。
      // error も部分生成を含み得るため、明示的な Reject/rollback を要求する。
      const status = useInlineAiStore.getState().status;
      if (status !== "idle") {
        const linState = useLinearEditorStore.getState();
        const owner = linState.inlineAiOwnerSceneId;
        const ownerMounted =
          owner != null && linState.editorsById[owner] != null;
        if (ownerMounted) {
          // 解決可能なツールバーが画面に出ている → 確定/取消を促して弾く
          // (別エディタへ chunk が漏れる二重セッションを防ぐ)。
          toast.info(i18next.t("inlineAi.sessionBusy"));
          return;
        }
        const current = useInlineAiStore.getState();
        if (current.activeEditor === inlineAiEditor) {
          rollback(current.sessionId);
        } else {
          toast.info(i18next.t("inlineAi.sessionBusy"));
          return;
        }
      }
      useLinearEditorStore.getState().setInlineAiOwner(sceneId);
      if (cmd.needsArg) {
        setPaletteCommand(cmd);
        setPaletteOpen(true);
        return;
      }
      runGenerate(cmd);
    }
    dom.addEventListener("inlineai:slash-command", onSlashCommand);
    return () => {
      dom.removeEventListener("inlineai:slash-command", onSlashCommand);
    };
  }, [editor, inlineAiEditor, rollback, sceneId, runGenerate]);

  // owner ブロックが未 accept のセッションを抱えたままアンマウントされたら
  // セッションを畳む (reset = AbortController abort + store idle)。挿入済みの
  // 未 accept テキストの「焼き込み」は LinearSceneBlock.onUpdate の autosave
  // ゲート (生成中・diff 表示中はこのエディタの編集を schedule しない) が既に
  // 防いでいるため、ここで editor を触って削除する必要はない。reset は editor
  // に触れない (破棄順に依存しない) ので、unmount で editor が先に destroy され
  // ていても安全。status を idle にすることで in-flight stream の次 chunk も break。
  useEffect(() => {
    return () => {
      if (
        useLinearEditorStore.getState().inlineAiOwnerSceneId === sceneId &&
        useInlineAiStore.getState().status !== "idle" &&
        useInlineAiStore.getState().activeEditor === inlineAiEditor
      ) {
        const ai = useInlineAiStore.getState();
        rollback(ai.sessionId);
      }
    };
  }, [inlineAiEditor, rollback, sceneId]);

  return {
    isOwner,
    paletteOpen,
    paletteCommand,
    closePalette,
    submitPalette,
    onAccept: accept,
    onReject: rejectOrAbort,
    onRetry: retry,
    rollback,
  };
}
