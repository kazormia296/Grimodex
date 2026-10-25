// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import { getChatInputExtensions } from "../extensions/chatInputExtensions";
import { useEditorViewReady } from "@/features/editor/useEditorViewReady";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { useChatStore } from "../chatStore";
import {
  purgeChatInputDrafts,
  resetChatInputDraftPurgesForTests,
} from "../chatInputDraftPurge";
import {
  CHAT_INPUT_DRAFT_MAX_BYTES,
  CHAT_INPUT_DRAFT_MAX_ENTRIES,
  CHAT_INPUT_DRAFT_MAX_TOTAL_BYTES,
  chatInputDraftKey,
  readChatInputDraft,
  writeChatInputDraft,
  type ChatInputDraftTarget,
} from "../chatInputDraftStorage";
import {
  CHAT_INPUT_DRAFT_DEBOUNCE_MS,
  useChatInputDraftPersistence,
  type ChatInputDraftController,
} from "./useChatInputDraftPersistence";

interface HarnessHandle {
  editor: Editor | null;
  controller: ChatInputDraftController;
  pendingCommandRef: MutableRefObject<string | null>;
  submittingRef: MutableRefObject<boolean>;
}

function Harness({ handle }: { handle: { current: HarnessHandle | null } }) {
  const pendingCommandRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const editor = useEditor({
    extensions: getChatInputExtensions({
      placeholder: "",
      onSubmit: async () => false,
      onStop: () => {},
      setMentionPopup: () => {},
    }),
  });
  const ready = useEditorViewReady(editor);
  const mounted = ready && isEditorViewReady(editor) ? editor : null;
  const controller = useChatInputDraftPersistence(
    mounted,
    pendingCommandRef,
    submittingRef,
  );
  handle.current = {
    editor: mounted,
    controller,
    pendingCommandRef,
    submittingRef,
  };
  return <EditorContent editor={editor} />;
}

function mountInput() {
  const handle: { current: HarnessHandle | null } = { current: null };
  const view = render(<Harness handle={handle} />);
  const editor = () => {
    const current = handle.current?.editor;
    if (!current) throw new Error("editor is not mounted");
    return current;
  };
  return { handle, editor, unmount: view.unmount };
}

const WORKSPACE = "/home/user/ws-a";

function target(
  sessionId: string | null,
  projectId = "p1",
): ChatInputDraftTarget {
  return {
    workspacePath: WORKSPACE,
    projectId,
    sessionId,
    scopeSlot: "project:::",
  };
}

function setChat(state: {
  projectId?: string | null;
  sessionId?: string | null;
  loading?: boolean;
  /** 既存の session の一覧（id だけを使う）。 */
  sessionIds?: string[];
  /** scene scope にするときの scene id（省くと project scope）。 */
  sceneId?: string;
}) {
  act(() => {
    useChatStore.setState({
      ...(state.sessionIds
        ? { sessions: state.sessionIds.map((id) => ({ id })) as never }
        : {}),
      activeProjectId: state.projectId === undefined ? "p1" : state.projectId,
      activeSessionId: state.sessionId ?? null,
      chatScope: state.sceneId ? "scene" : "project",
      activeSceneId: state.sceneId ?? "",
      scopeAnchorId: null,
      isLoadingSessions: state.loading ?? false,
      isLoadingMessages: false,
    });
  });
}

function typeText(editor: Editor, text: string) {
  act(() => {
    // 入力欄の末尾に足す（復元後の選択位置に依らない）。
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, text);
  });
}

function settleDebounce() {
  act(() => {
    vi.advanceTimersByTime(CHAT_INPUT_DRAFT_DEBOUNCE_MS);
  });
}

function storedText(sessionId: string | null, projectId = "p1"): string | null {
  return storedTextAt(target(sessionId, projectId));
}

function storedTextAt(draftTarget: ChatInputDraftTarget): string | null {
  const draft = readChatInputDraft(chatInputDraftKey(draftTarget));
  if (!draft) return null;
  const parts: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.text) parts.push(node.text);
    if (node.type === "mention") parts.push(`@${String(node.attrs?.label)}`);
    node.content?.forEach(walk);
  };
  walk(draft.doc);
  return parts.join("");
}

