import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import { history, undo } from "@tiptap/pm/history";
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
    ruby: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { base: { default: "" } },
    },
  },
});

const index = buildCodexCompletionIndex([
  {
    id: "entry-1",
    name: "Setsuna",
    type: "character",
    aliases: JSON.stringify(["刹那"]),
    excludedAliases: null,
  },
]);

function createState(content = "") {
  const doc = schema.node("doc", null, [
    schema.node(
      "paragraph",
      null,
      content.length > 0 ? [schema.text(content)] : undefined,
    ),
  ]);
  const selection = TextSelection.create(doc, 1 + content.length);
  const plugin = createCodexCompletionPlugin(() => index);
  const state = EditorState.create({
    doc,
    selection,
    plugins: [history(), plugin],
  });
  return { plugin, state };
}

function focusAndType(state: EditorState, text: string): EditorState {
  const focused = state.apply(
    state.tr.setMeta(codexCompletionKey, { type: "focus" }),
  );
  return focused.apply(focused.tr.insertText(text));
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
    const initial = createState();
    const state = focusAndType(initial.state, "Set");
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
    let current = focusAndType(state, "Set");
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
    const { plugin, state } = createState();
    let current = focusAndType(state, "Set");
    current = current.apply(
      current.tr.setMeta(codexCompletionKey, { type: "compositionStart" }),
    );
    let prevented = false;
    const tab = event("Tab");
    tab.preventDefault = () => {
      prevented = true;
    };
    const view = {
      state: current,
      editable: true,
      dispatch: () => undefined,
    };

    const handleKeyDown = plugin.spec.props?.handleKeyDown;
    if (!handleKeyDown) throw new Error("completion key handler is missing");
    expect(handleKeyDown.call(plugin, view as never, tab)).toBe(false);
    expect(prevented).toBe(false);
    expect(codexCompletionKey.getState(current)?.candidate).toBeNull();
  });

  it("clears the ghost candidate when composition starts", () => {
    const { plugin, state } = createState();
    let current = focusAndType(state, "Set");
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

  it("maps a prefix after an inline atom back to ProseMirror positions", () => {
    const paragraph = schema.node("paragraph", null, [
      schema.node("ruby", { base: "刹" }),
      schema.text(" "),
    ]);
    const doc = schema.node("doc", null, [paragraph]);
    const plugin = createCodexCompletionPlugin(() => index);
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1 + paragraph.content.size),
      plugins: [plugin],
    });
    state = state.apply(
      state.tr.setMeta(codexCompletionKey, { type: "focus" }),
    );
    state = state.apply(state.tr.insertText("Set"));

    expect(codexCompletionKey.getState(state)).toMatchObject({
      prefix: "Set",
      prefixFrom: 3,
      prefixTo: 6,
      candidate: { surface: "Setsuna" },
    });
  });

  it("does not recompute a candidate after paste or history transactions", () => {
    const { state } = createState();
    let current = state.apply(
      state.tr.setMeta(codexCompletionKey, { type: "focus" }),
    );
    current = current.apply(
      current.tr
        .insertText("Set")
        .setMeta("paste", true)
        .setMeta("uiEvent", "paste"),
    );
    expect(codexCompletionKey.getState(current)?.candidate).toBeNull();

    current = current.apply(
      current.tr.setMeta("history$", { redo: false, undo: true }),
    );
    expect(codexCompletionKey.getState(current)?.candidate).toBeNull();
  });

  it("does not recompute in a blurred editor after a peer document update", () => {
    const initial = createState();
    let state = focusAndType(initial.state, "Se");
    state = state.apply(state.tr.setMeta(codexCompletionKey, { type: "blur" }));
    state = state.apply(state.tr.insertText("t"));

    expect(codexCompletionKey.getState(state)).toMatchObject({
      focused: false,
      candidate: null,
    });
  });

  it("keeps the typed prefix as a separate Undo step after Tab acceptance", () => {
    const { plugin, state } = createState();
    let current = focusAndType(state, "Set");
    const view = {
      get state() {
        return current;
      },
      dispatch(transaction: Parameters<typeof current.apply>[0]) {
        current = current.apply(transaction);
      },
      editable: true,
    };
    const handleKeyDown = plugin.spec.props?.handleKeyDown;
    if (!handleKeyDown) throw new Error("completion key handler is missing");

    expect(handleKeyDown.call(plugin, view as never, event("Tab"))).toBe(true);
    expect(current.doc.textContent).toBe("Setsuna");
    undo(current, (transaction) => {
      current = current.apply(transaction);
    });
    expect(current.doc.textContent).toBe("Set");
  });
});
