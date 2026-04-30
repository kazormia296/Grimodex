// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { filterCommands, getInlineAiCommands } from "./inlineAiCommands";

describe("sceneBeat slash command registration", () => {
  it("appears in the slash command list", () => {
    const cmds = getInlineAiCommands();
    const beat = cmds.find((c) => c.id === "sceneBeat");
    expect(beat).toBeDefined();
    expect(beat?.kind).toBe("insert-node");
    expect(beat?.label).toBeTruthy();
  });

  it("filters by id prefix", () => {
    const filtered = filterCommands("scene");
    expect(filtered.some((c) => c.id === "sceneBeat")).toBe(true);
  });

  it("inserts a sceneBeat node with auto-generated UUID id", () => {
    const editor = new Editor({
      extensions: [StarterKit, SceneBeatNode],
    });
    editor.chain().focus().insertSceneBeat().run();

    const beats: { id: string; beatType: string; collapsed: boolean }[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") {
        beats.push({
          id: node.attrs.id,
          beatType: node.attrs.beatType,
          collapsed: node.attrs.collapsed,
        });
      }
    });
    expect(beats).toHaveLength(1);
    // crypto.randomUUID() shape: 8-4-4-4-12 hex
    expect(beats[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(beats[0].beatType).toBe("free");
    expect(beats[0].collapsed).toBe(false);
    editor.destroy();
  });

  it("respects explicit attrs when provided", () => {
    const editor = new Editor({
      extensions: [StarterKit, SceneBeatNode],
    });
    editor
      .chain()
      .focus()
      .insertSceneBeat({ id: "fixed-1", beatType: "dialogue", pov: "char-9" })
      .run();

    let attrs: { id: string; beatType: string; pov: string | null } | null =
      null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") {
        attrs = {
          id: node.attrs.id,
          beatType: node.attrs.beatType,
          pov: node.attrs.pov,
        };
      }
    });
    expect(attrs).toEqual({
      id: "fixed-1",
      beatType: "dialogue",
      pov: "char-9",
    });
    editor.destroy();
  });

  it("generates a fresh UUID each call (id is not memoised)", () => {
    const editor = new Editor({
      extensions: [StarterKit, SceneBeatNode],
    });
    editor.chain().focus().insertSceneBeat().run();
    const firstId = (() => {
      let id = "";
      editor.state.doc.descendants((node) => {
        if (node.type.name === "sceneBeat") id = node.attrs.id;
      });
      return id;
    })();
    editor.commands.clearContent();
    editor.chain().focus().insertSceneBeat().run();
    const secondId = (() => {
      let id = "";
      editor.state.doc.descendants((node) => {
        if (node.type.name === "sceneBeat") id = node.attrs.id;
      });
      return id;
    })();
    expect(firstId).not.toBe("");
    expect(secondId).not.toBe("");
    expect(firstId).not.toBe(secondId);
    editor.destroy();
  });
});
