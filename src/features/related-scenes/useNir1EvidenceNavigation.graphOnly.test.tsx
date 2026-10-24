// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { encodeDocumentKey } from "@/features/editor/document/documentKey";
import type { Nir1EvidenceEditorState } from "./nir1EvidenceNavigationState";
import type { Nir1GraphOnlyTarget } from "./nir1EvidenceNavigation";

// C-3, C-5 (DR-CP3B-10): the Graph-only arm of the editor consumer.
vi.mock("./nir1EvidenceNavigation", () => ({
  claimNir1EvidenceNavigation: vi.fn(),
  subscribeNir1EvidenceNavigation: vi.fn(() => () => {}),
}));
vi.mock("./nir1RelatedScenesApi", () => ({ qualifyNir1Evidence: vi.fn() }));
vi.mock("@/features/narrative-semantic-core/nir1GraphApi", () => ({
  qualifyNir1GraphEvidence: vi.fn(),
}));
import { claimNir1EvidenceNavigation } from "./nir1EvidenceNavigation";
import { qualifyNir1Evidence } from "./nir1RelatedScenesApi";
import { qualifyNir1GraphEvidence } from "@/features/narrative-semantic-core/nir1GraphApi";
import { useNir1EvidenceNavigation } from "./useNir1EvidenceNavigation";

const EXCERPT = "The disclosed first line.";
const TARGET: Nir1GraphOnlyTarget = {
  canonicalRange: { start: 0, end: EXCERPT.length },
  excerpt: EXCERPT,
};
const answer = (overrides: Record<string, unknown> = {}) => ({
  status: "qualified" as const,
  bindingKey: "graph-handle",
  queryBinding: "query",
  sceneId: "s1",
  canonicalRange: { start: 0, end: EXCERPT.length },
  ...overrides,
});

