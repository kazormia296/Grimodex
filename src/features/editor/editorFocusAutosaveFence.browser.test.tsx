/**
 * 部品単位の試験：scene の autosave の間に、TipTap editor の focus が外れない（EAR-1）。
 *
 * 事実の固定（変えない）：TipTap の Tabindex 拡張は editable=false で tabindex を外し、ProseMirror の
 * contenteditable も "false" になる。実 Chromium は focus 中の要素が focusable でなくなると focus を
 * body へ落とし、`setEditable(true)` に戻しても focus は戻らない。EditorPane／hook に focus の復元は無い。
 * だから自分の autosave では editable を一度も切らない（runTimelapseEditorBodyWrite は fence も lease も
 * 取らず、recorder の capture hold で順序を守る）。外部の書き換え（runTimelapseBodyReplacement。
 * undo・復元・agent 書込み・import）は従来どおり editor を read-only にする（範囲外）。
 *
 * 「事実の固定」の試験は、false→true を実際に挟むと focus が落ちること自体を assert する。
 * 製品の経路（自分の autosave・同値の setEditable・他文書の fence）で落ちないことは別の試験が見る。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import {
  runTimelapseBodyReplacement,
  runTimelapseEditorBodyWrite,
} from "@/features/timelapse/bodyWriteMode";
import { userEvent } from "vitest/browser";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import type { DocumentKey } from "@/features/editor/document/documentKey";

const PROJECT_ID = "project-1";
const KEY: DocumentKey = { kind: "tree", id: "scene-1", storage: "database" };

const IDENTITY = {
  projectId: PROJECT_ID,
  domain: "editor",
  entityType: "scene",
  entityId: "scene-1",
  storage: "database",
} as const;

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

interface MountedEditor {
  editor: Editor;
  pm: HTMLElement;
}

/** `synced` なら製品と同じ useLicenseEditableSync（document key と project 付き）を掛ける。 */
function Harness({
  synced,
  onReady,
}: {
  synced: boolean;
  onReady: (e: Editor) => void;
}) {
  const editor = useEditor({
    extensions: getEditorExtensions(),
    content: "<p>hello</p>",
    onCreate({ editor }) {
      onReady(editor);
    },
  });
  useLicenseEditableSync(
    editor,
    false,
    synced ? KEY : null,
    synced ? PROJECT_ID : null,
  );
  return <EditorContent editor={editor} />;
}

async function mountFocused(synced: boolean): Promise<MountedEditor> {
  let ed: Editor | null = null;
  const { container } = render(
    <Harness synced={synced} onReady={(e) => (ed = e)} />,
  );
  const pm = await waitFor(() => {
    const el = container.querySelector<HTMLElement>(".ProseMirror");
    if (!el) throw new Error("editor not mounted");
    return el;
  });
  const editor = await waitFor(() => {
    if (!ed) throw new Error("no editor instance");
    return ed as Editor;
  });
  await waitFor(() => {
    if (!editor.isEditable) throw new Error("editor not editable yet");
  });
  // TipTap の focus() は requestAnimationFrame で実際の focus を行う。
  editor.commands.focus();
  await nextFrame();
  // 前提：ここで focus が editor に載っていなければ、以降の assert は意味を持たない。
  expect(document.activeElement).toBe(pm);
  return { editor, pm };
}

afterEach(() => {
  document.body.innerHTML = "";
  publishCurrentProjectId(null);
  setCurrentWorkspaceIdentity(null);
});

