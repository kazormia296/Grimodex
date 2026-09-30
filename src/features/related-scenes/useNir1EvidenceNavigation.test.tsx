// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { encodeDocumentKey } from "@/features/editor/document/documentKey";
import type { Nir1EvidenceEditorState } from "./nir1EvidenceNavigationState";
import { serializeProseMirrorDocument } from "@/features/narrative-extraction/source/proseMirrorSerializer";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import { CANONICAL_TEXT_NORMALIZER_VERSION } from "@/features/narrative-extraction/source/types";

vi.mock("./nir1EvidenceNavigation", () => ({
  claimNir1EvidenceNavigation: vi.fn(),
  subscribeNir1EvidenceNavigation: vi.fn(() => () => {}),
}));
vi.mock("./nir1RelatedScenesApi", () => ({ qualifyNir1Evidence: vi.fn() }));
import { claimNir1EvidenceNavigation } from "./nir1EvidenceNavigation";
import { qualifyNir1Evidence } from "./nir1RelatedScenesApi";
import { useNir1EvidenceNavigation } from "./useNir1EvidenceNavigation";

function fixture(texts: string[]) {
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
  let current = true;
  vi.mocked(claimNir1EvidenceNavigation)
    .mockReturnValueOnce({
      identity: "evidence",
      queryBinding: "query",
      sceneId: "s1",
      isCurrent: () => current,
      finish,
    })
    .mockReturnValue(null);
  return {
    document,
    editor,
    selection,
    finish,
    invalidate: () => {
      current = false;
    },
    getState: () => state,
    setState: (next: Partial<Nir1EvidenceEditorState>) => {
      state = { ...state, ...next };
    },
  };
}
async function qualified(document: unknown, quote: string) {
  const serialized = serializeProseMirrorDocument(
    JSON.stringify(document),
    "database",
  );
  if (!serialized.ok) throw new Error("fixture serialization");
  const start = serialized.canonical.text.indexOf(quote);
  return {
    status: "qualified" as const,
    bindingKey: "evidence",
    queryBinding: "query",
    sceneId: "s1",
    sourceVersion: 3,
    storageDigest: "sha256:saved-source",
    canonicalTextDigest: await sha256Digest(serialized.canonical.text),
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    fullQuote: quote,
    canonicalRange: { start, end: start + quote.length },
  };
}
beforeEach(() => vi.clearAllMocks());

describe("NIR Evidence editor consumer", () => {
  it.each(["query", "unmount", "destroyed"])(
    "does not qualify or select when %s cancels while the resolver is loading",
    async (change) => {
      const f = fixture(["full evidence quote"]);
      const hook = renderHook(() =>
        useNir1EvidenceNavigation({
          editor: f.editor,
          sceneId: "s1",
          ready: true,
          captureState: f.getState,
          beforeSelection: vi.fn(),
        }),
      );
      expect(qualifyNir1Evidence).not.toHaveBeenCalled();
      if (change === "query") f.invalidate();
      else if (change === "unmount") hook.unmount();
      else Object.assign(f.editor, { isDestroyed: true });
      await waitFor(() => expect(f.finish).toHaveBeenCalledOnce());
      expect(qualifyNir1Evidence).not.toHaveBeenCalled();
      expect(f.selection).not.toHaveBeenCalled();
      hook.unmount();
    },
  );

  it.each([false, true])(
    "consumes after an editor becomes ready (initial ready=%s) and selects the full later quote",
    async (initialReady) => {
      const prefix = "A".repeat(70);
      const quote = prefix + " exact ending";
      const f = fixture([prefix + " different ending", quote]);
      vi.mocked(qualifyNir1Evidence).mockResolvedValue(
        await qualified(f.document, quote),
      );
      const beforeSelection = vi.fn();
      const hook = renderHook(
        ({ ready }) =>
          useNir1EvidenceNavigation({
            editor: f.editor,
            sceneId: "s1",
            ready,
            captureState: f.getState,
            beforeSelection,
          }),
        { initialProps: { ready: initialReady } },
      );
      if (!initialReady) {
        expect(f.selection).not.toHaveBeenCalled();
        hook.rerender({ ready: true });
      }
      await waitFor(() => expect(f.selection).toHaveBeenCalledOnce());
      expect(f.selection).toHaveBeenCalledWith({
        from: prefix.length + " different ending".length + 3,
        to: prefix.length + " different ending".length + 3 + quote.length,
      });
      expect(beforeSelection).toHaveBeenCalledOnce();
      expect(f.finish).toHaveBeenCalledOnce();
      hook.unmount();
    },
  );

  it.each(
    ["dirty", "saved", "reload"].flatMap((kind) =>
      ["resolver", "qualification"].map((pendingStage) => ({
        kind,
        pendingStage,
      })),
    ),
  )(
    "does not select if $kind changes while $pendingStage is pending",
    async ({ kind, pendingStage }) => {
      const f = fixture(["full evidence quote"]);
      let resolve!: (value: Awaited<ReturnType<typeof qualified>>) => void;
      vi.mocked(qualifyNir1Evidence).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const value = await qualified(f.document, "full evidence quote");
      const hook = renderHook(() =>
        useNir1EvidenceNavigation({
          editor: f.editor,
          sceneId: "s1",
          ready: true,
          captureState: f.getState,
          beforeSelection: vi.fn(),
        }),
      );
      if (pendingStage === "qualification")
        await waitFor(() => expect(qualifyNir1Evidence).toHaveBeenCalledOnce());
      else expect(qualifyNir1Evidence).not.toHaveBeenCalled();
      if (kind === "dirty") f.setState({ isDirty: true });
      else if (kind === "saved")
        f.setState({
          saveSnapshot: {
            binding: {
              ...f.getState().saveSnapshot!.binding,
              loadedVersion: 4,
            },
            editGeneration: 1,
          },
        });
      else f.setState({ loadToken: {} });
      await act(async () => resolve(value));
      await waitFor(() => expect(f.finish).toHaveBeenCalledOnce());
      expect(f.selection).not.toHaveBeenCalled();
      hook.unmount();
    },
  );

  it("keeps duplicate full quotes scene-only", async () => {
    const f = fixture(["same full quote", "same full quote"]);
    vi.mocked(qualifyNir1Evidence).mockResolvedValue(
      await qualified(f.document, "same full quote"),
    );
    const hook = renderHook(() =>
      useNir1EvidenceNavigation({
        editor: f.editor,
        sceneId: "s1",
        ready: true,
        captureState: f.getState,
        beforeSelection: vi.fn(),
      }),
    );
    await waitFor(() => expect(f.finish).toHaveBeenCalledOnce());
    expect(f.selection).not.toHaveBeenCalled();
    hook.unmount();
  });
});