function fixture(texts: string[], claims = 1) {
  const document = {
    type: "doc",
    content: texts.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
  const selection = vi.fn();
  const chain = {
    focus: () => chain,
    setTextSelection: (range: unknown) => {
      selection(range);
      return chain;
    },
    scrollIntoView: () => chain,
    run: () => true,
  };
  const editor = {
    isDestroyed: false,
    getJSON: () => document,
    chain: () => chain,
  } as unknown as Editor;
  let state: Nir1EvidenceEditorState = {
    editor,
    documentKey: encodeDocumentKey({
      kind: "tree",
      storage: "database",
      id: "s1",
    }),
    loadToken: {},
    isDirty: false,
    saveSnapshot: {
      binding: {
        kind: "tree",
        storage: "database",
        nodeType: "scene",
        id: "s1",
        loadedVersion: 3,
      },
      editGeneration: 0,
    },
  };
  const finish = vi.fn();
  const claim = {
    identity: "graph-handle",
    queryBinding: "query",
    sceneId: "s1",
    graphOnly: TARGET,
    isCurrent: () => true,
    finish,
  };
  const mocked = vi.mocked(claimNir1EvidenceNavigation);
  for (let i = 0; i < claims; i++) mocked.mockReturnValueOnce(claim);
  mocked.mockReturnValue(null);
  return {
    editor,
    selection,
    finish,
    getState: () => state,
    setState: (next: Partial<Nir1EvidenceEditorState>) => {
      state = { ...state, ...next };
    },
  };
}
const mount = (f: ReturnType<typeof fixture>) =>
  renderHook(() =>
    useNir1EvidenceNavigation({
      editor: f.editor,
      sceneId: "s1",
      ready: true,
      captureState: f.getState,
      beforeSelection: vi.fn(),
    }),
  );

// The consumer is a lazy module: load it once so the first case does not spend
// waitFor's budget on the cold transform.
beforeAll(async () => {
  await import("./nir1EvidenceConsume");
});
beforeEach(() => vi.clearAllMocks());

describe("NIR Graph-only editor consumer", () => {
  it("Graph-only: selects only when the editor text at the range equals the disclosed excerpt", async () => {
    vi.mocked(qualifyNir1GraphEvidence).mockResolvedValue(answer());
    const f = fixture([EXCERPT, "second paragraph"]);
    const hook = mount(f);
    await waitFor(() => expect(f.selection).toHaveBeenCalledOnce());
    expect(f.selection).toHaveBeenCalledWith({
      from: 1,
      to: 1 + EXCERPT.length,
    });
    // The IR qualification (digest, full quote) is never used for it.
    expect(qualifyNir1Evidence).not.toHaveBeenCalled();
    expect(qualifyNir1GraphEvidence).toHaveBeenCalledExactlyOnceWith(
      "graph-handle",
    );
    expect(f.finish).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it("Graph-only: a body that no longer has the excerpt at the range selects nothing", async () => {
    vi.mocked(qualifyNir1GraphEvidence).mockResolvedValue(answer());
    const f = fixture([`Edited: ${EXCERPT}`]);
    const hook = mount(f);
    await waitFor(() => expect(f.finish).toHaveBeenCalledOnce());
    expect(f.selection).not.toHaveBeenCalled();
    hook.unmount();
  });

  it.each(["dirty", "saved", "reload"])(
    "a dirty editor or a changed capture selects nothing (%s)",
    async (kind) => {
      let resolve!: (value: ReturnType<typeof answer>) => void;
      vi.mocked(qualifyNir1GraphEvidence).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const f = fixture([EXCERPT]);
      const hook = mount(f);
      await waitFor(() =>
        expect(qualifyNir1GraphEvidence).toHaveBeenCalledOnce(),
      );
      if (kind === "dirty") f.setState({ isDirty: true });
      else if (kind === "saved")
        f.setState({
          saveSnapshot: {
            binding: { ...f.getState().saveSnapshot!.binding },
            editGeneration: 1,
          },
        });
      else f.setState({ loadToken: {} });
      await act(async () => resolve(answer()));
      await waitFor(() => expect(f.finish).toHaveBeenCalledOnce());
      expect(f.selection).not.toHaveBeenCalled();
      hook.unmount();
    },
  );

  it.each([
    { status: "unavailable", reason: "invalidated" },
    answer({ bindingKey: "other" }),
    answer({ queryBinding: "other" }),
    answer({ sceneId: "s9" }),
    answer({ canonicalRange: { start: 1, end: EXCERPT.length } }),
  ])(
    "a second qualification that is unavailable or differs selects nothing (%o)",
    async (second) => {
      vi.mocked(qualifyNir1GraphEvidence).mockResolvedValue(second as never);
      const f = fixture([EXCERPT]);
      const hook = mount(f);
      await waitFor(() => expect(f.finish).toHaveBeenCalledOnce());
      expect(f.selection).not.toHaveBeenCalled();
      hook.unmount();
    },
  );

  it("a capture bound to another scene selects nothing", async () => {
    vi.mocked(qualifyNir1GraphEvidence).mockResolvedValue(answer());
    const f = fixture([EXCERPT]);
    const state = f.getState();
    f.setState({
      documentKey: encodeDocumentKey({
        kind: "tree",
        storage: "database",
        id: "s9",
      }),
      saveSnapshot: {
        ...state.saveSnapshot!,
        binding: { ...state.saveSnapshot!.binding, id: "s9" },
      },
    });
    const hook = mount(f);
    await waitFor(() => expect(f.finish).toHaveBeenCalledOnce());
    expect(f.selection).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("each click qualifies again and never reuses a previous answer", async () => {
    vi.mocked(qualifyNir1GraphEvidence)
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce({ status: "unavailable", reason: "invalidated" });
    const f = fixture([EXCERPT], 2);
    const first = mount(f);
    await waitFor(() => expect(f.selection).toHaveBeenCalledOnce());
    first.unmount();
    const second = mount(f);
    await waitFor(() => expect(f.finish).toHaveBeenCalledTimes(2));
    expect(qualifyNir1GraphEvidence).toHaveBeenCalledTimes(2);
    expect(f.selection).toHaveBeenCalledOnce();
    second.unmount();
  });
});
