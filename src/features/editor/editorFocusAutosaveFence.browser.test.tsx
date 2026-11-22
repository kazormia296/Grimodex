/**
 * 【製品の不具合を再現する試験】scene の autosave の間に、TipTap editor の focus が外れる。
 *
 * 背景：Electron の scene の autosave は persistSceneBody → runTimelapseBodyReplacement
 * （bodyWriteMode.ts）で同期の replacement fence を取り、useLicenseEditableSync が
 * editor.setEditable(false) を呼ぶ（commit と projection の後の release で true に戻る）。
 * TipTap の Tabindex 拡張は editable=false で tabindex を外し、ProseMirror の
 * contenteditable も "false" になる。実 Chromium は focus 中の要素が focusable でなくなると
 * focus を body へ落とし、editable を戻しても focus は戻らない。EditorPane／hook に
 * focus の復元は無い。このため autosave のたびに入力 focus が外れ、次の keystroke が
 * editor に届かない（journey cross-feature-authoring の「editor did not hold focus
 * before undo」の有力な原因）。
 *
 * 【不具合】と付いた試験は「今の挙動」（focus が body に落ちる）を assert する。前提の
 * assert（focus できていた、fence の間は read-only、解除後に editable）が崩れれば別の理由で
 * 失敗するので、it.fails のように前提の失敗が不具合の再現に化けることは無い。製品を直して
 * focus が残るようになると、これらの試験は意図どおり失敗する。そのときは期待値を
 * `toBe(pm)` に反転して回帰試験にする（対照の試験はそのまま）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import { runTimelapseBodyReplacement } from "@/features/timelapse/bodyWriteMode";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import type { DocumentKey } from "@/features/editor/document/documentKey";

const PROJECT_ID = "project-1";
const KEY: DocumentKey = { kind: "tree", id: "scene-1", storage: "database" };

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

  it("【不具合】setEditable(false) → true の後（描画を挟む）、focus が body に落ちて戻らない", async () => {
    const { editor } = await mountFocused(false);
    editor.setEditable(false, false);
    await nextFrame();
    editor.setEditable(true, false);
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it("【不具合】setEditable(false) → true を同じ task で続けても、focus が body に落ちて戻らない", async () => {
    const { editor } = await mountFocused(false);
    // 間で layout・activeElement を読まない。Chromium が false の間に何も評価しない形。
    editor.setEditable(false, false);
    editor.setEditable(true, false);
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it("【不具合】製品の autosave の経路（useLicenseEditableSync と実 fence）で、focus が body に落ちて戻らない", async () => {
    publishCurrentProjectId(PROJECT_ID);
    setCurrentWorkspaceIdentity({ path: "/fence.gdx", openRevision: 1 });
    const { editor } = await mountFocused(true);

    let editableDuringFence: boolean | null = null;
    await act(async () => {
      await runTimelapseBodyReplacement(
        {
          projectId: PROJECT_ID,
          documentIdentity: {
            projectId: PROJECT_ID,
            domain: "editor",
            entityType: "scene",
            entityId: "scene-1",
            storage: "database",
          },
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
});
