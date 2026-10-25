import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { getLoadedProjectId } from "@/application/project/currentProjectAuthority";
import {
  getCurrentWorkspaceIdentity,
  subscribeCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { useChatStore } from "../chatStore";
import { resolveScopeSessionKey } from "../chatScope";
import { CHAT_COMMANDS } from "../extensions/chatCommands";
import { getChatInputDraftPurges } from "../chatInputDraftPurge";
import {
  chatInputDraftKey,
  hasChatInputDraft,
  isChatInputDraftPurged,
  readChatInputDraft,
  removeChatInputDraft,
  writeChatInputDraft,
  type ChatInputDraftTarget,
  type ChatInputDraftWriteResult,
} from "../chatInputDraftStorage";

/** 入力が止まってから保存するまでの待ち（ms）。 */
export const CHAT_INPUT_DRAFT_DEBOUNCE_MS = 1000;

interface DraftBinding {
  key: string;
  target: ChatInputDraftTarget;
  /** bind した時点の削除記録の長さ。これより後の削除と照合する。 */
  purgeIndex: number;
  /** bind の後にユーザーが入力したか（復元しただけの内容と区別する）。 */
  typed: boolean;
  /** 未保存の変化があるか。 */
  pending: boolean;
  /** 入力欄の今の内容が、この鍵に保存済みか（"saved"）を表す直近の結果。 */
  lastResult: ChatInputDraftWriteResult | "restored" | null;
  /** 送信のために作られた session へ、新しいチャットの内容を引き継いだ bind か。 */
  carriedFromSend: boolean;
  /**
   * 保存できない内容（上限超過など）を、保存済みの下書きがある鍵へ持ち越した bind か。
   * 上限超過のときに移り先の保存を消さない。
   */
  protectStored: boolean;
}

/** 送信の直前の保存先と、そのときに既にあった session の id。 */
export interface ChatInputDraftSendCapture {
  key: string;
  sessionIds: ReadonlySet<string>;
}

export interface ChatInputDraftController {
  /** 送信の直前に、いまの保存先と既存の session を捕まえる。 */
  captureForSend: () => ChatInputDraftSendCapture | null;
  /**
   * 送信が受け付けられた後、捕まえた保存先の下書きを消す。今の保存先も、それが捕まえた
   * 保存先か送信のために作られた session（引き継ぎ先）のときだけ消す。入力欄を空にして
   * よい（入力欄が送った内容のままである）とき true。
   */
  discardAfterSend: (capture: ChatInputDraftSendCapture | null) => boolean;
  /** 入力欄を空にした後（A/B の採用など）、今の保存先の下書きを消す。 */
  discardCurrent: () => void;
  /** editor の update 以外の変化（保留中の slash command）を保存の予約に載せる。 */
  scheduleSave: () => void;
}

function isDraftDocEmpty(doc: ProseMirrorNode): boolean {
  if (doc.textContent.trim() !== "") return false;
  let hasMention = false;
  doc.descendants((node) => {
    if (node.type.name === "mention") hasMention = true;
    return !hasMention;
  });
  return !hasMention;
}

/** 送った・空にした内容の保存を消し、bind を初期の状態に戻す。 */
function resetBinding(binding: DraftBinding): void {
  removeChatInputDraft(binding.key);
  binding.pending = false;
  binding.typed = false;
  binding.carriedFromSend = false;
  binding.protectStored = false;
  binding.lastResult = "removed";
}

function isKnownCommand(id: string | null): id is string {
  return id !== null && CHAT_COMMANDS.some((command) => command.id === id);
}

/**
 * チャット入力の書きかけを project／session ごとに保存し、再起動・再 mount 後に戻す。
 *
 * - 入力の後 1 秒の debounce、blur／visibilitychange（hidden）／pagehide／beforeunload／
 *   unmount で flush する。空になったら保存を消す。
 * - 復元は入力欄が空のときだけ。先に打ち始めた内容は上書きしない。
 * - 別の session へ移ったら、今の内容は元の session に残して入力欄を入れ替える。
 *   新しいチャット（session 未作成）で打った内容は、送信のために作られた session へ引き継ぐ。
 * - AI の文脈（`registerInputDraftProvider`）・監査・ログには関与しない。
 */
export function useChatInputDraftPersistence(
  editor: Editor | null,
  pendingCommandRef: MutableRefObject<string | null>,
  /** 送信の受付中か。送信のために作られた session へだけ、新しいチャットの内容を引き継ぐ。 */
  submittingRef: MutableRefObject<boolean>,
): ChatInputDraftController {
  const activeProjectId = useChatStore((s) => s.activeProjectId);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const chatScope = useChatStore((s) => s.chatScope);
  const activeSceneId = useChatStore((s) => s.activeSceneId);
  const scopeAnchorId = useChatStore((s) => s.scopeAnchorId);
  const loading = useChatStore(
    (s) => s.isLoadingSessions || s.isLoadingMessages,
  );
  const workspacePath = useSyncExternalStore(
    subscribeCurrentWorkspaceIdentity,
    () => getCurrentWorkspaceIdentity()?.path ?? null,
  );

  // 読込み中と、workspace の identity が無い間（切替・backup の復元の途中）は保存先を
  // 決めない（前の保存先のまま待つ）。
  const projectId = activeProjectId ?? getLoadedProjectId();
  const target = useMemo<ChatInputDraftTarget | null>(() => {
    if (loading || !projectId || workspacePath === null) return null;
    const scopeKey = resolveScopeSessionKey(
      chatScope,
      activeSceneId,
      scopeAnchorId,
    );
    return {
      workspacePath,
      projectId,
      sessionId: activeSessionId,
      scopeSlot: [
        chatScope,
        scopeKey.nodeId ?? "",
        scopeKey.codexAnchorId ?? "",
        scopeKey.snippetAnchorId ?? "",
      ].join(":"),
    };
  }, [
    loading,
    projectId,
    workspacePath,
    activeSessionId,
    chatScope,
    activeSceneId,
    scopeAnchorId,
  ]);
  const targetKey = target ? chatInputDraftKey(target) : null;

  const bindingRef = useRef<DraftBinding | null>(null);
  const latestDocRef = useRef<ProseMirrorNode | null>(null);
  const timerRef = useRef<number | null>(null);
  const sendCaptureRef = useRef<ChatInputDraftSendCapture | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const save = useCallback((): void => {
    clearTimer();
    const binding = bindingRef.current;
    const doc = latestDocRef.current;
    if (!binding || !doc) return;
    binding.pending = false;
    const content = isDraftDocEmpty(doc)
      ? null
      : { doc: doc.toJSON(), commandId: pendingCommandRef.current };
    const result = writeChatInputDraft(
      binding.key,
      binding.target,
      binding.purgeIndex,
      content,
      Date.now(),
      binding.protectStored,
    );
    if (result === "purged") {
      // 履歴の全消去で消えた分は、すぐには書き戻さない。新しいチャット（n:）の入力欄に
      // 残った文は、次の flush（blur・別の会話へ移る前など）で保存する。全消去で session は
      // すべて消えるので、s: の鍵へは書き戻さない（移り先へ持ち越す）。session／project の
      // 削除は恒久の記録なので、引き続き書かない。
      binding.purgeIndex = getChatInputDraftPurges().length;
      binding.pending =
        content !== null &&
        binding.target.sessionId === null &&
        !isChatInputDraftPurged(binding.target, binding.purgeIndex);
    }
    binding.lastResult = result;
  }, [clearTimer, pendingCommandRef]);

  const flush = useCallback(() => {
    if (bindingRef.current?.pending) save();
  }, [save]);

  const scheduleSave = useCallback(() => {
    const binding = bindingRef.current;
    if (!binding) return;
    binding.pending = true;
    clearTimer();
    timerRef.current = window.setTimeout(save, CHAT_INPUT_DRAFT_DEBOUNCE_MS);
  }, [clearTimer, save]);

  // 入力の変化と flush の契機。
  useEffect(() => {
    if (!editor) return;
    const onUpdate = ({ editor: updated }: { editor: Editor }) => {
      latestDocRef.current = updated.state.doc;
      const binding = bindingRef.current;
      if (!binding) return;
      binding.typed = true;
      // 持ち越した内容を一度空にしたら、以後は移り先の入力として普通に扱う。
      if (isDraftDocEmpty(updated.state.doc)) binding.protectStored = false;
      scheduleSave();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    editor.on("update", onUpdate);
    editor.on("blur", flush);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      flush();
      clearTimer();
      editor.off("update", onUpdate);
      editor.off("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [editor, flush, clearTimer, scheduleSave]);

  // 保存先の bind と、保存先が変わったときの入れ替え・復元。
  useEffect(() => {
    if (!isEditorViewReady(editor) || !target || !targetKey) return;
    const previous = bindingRef.current;
    if (previous?.key === targetKey) return;
    // 前の保存先へ flush する。保存の後に削除があったなら一度照合し、履歴の全消去で
    // 消えただけなら入力欄の内容を保存し直す（入れ替えで入力欄から消すため）。
    if (
      previous &&
      (previous.pending ||
        isChatInputDraftPurged(previous.target, previous.purgeIndex))
    ) {
      save();
    }
    if (previous?.pending) save();

    const next: DraftBinding = {
      key: targetKey,
      target,
      purgeIndex: getChatInputDraftPurges().length,
      typed: false,
      pending: false,
      lastResult: null,
      carriedFromSend: false,
      protectStored: false,
    };
    const doc = editor.state.doc;
    latestDocRef.current = doc;
    if (!isDraftDocEmpty(doc)) {
      // 送信の直前に新しいチャットだった保存先から、そのときに無かった session
      // （送信のために作られた session）へ移ったときだけ引き継ぐ。既存の session を
      // 選んだときは引き継がない。
      const sendCapture = sendCaptureRef.current;
      const carriesToCreatedSession =
        previous !== null &&
        submittingRef.current &&
        sendCapture !== null &&
        sendCapture.key === previous.key &&
        previous.target.sessionId === null &&
        target.sessionId !== null &&
        !sendCapture.sessionIds.has(target.sessionId) &&
        previous.target.projectId === target.projectId &&
        previous.target.workspacePath === target.workspacePath;
      // 履歴の全消去で消えた session（s:）の内容は、どこにも残っていないので持ち越す。
      // session の削除（恒久の記録）なら、削除した会話と一緒に入力欄からも消す。
      const clearedSession =
        previous !== null &&
        previous.lastResult === "purged" &&
        previous.target.sessionId !== null &&
        !isChatInputDraftPurged(previous.target, Number.MAX_SAFE_INTEGER);
      const storedUnderPrevious =
        previous !== null &&
        !clearedSession &&
        (previous.lastResult === "saved" ||
          previous.lastResult === "restored" ||
          previous.lastResult === "purged");
      if (carriesToCreatedSession && previous) {
        removeChatInputDraft(previous.key);
        bindingRef.current = { ...next, typed: true, carriedFromSend: true };
        scheduleSave();
        return;
      }
      if (!storedUnderPrevious) {
        // 前の保存先に残せていない内容（復元前の入力・pre-fill・上限超過など）は
        // 入力欄から消さずに持ち越す。別の会話から持ち越すときに移り先に保存済みの
        // 下書きがあるなら、それを上書きする・消す書込みは予約しない（次の入力からは
        // 移り先の内容として扱う）。最初の bind の前に打った内容は、この会話の入力なので保存する。
        const targetHasDraft =
          previous !== null && hasChatInputDraft(targetKey);
        bindingRef.current = {
          ...next,
          typed: true,
          protectStored: targetHasDraft,
        };
        if (!targetHasDraft) scheduleSave();
        return;
      }
      // 別の会話へ移った。今の内容は前の保存先に残っている（削除済みなら消えている）ので、
      // 入力欄を空にしてから移り先の下書きを入れる。
      editor.commands.setContent("", { emitUpdate: false });
      pendingCommandRef.current = null;
      latestDocRef.current = editor.state.doc;
    }
    bindingRef.current = next;

    const draft = readChatInputDraft(targetKey);
    if (!draft) return;
    try {
      // schema に合わない保存値は捨てる（TipTap の警告に本文を出させない）。
      editor.schema.nodeFromJSON(draft.doc).check();
    } catch {
      removeChatInputDraft(targetKey);
      return;
    }
    editor.commands.setContent(draft.doc, { emitUpdate: false });
    pendingCommandRef.current = isKnownCommand(draft.commandId)
      ? draft.commandId
      : null;
    latestDocRef.current = editor.state.doc;
    next.lastResult = "restored";
  }, [
    editor,
    target,
    targetKey,
    save,
    scheduleSave,
    pendingCommandRef,
    submittingRef,
  ]);

  const captureForSend = useCallback((): ChatInputDraftSendCapture | null => {
    const binding = bindingRef.current;
    const capture = binding
      ? {
          key: binding.key,
          sessionIds: new Set(
            useChatStore.getState().sessions.map((session) => session.id),
          ),
        }
      : null;
    sendCaptureRef.current = capture;
    return capture;
  }, []);

  const discardAfterSend = useCallback(
    (capture: ChatInputDraftSendCapture | null): boolean => {
      sendCaptureRef.current = null;
      const binding = bindingRef.current;
      if (!capture) return true;
      removeChatInputDraft(capture.key);
      const ownsComposer =
        binding !== null &&
        (binding.key === capture.key || binding.carriedFromSend);
      if (ownsComposer) {
        clearTimer();
        resetBinding(binding);
      }
      return ownsComposer;
    },
    [clearTimer],
  );

  const discardCurrent = useCallback(() => {
    clearTimer();
    const binding = bindingRef.current;
    if (binding) resetBinding(binding);
  }, [clearTimer]);

  return useMemo(
    () => ({ captureForSend, discardAfterSend, discardCurrent, scheduleSave }),
    [captureForSend, discardAfterSend, discardCurrent, scheduleSave],
  );
}