function seedAt(draftTarget: ChatInputDraftTarget, text: string) {
  expect(
    writeChatInputDraft(chatInputDraftKey(draftTarget), draftTarget, 0, {
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      commandId: null,
    }),
  ).toBe("saved");
}

function seed(
  sessionId: string | null,
  text: string,
  commandId: string | null = null,
  projectId = "p1",
) {
  const key = chatInputDraftKey(target(sessionId, projectId));
  expect(
    writeChatInputDraft(key, target(sessionId, projectId), 0, {
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      commandId,
    }),
  ).toBe("saved");
}

describe("チャット入力の書きかけの保存と復元", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    // 削除の記録は module の memory に残るので、test ごとに空にする。
    resetChatInputDraftPurgesForTests();
    setCurrentWorkspaceIdentity({ path: WORKSPACE, openRevision: 1 });
    setChat({ sessionId: "s1" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setCurrentWorkspaceIdentity(null);
  });

  it("入力の 1 秒後に保存し、再 mount で復元する", () => {
    const first = mountInput();
    typeText(first.editor(), "書きかけの質問");
    act(() => {
      vi.advanceTimersByTime(CHAT_INPUT_DRAFT_DEBOUNCE_MS - 1);
    });
    expect(storedText("s1")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(storedText("s1")).toBe("書きかけの質問");
    first.unmount();

    const second = mountInput();
    expect(second.editor().getText()).toBe("書きかけの質問");
  });

  it("再起動の模擬: storage を残して store を作り直しても復元する", () => {
    const first = mountInput();
    typeText(first.editor(), "落ちる前の文");
    settleDebounce();
    first.unmount();

    act(() => {
      useChatStore.setState(useChatStore.getInitialState(), true);
    });
    setCurrentWorkspaceIdentity({ path: WORKSPACE, openRevision: 2 });
    // 起動直後は session の読込み中。読込みが終わってから復元する。
    setChat({ sessionId: null, loading: true });
    const second = mountInput();
    expect(second.editor().getText()).toBe("");
    setChat({ sessionId: "s1" });
    expect(second.editor().getText()).toBe("落ちる前の文");
  });

  it("メンション chip を node のまま復元する", () => {
    const first = mountInput();
    act(() => {
      first.editor().commands.insertContent([
        {
          type: "mention",
          attrs: {
            id: "scene-1",
            label: "第一章",
            kind: "scene",
            role: "mentioned",
          },
        },
        { type: "text", text: " の続き" },
      ]);
    });
    settleDebounce();
    first.unmount();

    const second = mountInput();
    const mentions: Array<Record<string, unknown>> = [];
    second.editor().state.doc.descendants((node) => {
      if (node.type.name === "mention") mentions.push(node.attrs);
    });
    expect(mentions).toEqual([
      expect.objectContaining({
        id: "scene-1",
        label: "第一章",
        kind: "scene",
      }),
    ]);
  });

  it("保留中の slash command を保存・復元し、未知の id は捨てる", () => {
    const first = mountInput();
    typeText(first.editor(), "案を出して");
    first.handle.current!.pendingCommandRef.current = "brainstorm";
    act(() => first.handle.current!.controller.scheduleSave());
    settleDebounce();
    first.unmount();
    const second = mountInput();
    expect(second.handle.current!.pendingCommandRef.current).toBe("brainstorm");
    second.unmount();

    seed("s1", "古い版の command", "no-such-command");
    const third = mountInput();
    expect(third.editor().getText()).toBe("古い版の command");
    expect(third.handle.current!.pendingCommandRef.current).toBeNull();
  });

  it("送信の受付で消え、空にしても消える", () => {
    const input = mountInput();
    typeText(input.editor(), "送る文");
    settleDebounce();
    expect(storedText("s1")).toBe("送る文");
    act(() => {
      const controller = input.handle.current!.controller;
      controller.discardAfterSend(controller.captureForSend());
    });
    expect(storedText("s1")).toBeNull();
    // ChatInput は受付の後に入力欄を空にする。空の update でも保存は戻らない。
    act(() => {
      input.editor().commands.clearContent(true);
    });
    settleDebounce();
    expect(storedText("s1")).toBeNull();

    typeText(input.editor(), "次の文");
    settleDebounce();
    expect(storedText("s1")).toBe("次の文");
    act(() => {
      input.editor().commands.clearContent(true);
    });
    settleDebounce();
    expect(storedText("s1")).toBeNull();
  });

  it("上限を超えたら保存せず、前の保存も残さない（切り詰めない）", () => {
    const input = mountInput();
    typeText(input.editor(), "短い文");
    settleDebounce();
    expect(storedText("s1")).toBe("短い文");
    typeText(input.editor(), "あ".repeat(CHAT_INPUT_DRAFT_MAX_BYTES / 3 + 10));
    settleDebounce();
    expect(localStorage.getItem(chatInputDraftKey(target("s1")))).toBeNull();
  });

  it("別の session へ移ると入れ替わり、内容を取り違えない", () => {
    seed("s2", "s2 の下書き");
    const input = mountInput();
    typeText(input.editor(), "s1 の下書き");
    // debounce 前に移っても、元の session へ flush してから入れ替える。
    setChat({ sessionId: "s2" });
    expect(input.editor().getText()).toBe("s2 の下書き");
    expect(storedText("s1")).toBe("s1 の下書き");

    typeText(input.editor(), "（追記）");
    settleDebounce();
    expect(storedText("s2")).toBe("s2 の下書き（追記）");
    expect(storedText("s1")).toBe("s1 の下書き");

    setChat({ sessionId: "s1" });
    expect(input.editor().getText()).toBe("s1 の下書き");

    // 別 project の同じ session id とは混ざらない（別 workspace は purge の test で見る）。
    setChat({ projectId: "p2", sessionId: "s1" });
    expect(input.editor().getText()).toBe("");
  });

  it("先に打ち始めた内容は、後から決まった保存先の下書きで上書きしない", () => {
    seed("s1", "保存済みの古い文");
    setChat({ sessionId: null, projectId: null });
    const input = mountInput();
    typeText(input.editor(), "先に打った文");
    setChat({ sessionId: "s1" });
    expect(input.editor().getText()).toBe("先に打った文");
    settleDebounce();
    expect(storedText("s1")).toBe("先に打った文");
  });

  it("新しいチャットの内容は、送信で作られた session へ引き継ぐ", () => {
    setChat({ sessionId: null });
    const input = mountInput();
    typeText(input.editor(), "最初の質問");
    settleDebounce();
    expect(storedText(null)).toBe("最初の質問");

    input.handle.current!.submittingRef.current = true;
    const captured = input.handle.current!.controller.captureForSend();
    setChat({ sessionId: "created" });
    expect(input.editor().getText()).toBe("最初の質問");
    expect(storedText(null)).toBeNull();
    settleDebounce();
    expect(storedText("created")).toBe("最初の質問");

    act(() => input.handle.current!.controller.discardAfterSend(captured));
    input.handle.current!.submittingRef.current = false;
    expect(storedText("created")).toBeNull();
  });

  it("新しいチャットから既存の session を選んでも、内容を持ち込まない", () => {
    seed("s1", "s1 の下書き");
    setChat({ sessionId: null });
    const input = mountInput();
    typeText(input.editor(), "新しいチャットの文");
    setChat({ sessionId: "s1" });
    expect(input.editor().getText()).toBe("s1 の下書き");
    expect(storedText(null)).toBe("新しいチャットの文");
  });

  it("blur と visibilitychange（hidden）で debounce を待たずに保存する", () => {
    const input = mountInput();
    typeText(input.editor(), "blur 前");
    act(() => {
      input.editor().emit("blur", {
        editor: input.editor(),
        event: new FocusEvent("blur"),
        transaction: input.editor().state.tr,
      });
    });
    expect(storedText("s1")).toBe("blur 前");

    typeText(input.editor(), "・隠す前");
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockRestore();
    expect(storedText("s1")).toBe("blur 前・隠す前");

    typeText(input.editor(), "・閉じる前");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(storedText("s1")).toBe("blur 前・隠す前・閉じる前");
  });

  it("壊れた保存値・別の鍵の値・schema に合わない値は復元せずに消す", () => {
    const key = chatInputDraftKey(target("s1"));
    for (const raw of [
      "{not json",
      JSON.stringify({
        v: 1,
        key: "other",
        updatedAt: 1,
        doc: { type: "doc" },
        commandId: null,
      }),
      JSON.stringify({
        v: 1,
        key,
        updatedAt: 1,
        doc: { type: "doc", content: [{ type: "no-such-node" }] },
        commandId: null,
      }),
    ]) {
      localStorage.setItem(key, raw);
      const input = mountInput();
      expect(input.editor().getText()).toBe("");
      expect(localStorage.getItem(key)).toBeNull();
      input.unmount();
    }
  });

  it("session の削除で消え、debounce 中の分も書き戻さない", () => {
    setChat({ sessionId: "s-deleted" });
    const input = mountInput();
    typeText(input.editor(), "消す session の文");
    settleDebounce();
    expect(storedText("s-deleted")).toBe("消す session の文");
    typeText(input.editor(), "（未保存）");
    purgeChatInputDrafts(WORKSPACE, "p1", "s-deleted");
    expect(storedText("s-deleted")).toBeNull();
    settleDebounce();
    expect(storedText("s-deleted")).toBeNull();
    // 削除で active session が外れたら、入力欄の内容も削除済みの会話と一緒に消える。
    setChat({ sessionId: null });
    expect(input.editor().getText()).toBe("");
    expect(storedText(null)).toBeNull();
  });

  it("project の削除と履歴の全消去で消える。全消去の後の入力は保存する", () => {
    const project = "p-deleted";
    seed("s2", "別 session の文", null, project);
    seed(null, "新しいチャットの文", null, project);
    seed("s1", "p1 の文");
    setChat({ projectId: project, sessionId: null });
    const input = mountInput();
    expect(input.editor().getText()).toBe("新しいチャットの文");
    purgeChatInputDrafts(WORKSPACE, project);
    expect(storedText("s2", project)).toBeNull();
    expect(storedText(null, project)).toBeNull();
    expect(storedText("s1")).toBe("p1 の文");
    typeText(input.editor(), "・続き");
    settleDebounce();
    expect(storedText(null, project)).toBeNull();
    typeText(input.editor(), "・さらに");
    settleDebounce();
    expect(storedText(null, project)).toBe("新しいチャットの文・続き・さらに");

    purgeChatInputDrafts(WORKSPACE, project, null, true);
    expect(storedText(null, project)).toBeNull();
    typeText(input.editor(), "・削除後");
    settleDebounce();
    expect(storedText(null, project)).toBeNull();
  });

  it("保存数の上限を超えたら、更新の古いものから消す", () => {
    for (let i = 0; i < CHAT_INPUT_DRAFT_MAX_ENTRIES + 5; i++) {
      const sessionTarget = target(`old-${i}`);
      writeChatInputDraft(
        chatInputDraftKey(sessionTarget),
        sessionTarget,
        0,
        { doc: { type: "doc", content: [] }, commandId: null },
        i,
      );
    }
    const keys = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.key(index) ?? "",
    ).filter((key) => key.startsWith("gdx.chatDraft.v1|"));
    expect(keys).toHaveLength(CHAT_INPUT_DRAFT_MAX_ENTRIES);
    expect(storedText("old-0")).toBeNull();
    expect(
      readChatInputDraft(chatInputDraftKey(target("old-54"))),
    ).not.toBeNull();
  });

  it("鍵に workspace の path をそのまま残さない", () => {
    const key = chatInputDraftKey(target("s1"));
    expect(key).not.toContain("ws-a");
    expect(key.startsWith("gdx.chatDraft.v1|")).toBe(true);
  });
});

