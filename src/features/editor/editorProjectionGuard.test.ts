// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEditorProjectionGuardExtension,
  type EditorProjectionRef,
} from "./editorProjectionGuard";

describe("editor projection guard", () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
  });

  function createEditor(
    projectionReady: EditorProjectionRef,
    programmaticUpdate: EditorProjectionRef,
    writeAuthority: EditorProjectionRef = projectionReady,
  ) {
    editor = new Editor({
      extensions: [
        StarterKit,
        createEditorProjectionGuardExtension(
          projectionReady,
          programmaticUpdate,
          writeAuthority,
        ),
      ],
      content: "<p>old</p>",
    });
    return editor;
  }

  it("rejects user document transactions before they can mutate an unloaded editor", () => {
    const projectionReady = { current: false };
    const programmaticUpdate = { current: false };
    const instance = createEditor(projectionReady, programmaticUpdate);

    instance.commands.insertContent("injected");

    expect(instance.getText()).toBe("old");
  });

  it("allows the same transaction once the exact projection is ready", () => {
    const projectionReady = { current: false };
    const programmaticUpdate = { current: false };
    const instance = createEditor(projectionReady, programmaticUpdate);

    projectionReady.current = true;
    instance.commands.insertContent(" accepted");

    expect(instance.getText()).toBe(" acceptedold");
  });

  it("allows only explicitly scoped programmatic transactions while unavailable", () => {
    const projectionReady = { current: false };
    const programmaticUpdate = { current: true };
    const instance = createEditor(projectionReady, programmaticUpdate);

    instance.commands.insertContent("hydrated");
    programmaticUpdate.current = false;
    instance.commands.insertContent(" rejected");

    expect(instance.getText()).toBe("hydratedold");
  });

  it("allows TipTap's emitUpdate:false hydration but rejects later user input", () => {
    const projectionReady = { current: false };
    const programmaticUpdate = { current: false };
    const instance = createEditor(projectionReady, programmaticUpdate);

    instance.commands.setContent("<p>loaded</p>", { emitUpdate: false });
    instance.commands.insertContent(" rejected");

    expect(instance.getText()).toBe("loaded");
  });

  it("rejects direct document commands when the loaded projection is read-only", () => {
    const projectionReady = { current: true };
    const programmaticUpdate = { current: false };
    const writeAuthority = { current: false };
    const instance = createEditor(
      projectionReady,
      programmaticUpdate,
      writeAuthority,
    );

    instance.commands.insertContent("locked");

    expect(instance.getText()).toBe("old");
  });
});