describe("autosave の fence の間の editor focus（実 Chromium）", () => {
  it("対照：editable を切り替えなければ focus は editor に残る", async () => {
    const { pm } = await mountFocused(false);
    await nextFrame();
    expect(document.activeElement).toBe(pm);
  });

  it("事実の固定：setEditable(false) → true の後（描画を挟む）、focus が body に落ちて戻らない。だから自分の保存では editable を切らない", async () => {
    const { editor } = await mountFocused(false);
    editor.setEditable(false, false);
    await nextFrame();
    editor.setEditable(true, false);
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it("事実の固定：setEditable(false) → true を同じ task で続けても、focus が body に落ちて戻らない", async () => {
    const { editor } = await mountFocused(false);
    // 間で layout・activeElement を読まない。Chromium が false の間に何も評価しない形。
    editor.setEditable(false, false);
    editor.setEditable(true, false);
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it("同値の setEditable(true, false) は focus も selection も落とさない（事実の確認。hook の同値 guard は、これが落ちるかどうかに関わらず必須の防御）", async () => {
    const { editor, pm } = await mountFocused(false);
    editor.commands.setTextSelection(3);
    const before = editor.state.selection.from;
    editor.setEditable(true, false);
    await nextFrame();
    expect(document.activeElement).toBe(pm);
    expect(editor.state.selection.from).toBe(before);
  });

  it("外部置換の契約（runTimelapseBodyReplacement と useLicenseEditableSync と実 fence）：editor は read-only になり、解除後に戻り、focus は body に落ちる（範囲外。従来どおり）", async () => {
    publishCurrentProjectId(PROJECT_ID);
    setCurrentWorkspaceIdentity({ path: "/fence.gdx", openRevision: 1 });
    const { editor } = await mountFocused(true);

    let editableDuringFence: boolean | null = null;
    await act(async () => {
      await runTimelapseBodyReplacement(
        {
          projectId: PROJECT_ID,
          documentIdentity: IDENTITY,
        },
        {
          // persistSceneBody の commit（IPC）の代わり。描画を 1 回挟む。
          commit: async () => {
            await nextFrame();
            editableDuringFence = editor.isEditable;
            return "committed";
          },
          project: async (committed) => committed,
        },
      );
    });
    // 前提：fence の間は editor が read-only になり、解除後は editable に戻る。
    expect(editableDuringFence).toBe(false);
    await waitFor(() => expect(editor.isEditable).toBe(true));
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it("自分の autosave の経路（useLicenseEditableSync と runTimelapseEditorBodyWrite）：editable は true のまま、focus が editor に残り、保存の間に打った文字が入る", async () => {
    publishCurrentProjectId(PROJECT_ID);
    setCurrentWorkspaceIdentity({ path: "/fence.gdx", openRevision: 1 });
    const { editor, pm } = await mountFocused(true);

    let editableDuringSave: boolean | null = null;
    await act(async () => {
      await runTimelapseEditorBodyWrite(
        { projectId: PROJECT_ID, documentIdentity: IDENTITY },
        {
          commit: async () => {
            await nextFrame();
            editableDuringSave = editor.isEditable;
            // 保存の間に実キー入力が本文に入る。
            await userEvent.keyboard("XY");
            await nextFrame();
            return "committed";
          },
          project: async (committed) => committed,
        },
      );
    });
    expect(editableDuringSave).toBe(true);
    await nextFrame();
    expect(editor.isEditable).toBe(true);
    expect(document.activeElement).toBe(pm);
    expect(editor.state.doc.textContent).toContain("XY");
    await userEvent.keyboard("Z");
    expect(editor.state.doc.textContent).toContain("Z");
  });

  it("T-9 (c) journey：他文書（codex など）の autosave が fence を開閉している間も、focus 中の scene editor は read-only にならず、focus が落ちず、入力が続く", async () => {
    publishCurrentProjectId(PROJECT_ID);
    setCurrentWorkspaceIdentity({ path: "/fence.gdx", openRevision: 1 });
    const { editor, pm } = await mountFocused(true);
    const setEditable = vi.spyOn(editor, "setEditable");

    await act(async () => {
      await runTimelapseBodyReplacement(
        {
          projectId: PROJECT_ID,
          documentIdentity: {
            projectId: PROJECT_ID,
            domain: "codex",
            entityType: "codex_entry",
            entityId: "codex-1",
          },
        },
        {
          commit: async () => {
            await nextFrame();
            // 他文書の fence の間も scene は writable で、打てる。
            expect(editor.isEditable).toBe(true);
            await userEvent.keyboard("AB");
            return "committed";
          },
          project: async (committed) => committed,
        },
      );
    });
    await nextFrame();
    // 他文書の fence の通知で、望む値が変わらない setEditable は 1 度も呼ばれない。
    expect(setEditable).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pm);
    await userEvent.keyboard("CD");
    expect(editor.state.doc.textContent).toContain("ABCD");
  });
});
