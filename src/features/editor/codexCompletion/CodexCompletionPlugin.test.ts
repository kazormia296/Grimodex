import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import {
  codexCompletionKey,
  createCodexCompletionPlugin,
} from "./CodexCompletionPlugin";
import { buildCodexCompletionIndex } from "./codexCompletionIndex";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
});

function createState(composing = false) {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("Set")]),
  ]);
  const selection = TextSelection.create(doc, 4);
  const index = buildCodexCompletionIndex([
    {
      id: "entry-1",
      name: "Setsuna",
      type: "character",
      aliases: null,
      excludedAliases: null,
    },
  ]);
  const plugin = createCodexCompletionPlugin(() => index);
  let state = EditorState.create({ doc, selection, plugins: [plugin] });
  if (composing) {
    state = state.apply(
      state.tr.setMeta(codexCompletionKey, { type: "compositionStart" }),
    );
  }
  return { plugin, state };
}

function event(key: string, composing = false) {
  return {
    key,
    isComposing: composing,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
}

describe("Codex completion ProseMirror plugin", () => {
  it("keeps the document unchanged while exposing a ghost candidate", () => {
    const { state } = createState();
    const pluginState = codexCompletionKey.getState(state);

    expect(state.doc.textContent).toBe("Set");
    expect(pluginState).toMatchObject({
      prefix: "Set",
      prefixFrom: 1,
      prefixTo: 4,
      candidate: { surface: "Setsuna" },
      suffix: "suna",
    });
  });

  it("accepts the whole surface with Tab in one transaction", () => {
    const { plugin, state } = createState();
    let current = state;
    const view = {
      get state() {
        return current;
      },
      dispatch(transaction: Parameters<typeof current.apply>[0]) {
        current = current.apply(transaction);
      },
      editable: true,
    };
    let prevented = false;
    const tab = event("Tab");
    tab.preventDefault = () => {
      prevented = true;
    };

    const handleKeyDown = plugin.spec.props?.handleKeyDown;
    if (!handleKeyDown) throw new Error("completion key handler is missing");
    const handled = handleKeyDown.call(plugin, view as never, tab);

    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    expect(current.doc.textContent).toBe("Setsuna");
    expect(current.doc.textContent).not.toBe(state.doc.textContent);
  });

  it("never consumes Tab while composition is active, even if the event flag is absent", () => {
    const { plugin, state } = createState(true);
    let prevented = false;
    const tab = event("Tab");
    tab.preventDefault = () => {
      prevented = true;
    };
    const view = {
      state,
      editable: true,
      dispatch: () => undefined,
    };

    const handleKeyDown = plugin.spec.props?.handleKeyDown;
    if (!handleKeyDown) throw new Error("completion key handler is missing");
    expect(handleKeyDown.call(plugin, view as never, tab)).toBe(false);
    expect(prevented).toBe(false);
    expect(codexCompletionKey.getState(state)?.candidate).toBeNull();
  });

  it("clears the ghost candidate when composition starts", () => {
    const { plugin, state } = createState();
    let current = state;
    const view = {
      get state() {
        return current;
      },
      dispatch(transaction: Parameters<typeof current.apply>[0]) {
        current = current.apply(transaction);
      },
    };

    const compositionStart =
      plugin.spec.props?.handleDOMEvents?.compositionstart;
    if (!compositionStart) {
      throw new Error("compositionstart handler is missing");
    }
    compositionStart.call(
      plugin,
      view as never,
      new Event("compositionstart") as CompositionEvent,
    );

    expect(codexCompletionKey.getState(current)).toMatchObject({
      composing: true,
      candidate: null,
    });
  });
});