describe("レビューで見つかったデータ喪失の再現", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    // 削除の記録は module の memory に残るので、test ごとに空にする。
    resetChatInputDraftPurgesForTests();
    setCurrentWorkspaceIdentity({ path: WORKSPACE, openRevision: 1 });
    setChat({ sessionId: "s1", sessionIds: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setCurrentWorkspaceIdentity(null);
  });

  it("上限超過で保存できない内容を持ち越しても、移り先の保存済み下書きを消さない", () => {
    seed("s2", "s2 の下書き");
    const input = mountInput();
    typeText(input.editor(), "あ".repeat(CHAT_INPUT_DRAFT_MAX_BYTES / 3 + 10));
    settleDebounce();
    expect(storedText("s1")).toBeNull();
    setChat({ sessionId: "s2" });
    // 保存できていない内容は入力欄から消さない。
    expect(input.editor().getText().length).toBeGreaterThan(1000);
    settleDebounce();
    expect(storedText("s2")).toBe("s2 の下書き");
  });

  it("purge は workspace を区別する（同じ projectId の別 DB の下書きを消さない）", () => {
    const otherWorkspace = "/home/user/ws-b";
    const inB: ChatInputDraftTarget = {
      ...target("s1", "default-project"),
      workspacePath: otherWorkspace,
    };
    const keyB = chatInputDraftKey(inB);
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }],
    };
    expect(writeChatInputDraft(keyB, inB, 0, { doc, commandId: null })).toBe(
      "saved",
    );
    // workspace A で履歴を全消去しても、B の同じ id の project の下書きは残る。
    purgeChatInputDrafts(WORKSPACE, "default-project");
    expect(readChatInputDraft(keyB)).not.toBeNull();
    // A で project を削除しても、B の同じ id の project への保存は止まらない。
    purgeChatInputDrafts(WORKSPACE, "default-project", null, true);
    expect(readChatInputDraft(keyB)).not.toBeNull();
    expect(writeChatInputDraft(keyB, inB, 0, { doc, commandId: null })).toBe(
      "saved",
    );
    // B 自身の削除では消える。
    purgeChatInputDrafts(otherWorkspace, "default-project", "s1");
    expect(readChatInputDraft(keyB)).toBeNull();
  });

  it("送信の準備中に既存の session を選んでも、新しいチャットの内容を持ち込まない", () => {
    seed("x", "x の下書き");
    setChat({ sessionId: null, sessionIds: ["x"] });
    const input = mountInput();
    typeText(input.editor(), "新しいチャットの文");
    input.handle.current!.submittingRef.current = true;
    const captured = input.handle.current!.controller.captureForSend();
    setChat({ sessionId: "x" });
    expect(input.editor().getText()).toBe("x の下書き");
    expect(storedText(null)).toBe("新しいチャットの文");
    expect(storedText("x")).toBe("x の下書き");
    // 受付後の後始末でも、引き継ぎ先でない今の session の下書きは消さない。
    let clearsComposer = true;
    act(() => {
      clearsComposer =
        input.handle.current!.controller.discardAfterSend(captured);
    });
    input.handle.current!.submittingRef.current = false;
    expect(clearsComposer).toBe(false);
    expect(storedText("x")).toBe("x の下書き");
    expect(storedText(null)).toBeNull();
  });

  it("履歴の全消去の後も、入力欄に残った文は別 session へ移る前に保存する", () => {
    setChat({ sessionId: null });
    const input = mountInput();
    typeText(input.editor(), "残す文");
    settleDebounce();
    purgeChatInputDrafts(WORKSPACE, "p1");
    expect(storedText(null)).toBeNull();
    setChat({ sessionId: "s1" });
    expect(input.editor().getText()).toBe("");
    expect(storedText(null)).toBe("残す文");
  });
});

