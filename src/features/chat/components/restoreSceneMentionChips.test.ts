// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { getChatInputExtensions } from "../extensions/chatInputExtensions";
import { restoreSceneMentionChips } from "./ChatInput";

function makeScene(id: string, title: string, sortOrder: string): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title,
    sortOrder,
    synopsis: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    charCount: null,
    wordCount: null,
    labels: [],
    pov: null,
    location: null,
  } as unknown as TreeNodeData;
}

function makeEditor() {
  return new Editor({
    extensions: getChatInputExtensions({
      placeholder: "",
      onSubmit: () => {},
      onStop: () => {},
      setMentionPopup: () => {},
      setCommandPopup: () => {},
    }),
  });
}

describe("restoreSceneMentionChips", () => {
  beforeEach(() => {
    useTreeStore.setState({
      nodes: [
        makeScene("s1", "出会いの場面", "a0"),
        makeScene("s2", "別れの場面", "a1"),
      ],
      scenes: [
        { id: "s1", title: "出会いの場面", sortOrder: "a0" },
        { id: "s2", title: "別れの場面", sortOrder: "a1" },
      ],
    });
  });

  it("plain text `@Title` を mention ノードに置換する", () => {
    const editor = makeEditor();
    editor.commands.setContent("確認したいのは @出会いの場面 の流れ");

    restoreSceneMentionChips(editor, ["s1"]);

    let mentionAttrs: Record<string, unknown> | null = null;
    const plainTextSegments: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentionAttrs = node.attrs;
      if (node.isText && node.text) plainTextSegments.push(node.text);
    });
    expect(mentionAttrs).toMatchObject({
      id: "s1",
      label: "出会いの場面",
      kind: "scene",
    });
    // plain text 側には `@出会いの場面` の文字列は残っていない (mention ノード化された)
    expect(plainTextSegments.join("")).not.toContain("@出会いの場面");
    editor.destroy();
  });

  it("tree から消えた scene id は黙って無視する", () => {
    const editor = makeEditor();
    editor.commands.setContent("@消えた場面 を確認");

    restoreSceneMentionChips(editor, ["ghost-id"]);

    let hasMention = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") hasMention = true;
    });
    expect(hasMention).toBe(false);
    editor.destroy();
  });

  it("複数の scene id を個別に復元する", () => {
    const editor = makeEditor();
    editor.commands.setContent(
      "@出会いの場面 から @別れの場面 までの流れを整理",
    );

    restoreSceneMentionChips(editor, ["s1", "s2"]);

    const mentionIds: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentionIds.push(node.attrs.id);
    });
    expect(mentionIds).toEqual(["s1", "s2"]);
    editor.destroy();
  });

  it("doc に Title が出現しない id は何もしない", () => {
    const editor = makeEditor();
    editor.commands.setContent("ただの質問です");

    restoreSceneMentionChips(editor, ["s1"]);

    let hasMention = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") hasMention = true;
    });
    expect(hasMention).toBe(false);
    expect(editor.getText().trim()).toBe("ただの質問です");
    editor.destroy();
  });

  it("editor.schema に mention が無い場合は何もしない", () => {
    // chat 拡張無しのエディタ (StarterKit のみ) を擬似。
    // schema に mention が存在しないので restoreSceneMentionChips は
    // 早期 return し、doc は変更されない。
    const editor = new Editor({ extensions: [StarterKit] });
    editor.commands.setContent("@出会いの場面 を確認");
    const beforeJson = JSON.stringify(editor.getJSON());
    restoreSceneMentionChips(editor, ["s1"]);
    expect(JSON.stringify(editor.getJSON())).toBe(beforeJson);
    editor.destroy();
  });
});
