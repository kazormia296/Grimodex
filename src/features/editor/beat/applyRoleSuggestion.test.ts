import { describe, it, expect } from "vitest";
import { applyRoleSuggestion } from "./applyRoleSuggestion";

// Minimal editor mock that simulates ProseMirror doc traversal and dispatch
function makeEditor(
  nodes: {
    type: string;
    attrs?: Record<string, unknown>;
    parent?: { type: string; attrs?: Record<string, unknown> };
    pos: number;
  }[],
) {
  const dispatched: unknown[] = [];

  // Build a tr mock that records setNodeMarkup calls
  const trMocks: {
    pos: number;
    type: undefined;
    attrs: Record<string, unknown>;
  }[] = [];

  const tr = {
    setNodeMarkup: (
      pos: number,
      type: undefined,
      attrs: Record<string, unknown>,
    ) => {
      trMocks.push({ pos, type, attrs });
      return tr;
    },
    setMeta: (_key: string, _value: unknown) => tr,
  };

  const editor = {
    state: {
      tr,
      doc: {
        descendants: (
          fn: (
            node: { type: { name: string }; attrs: Record<string, unknown> },
            pos: number,
            parent: {
              type: { name: string };
              attrs: Record<string, unknown>;
            } | null,
          ) => boolean | void,
        ) => {
          for (const n of nodes) {
            fn(
              { type: { name: n.type }, attrs: n.attrs ?? {} },
              n.pos,
              n.parent
                ? {
                    type: { name: n.parent.type },
                    attrs: n.parent.attrs ?? {},
                  }
                : null,
            );
          }
        },
      },
    },
    view: {
      dispatch: (t: unknown) => dispatched.push(t),
    },
  };

  return { editor, dispatched, trMocks };
}

describe("applyRoleSuggestion", () => {
  it("同 beat 内の一致する mention の role を更新する", () => {
    const { editor, dispatched, trMocks } = makeEditor([
      {
        type: "mention",
        attrs: { id: "c1", role: "mentioned" },
        pos: 10,
        parent: { type: "sceneBeat", attrs: { id: "b1" } },
      },
    ]);

    const result = applyRoleSuggestion(
      editor as unknown as import("@tiptap/core").Editor,
      "b1",
      "c1",
      "actor",
    );

    expect(result).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(trMocks[0].attrs.role).toBe("actor");
    expect(trMocks[0].pos).toBe(10);
  });

  it("別の beat の mention は変更しない", () => {
    const { editor, dispatched } = makeEditor([
      {
        type: "mention",
        attrs: { id: "c1", role: "mentioned" },
        pos: 10,
        parent: { type: "sceneBeat", attrs: { id: "b2" } }, // different beat
      },
    ]);

    const result = applyRoleSuggestion(
      editor as unknown as import("@tiptap/core").Editor,
      "b1",
      "c1",
      "actor",
    );

    expect(result).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it("一致する mention がないとき false を返し dispatch しない", () => {
    const { editor, dispatched } = makeEditor([
      {
        type: "mention",
        attrs: { id: "c99", role: "mentioned" },
        pos: 5,
        parent: { type: "sceneBeat", attrs: { id: "b1" } },
      },
    ]);

    const result = applyRoleSuggestion(
      editor as unknown as import("@tiptap/core").Editor,
      "b1",
      "c1", // not found
      "actor",
    );

    expect(result).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it("同 beat 内に同 codexId が複数あるとき全て更新する", () => {
    const { editor, dispatched, trMocks } = makeEditor([
      {
        type: "mention",
        attrs: { id: "c1", role: "mentioned" },
        pos: 10,
        parent: { type: "sceneBeat", attrs: { id: "b1" } },
      },
      {
        type: "mention",
        attrs: { id: "c1", role: "mentioned" },
        pos: 20,
        parent: { type: "sceneBeat", attrs: { id: "b1" } },
      },
    ]);

    const result = applyRoleSuggestion(
      editor as unknown as import("@tiptap/core").Editor,
      "b1",
      "c1",
      "target",
    );

    expect(result).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(trMocks).toHaveLength(2);
    expect(trMocks[0].attrs.role).toBe("target");
    expect(trMocks[1].attrs.role).toBe("target");
  });

  it("parent が null のノードは無視する", () => {
    const { editor, dispatched } = makeEditor([
      {
        type: "mention",
        attrs: { id: "c1", role: "mentioned" },
        pos: 5,
        // no parent
      },
    ]);

    const result = applyRoleSuggestion(
      editor as unknown as import("@tiptap/core").Editor,
      "b1",
      "c1",
      "actor",
    );

    expect(result).toBe(false);
    expect(dispatched).toHaveLength(0);
  });
});