describe("再レビューで見つかった問題の再現", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetChatInputDraftPurgesForTests();
    setCurrentWorkspaceIdentity({ path: WORKSPACE, openRevision: 1 });
    setChat({ sessionId: "sx", sessionIds: ["sx"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setCurrentWorkspaceIdentity(null);
  });

  it("active な session で履歴を全消去したら、文は新しいチャットへ残り、消した session へ書き戻さない", () => {
    const input = mountInput();
    typeText(input.editor(), "全消去の時に打っていた文");
    settleDebounce();
    expect(storedText("sx")).toBe("全消去の時に打っていた文");
    // store の clearProjectChatHistory と同じ順：purge の後に session の状態を空にする。
    purgeChatInputDrafts(WORKSPACE, "p1");
    setChat({ sessionId: null, sessionIds: [] });
    expect(input.editor().getText()).toBe("全消去の時に打っていた文");
    expect(storedText("sx")).toBeNull();
    settleDebounce();
    expect(storedText("sx")).toBeNull();
    expect(storedText(null)).toBe("全消去の時に打っていた文");
  });

  it("debounce 中に履歴を全消去しても、消した session へ書き戻さない", () => {
    const input = mountInput();
    typeText(input.editor(), "保存前の文");
    purgeChatInputDrafts(WORKSPACE, "p1");
    setChat({ sessionId: null, sessionIds: [] });
    settleDebounce();
    expect(storedText("sx")).toBeNull();
    expect(input.editor().getText()).toBe("保存前の文");
    expect(storedText(null)).toBe("保存前の文");
  });

  it("workspace の identity が無い間は前の保存先のまま待ち、入力欄を空にしない", () => {
    const input = mountInput();
    typeText(input.editor(), "切替前の文");
    settleDebounce();
    act(() => setCurrentWorkspaceIdentity(null));
    expect(input.editor().getText()).toBe("切替前の文");
    typeText(input.editor(), "・切替中");
    settleDebounce();
    expect(storedText("sx")).toBe("切替前の文・切替中");
    const orphan = chatInputDraftKey({ ...target("sx"), workspacePath: null });
    expect(localStorage.getItem(orphan)).toBeNull();
    act(() =>
      setCurrentWorkspaceIdentity({ path: WORKSPACE, openRevision: 2 }),
    );
    expect(input.editor().getText()).toBe("切替前の文・切替中");
  });

  it("持ち越した後に移り先で打ち足しても上限超過なら、移り先の古い保存を残す", () => {
    seed("s2", "s2 の下書き");
    const input = mountInput();
    typeText(input.editor(), "あ".repeat(CHAT_INPUT_DRAFT_MAX_BYTES / 3 + 10));
    settleDebounce();
    setChat({ sessionId: "s2" });
    typeText(input.editor(), "（打ち足し）");
    settleDebounce();
    expect(storedText("s2")).toBe("s2 の下書き");
  });

  it("持ち越した後に入力欄を一度空にしたら、移り先の古い保存は守らない", () => {
    seed("s2", "s2 の下書き");
    const input = mountInput();
    typeText(input.editor(), "あ".repeat(CHAT_INPUT_DRAFT_MAX_BYTES / 3 + 10));
    settleDebounce();
    setChat({ sessionId: "s2" });
    act(() => {
      input.editor().commands.clearContent(true);
    });
    typeText(input.editor(), "い".repeat(CHAT_INPUT_DRAFT_MAX_BYTES / 3 + 10));
    settleDebounce();
    // 貼り直した長文は保存できないので、見ていない古い内容を再起動で戻さない。
    expect(localStorage.getItem(chatInputDraftKey(target("s2")))).toBeNull();
  });

  it("送信中に scope を変えたら、移った先の新しいチャットの内容を作られた session へ引き継がない", () => {
    const sceneSlot = { ...target(null), scopeSlot: "scene:scene-b::" };
    seedAt(sceneSlot, "scene-b の新しいチャットの文");
    setChat({ sessionId: null, sessionIds: [] });
    const input = mountInput();
    typeText(input.editor(), "project の新しいチャットの文");
    input.handle.current!.submittingRef.current = true;
    input.handle.current!.controller.captureForSend();
    setChat({ sessionId: null, sessionIds: [], sceneId: "scene-b" });
    expect(input.editor().getText()).toBe("scene-b の新しいチャットの文");
    setChat({ sessionId: "created", sessionIds: [], sceneId: "scene-b" });
    input.handle.current!.submittingRef.current = false;
    expect(storedTextAt(sceneSlot)).toBe("scene-b の新しいチャットの文");
    expect(storedText("created")).toBeNull();
  });
});

