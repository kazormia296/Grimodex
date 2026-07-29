// @vitest-environment happy-dom
import { Editor, type Content } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SceneBeatNode } from "./SceneBeatNode";
import {
  handleSceneEditorTransaction,
  type SceneBeatIndexRef,
  type SceneEditorTransactionPorts,
} from "./sceneEditorTransactionPipeline";
import type { UnplacedBeat } from "./beat/unplacedBeatsStore";

const editors: Editor[] = [];

function createEditor(content?: Content): Editor {
  const editor = new Editor({
    extensions: [StarterKit, SceneBeatNode],
    content: content ?? {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "alpha" }],
        },
        {
          type: "sceneBeat",
          attrs: {
            id: "beat-1",
            collapsed: false,
            beatType: "free",
            pov: null,
          },
          content: [{ type: "text", text: "first beat" }],
        },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

function findNode(
  editor: Editor,
  nodeType: string,
): { pos: number; nodeSize: number } {
  const matches: Array<{ pos: number; nodeSize: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (matches.length > 0 || node.type.name !== nodeType) return true;
    matches.push({ pos, nodeSize: node.nodeSize });
    return false;
  });
  const match = matches[0];
  if (!match) throw new Error(`Missing ${nodeType}`);
  return match;
}

function createPorts(initialBeats: UnplacedBeat[] = []) {
  let beats = initialBeats;
  const record = vi.fn();
  const setPreview = vi.fn();
  const addBeat = vi.fn((_: string, beat: UnplacedBeat) => {
    beats = [...beats, beat];
  });
  const removeBeat = vi.fn((_: string, beatId: string) => {
    beats = beats.filter((beat) => beat.id !== beatId);
  });
  const ports: SceneEditorTransactionPorts = {
    recordChangeEvent: record,
    reportTimelapseFailure: vi.fn(),
    getUnplacedBeatStore: () => ({
      getBeats: () => beats,
      addBeat,
      removeBeat,
    }),
    setNodePreview: setPreview,
    markStart: vi.fn(),
    markEnd: vi.fn(),
  };
  return { ports, record, setPreview, addBeat, removeBeat };
}

function sceneInput(
  transaction: Editor["state"]["tr"],
  beatIndexRef: SceneBeatIndexRef,
  isApplyingExternalUpdate = false,
) {
  return {
    transaction,
    id: "scene-1",
    isEntryMode: false,
    isCodexMode: false,
    isSnippetMode: false,
    isChronicleEventMode: false,
    isApplyingExternalUpdate,
    beatIndexRef,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("handleSceneEditorTransaction", () => {
  it("records a user prose step but only maps the Beat index", () => {
    const editor = createEditor();
    const paragraph = findNode(editor, "paragraph");
    const transaction = editor.state.tr.insertText("!", paragraph.pos + 1);
    const beatIndexRef: SceneBeatIndexRef = { current: null };
    const { ports, record, setPreview, addBeat, removeBeat } = createPorts();

    handleSceneEditorTransaction(sceneInput(transaction, beatIndexRef), ports);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "editor",
        opType: "doc.step",
        sceneId: "scene-1",
      }),
    );
    expect(beatIndexRef.current?.sceneId).toBe("scene-1");
    expect(setPreview).not.toHaveBeenCalled();
    expect(addBeat).not.toHaveBeenCalled();
    expect(removeBeat).not.toHaveBeenCalled();
  });

  it("does not record or reconcile an emitUpdate:false external replacement", () => {
    const editor = createEditor();
    const replacement = editor.schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "loaded" }],
        },
      ],
    });
    const transaction = editor.state.tr.replaceWith(
      0,
      editor.state.doc.content.size,
      replacement.content,
    );
    const beatIndexRef: SceneBeatIndexRef = { current: null };
    const { ports, record, setPreview, addBeat, removeBeat } = createPorts();

    handleSceneEditorTransaction(
      sceneInput(transaction, beatIndexRef, true),
      ports,
    );

    expect(record).not.toHaveBeenCalled();
    expect(beatIndexRef.current?.index.doc).toBe(transaction.doc);
    expect(setPreview).not.toHaveBeenCalled();
    expect(addBeat).not.toHaveBeenCalled();
    expect(removeBeat).not.toHaveBeenCalled();
  });

  it("produces identical Timelapse, Beat, and preview effects for both surfaces", () => {
    const editor = createEditor();
    const beat = findNode(editor, "sceneBeat");
    const transaction = editor.state.tr.delete(
      beat.pos,
      beat.pos + beat.nodeSize,
    );
    const tabBeatIndexRef: SceneBeatIndexRef = { current: null };
    const linearBeatIndexRef: SceneBeatIndexRef = { current: null };
    const tab = createPorts();
    const linear = createPorts();

    handleSceneEditorTransaction(
      sceneInput(transaction, tabBeatIndexRef),
      tab.ports,
    );
    handleSceneEditorTransaction(
      sceneInput(transaction, linearBeatIndexRef),
      linear.ports,
    );

    expect(tab.record.mock.calls).toEqual(linear.record.mock.calls);
    expect(tab.addBeat.mock.calls).toEqual(linear.addBeat.mock.calls);
    expect(tab.removeBeat.mock.calls).toEqual(linear.removeBeat.mock.calls);
    expect(tab.setPreview.mock.calls).toEqual(linear.setPreview.mock.calls);
    expect(tabBeatIndexRef.current?.index.doc).toBe(
      linearBeatIndexRef.current?.index.doc,
    );
    expect(tab.record).toHaveBeenCalledTimes(1);
    expect(tab.addBeat).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ id: "beat-1" }),
    );
    expect(tab.setPreview).toHaveBeenCalledWith("scene-1", {
      placed: null,
      unplaced: JSON.stringify(["first beat"]),
    });
  });

  it("captures Codex body steps without invoking scene Beat ports", () => {
    const editor = createEditor();
    const transaction = editor.state.tr.insertText("!", 1);
    const beatIndexRef: SceneBeatIndexRef = { current: null };
    const { ports, record, setPreview } = createPorts();

    handleSceneEditorTransaction(
      {
        transaction,
        id: "codex-1",
        isEntryMode: true,
        isCodexMode: true,
        isSnippetMode: false,
        isChronicleEventMode: false,
        isApplyingExternalUpdate: false,
        beatIndexRef,
      },
      ports,
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "codex",
        entityType: "codex_entry",
      }),
    );
    expect(beatIndexRef.current).toBeNull();
    expect(setPreview).not.toHaveBeenCalled();
  });

  it("keeps both EditorPane and LinearSceneBlock wired to the canonical pipeline", async () => {
    const [tabSource, linearSource] = await Promise.all([
      readFile(
        resolve(process.cwd(), "src/features/editor/EditorPane.tsx"),
        "utf8",
      ),
      readFile(
        resolve(process.cwd(), "src/features/editor/LinearSceneBlock.tsx"),
        "utf8",
      ),
    ]);

    for (const source of [tabSource, linearSource]) {
      expect(source).toContain(
        'from "@/features/editor/sceneEditorTransactionPipeline"',
      );
      expect(source.match(/handleSceneEditorTransaction\(/g)).toHaveLength(1);
    }
  });
});