describe("storage の失敗と保存値の検査", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetChatInputDraftPurgesForTests();
    setCurrentWorkspaceIdentity({ path: WORKSPACE, openRevision: 1 });
    setChat({ sessionId: "s1", sessionIds: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setCurrentWorkspaceIdentity(null);
  });

  /** Map で持つ storage。指定した操作だけ throw させる。 */
  function stubStorage(
    failing: Partial<Record<"getItem" | "setItem" | "removeItem", () => never>>,
  ) {
    const values = new Map<string, string>();
    const fake = {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) =>
        failing.getItem ? failing.getItem() : (values.get(key) ?? null),
      setItem: (key: string, value: string) => {
        if (failing.setItem) failing.setItem();
        values.set(key, value);
      },
      removeItem: (key: string) => {
        if (failing.removeItem) failing.removeItem();
        values.delete(key);
      },
      clear: () => values.clear(),
    };
    vi.stubGlobal("localStorage", fake);
    return values;
  }

  const paragraph = (text: string) => ({
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
    commandId: null,
  });

  it("localStorage が無い環境でも、読み書き・削除・入力が例外を出さない", () => {
    vi.stubGlobal("localStorage", undefined);
    const key = chatInputDraftKey(target("s1"));
    expect(writeChatInputDraft(key, target("s1"), 0, paragraph("x"))).toBe(
      "unavailable",
    );
    expect(readChatInputDraft(key)).toBeNull();
    expect(() => purgeChatInputDrafts(WORKSPACE, "p1")).not.toThrow();
    const input = mountInput();
    typeText(input.editor(), "保存できない環境の入力");
    settleDebounce();
    expect(input.editor().getText()).toBe("保存できない環境の入力");
  });

  it("getItem／setItem／removeItem が throw しても例外を出さない", () => {
    const key = chatInputDraftKey(target("s1"));
    const fail = (): never => {
      throw new Error("storage failure");
    };
    const values = stubStorage({
      getItem: fail,
      setItem: fail,
      removeItem: fail,
    });
    values.set(
      key,
      JSON.stringify({ v: 1, key, updatedAt: 1, ...paragraph("x") }),
    );
    expect(readChatInputDraft(key)).toBeNull();
    expect(writeChatInputDraft(key, target("s1"), 0, paragraph("x"))).toBe(
      "unavailable",
    );
    expect(writeChatInputDraft(key, target("s1"), 0, null)).toBe("unavailable");
    expect(() => purgeChatInputDrafts(WORKSPACE, "p1")).not.toThrow();
    const input = mountInput();
    typeText(input.editor(), "失敗しても打てる");
    settleDebounce();
    expect(input.editor().getText()).toBe("失敗しても打てる");
  });

  it("quota 超過の setItem は unavailable になり、入力欄の内容は持ち越す", () => {
    const failing: Parameters<typeof stubStorage>[0] = {};
    stubStorage(failing);
    seed("s2", "s2 の下書き");
    failing.setItem = (): never => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    const input = mountInput();
    typeText(input.editor(), "quota で保存できない文");
    settleDebounce();
    expect(storedText("s1")).toBeNull();
    setChat({ sessionId: "s2" });
    expect(input.editor().getText()).toBe("quota で保存できない文");
    settleDebounce();
    expect(storedText("s2")).toBe("s2 の下書き");
  });

  it("schema に合わない保存値は、本文を警告に出さずに捨てる", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const key = chatInputDraftKey(target("s1"));
    // nodeFromJSON は通るが check() で落ちる（doc の直下に text は置けない）。
    localStorage.setItem(
      key,
      JSON.stringify({
        v: 1,
        key,
        updatedAt: 1,
        doc: { type: "doc", content: [{ type: "text", text: "秘密の本文" }] },
        commandId: null,
      }),
    );
    const input = mountInput();
    expect(input.editor().getText()).toBe("");
    expect(localStorage.getItem(key)).toBeNull();
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain("秘密の本文");
  });

  it("全下書きの合計が上限を超えたら、更新の古いものから消す", () => {
    const text = "a".repeat(60_000);
    for (let i = 0; i < 10; i++) {
      const sessionTarget = target(`big-${i}`);
      expect(
        writeChatInputDraft(
          chatInputDraftKey(sessionTarget),
          sessionTarget,
          0,
          paragraph(text),
          i,
        ),
      ).toBe("saved");
    }
    let total = 0;
    const kept: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? "";
      if (!key.startsWith("gdx.chatDraft.v1|")) continue;
      total += (key.length + (localStorage.getItem(key) ?? "").length) * 2;
      kept.push(key);
    }
    expect(total).toBeLessThanOrEqual(CHAT_INPUT_DRAFT_MAX_TOTAL_BYTES);
    expect(kept.length).toBeLessThan(10);
    expect(readChatInputDraft(chatInputDraftKey(target("big-0")))).toBeNull();
    expect(
      readChatInputDraft(chatInputDraftKey(target("big-9"))),
    ).not.toBeNull();
  });

  it("A/B の採用などで入力欄を空にしたら、debounce を待たずに保存を消す", () => {
    const input = mountInput();
    typeText(input.editor(), "採用する下書き");
    settleDebounce();
    expect(storedText("s1")).toBe("採用する下書き");
    act(() => {
      input.editor().commands.clearContent();
      input.handle.current!.controller.discardCurrent();
    });
    expect(storedText("s1")).toBeNull();
  });
});
