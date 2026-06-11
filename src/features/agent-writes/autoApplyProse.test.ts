import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { PendingProseProposal } from "@/features/agent-writes/proseStagingStore";

/**
 * autoApplyProseProposal builds the scene doc with a real ProseMirror schema
 * (only the DB/store boundaries are stubbed), so these tests verify the actual
 * append + `source='ai'` provenance mark — the core correctness guarantee — and
 * the mode gating / finalize ordering.
 */

const h = vi.hoisted(() => ({
  state: {
    sceneContent: "" as string,
    treeNodes: [] as Array<{ id: string; sourceUri?: string }>,
    openTabs: [] as Array<{ nodeId: string }>,
    fileBacked: false,
  },
  loadSceneContent: vi.fn(async () => h.state.sceneContent),
  saveScene: vi.fn(async (_id: string) => {}),
  persistSceneBody: vi.fn(async (_id: string, _doc: ProseMirrorNode) => {}),
  agentAcceptProseStage: vi.fn(async () => ({})),
  setLiveContent: vi.fn(),
  recordChangeEvent: vi.fn(),
}));

vi.mock("@/features/tree/api", () => ({
  loadSceneContent: h.loadSceneContent,
}));
vi.mock("@/features/editor/editorSaveRegistry", () => ({
  saveScene: h.saveScene,
}));
vi.mock("@/features/editor/persistSceneBody", () => ({
  persistSceneBody: h.persistSceneBody,
}));
vi.mock("@/features/agent-writes/prose", () => ({
  agentAcceptProseStage: h.agentAcceptProseStage,
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ nodes: h.state.treeNodes }) },
}));
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({ tabs: h.state.openTabs, secondaryTabs: [] }),
  },
}));
vi.mock("@/features/editor/sceneContentStore", () => ({
  useSceneContentStore: {
    getState: () => ({ setLiveContent: h.setLiveContent }),
  },
}));
vi.mock("@/features/external-mount/externalRootStore", () => ({
  isFileBackedNode: () => h.state.fileBacked,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: h.recordChangeEvent,
}));

import { autoApplyProseProposal } from "@/features/agent-writes/autoApplyProse";

const HELLO_DOC = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
});

function proposal(
  over: Partial<PendingProseProposal> = {},
): PendingProseProposal {
  return {
    stagingId: "stage-1",
    sceneId: "scene-1",
    text: "World",
    mode: "append",
    ...over,
  } as PendingProseProposal;
}

/** Concatenated text of all spans carrying an authorship mark with source='ai'. */
function aiMarkedText(doc: ProseMirrorNode): string {
  let out = "";
  doc.descendants((node) => {
    if (
      node.isText &&
      node.marks.some(
        (m) => m.type.name === "authorship" && m.attrs.source === "ai",
      )
    ) {
      out += node.text ?? "";
    }
  });
  return out;
}

const TWO_PARA = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "First alpha." }] },
    { type: "paragraph", content: [{ type: "text", text: "Second beta." }] },
  ],
});

/** Top-level block texts of a doc, in order. */
function blockTexts(doc: ProseMirrorNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.textContent));
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.sceneContent = HELLO_DOC;
  h.state.treeNodes = [{ id: "scene-1", sourceUri: undefined }];
  h.state.openTabs = [];
  h.state.fileBacked = false;
});

describe("autoApplyProseProposal — append", () => {
  it("appends the text and tags it source='ai'", async () => {
    const result = await autoApplyProseProposal(proposal());
    expect(result.applied).toBe(true);
    expect(h.persistSceneBody).toHaveBeenCalledTimes(1);
    const [sceneId, doc] = h.persistSceneBody.mock.calls[0];
    expect(sceneId).toBe("scene-1");
    expect(doc.textContent).toContain("World");
    expect(doc.textContent).toContain("Hello");
    // The appended text — and only the appended text — must carry source='ai'.
    expect(aiMarkedText(doc)).toBe("World");
  });

  it("records the append as a doc.step so timelapse replay stays consistent", async () => {
    await autoApplyProseProposal(proposal());
    expect(h.recordChangeEvent).toHaveBeenCalledTimes(1);
    const ev = h.recordChangeEvent.mock.calls[0][0] as {
      domain: string;
      opType: string;
      sceneId: string;
      payload: { steps: unknown[] };
    };
    expect(ev.domain).toBe("editor");
    expect(ev.opType).toBe("doc.step");
    expect(ev.sceneId).toBe("scene-1");
    expect(Array.isArray(ev.payload.steps)).toBe(true);
    expect(ev.payload.steps.length).toBeGreaterThan(0);
  });

  it("does not record a doc.step when the proposal is skipped", async () => {
    h.state.sceneContent = '{"foo":"bar"}'; // unparseable → abort
    await autoApplyProseProposal(proposal());
    expect(h.recordChangeEvent).not.toHaveBeenCalled();
  });

  it("appends to an empty scene", async () => {
    h.state.sceneContent = "";
    const result = await autoApplyProseProposal(proposal());
    expect(result.applied).toBe(true);
    const [, doc] = h.persistSceneBody.mock.calls[0];
    expect(aiMarkedText(doc)).toBe("World");
  });

  it("finalizes the staging row BEFORE writing the body (dedup ordering)", async () => {
    const order: string[] = [];
    h.agentAcceptProseStage.mockImplementation(async () => {
      order.push("accept");
      return {};
    });
    h.persistSceneBody.mockImplementation(async () => {
      order.push("persist");
    });
    await autoApplyProseProposal(proposal());
    expect(order).toEqual(["accept", "persist"]);
  });

  it("resyncs the live editor only when the scene is open", async () => {
    await autoApplyProseProposal(proposal());
    expect(h.setLiveContent).not.toHaveBeenCalled();

    h.state.openTabs = [{ nodeId: "scene-1" }];
    await autoApplyProseProposal(proposal());
    expect(h.setLiveContent).toHaveBeenCalledTimes(1);
    expect(h.setLiveContent.mock.calls[0][0]).toBe("scene-1");
  });
});

describe("autoApplyProseProposal — unsaved live-edit flush", () => {
  it("flushes the scene's pending save BEFORE reading the DB body", async () => {
    const order: string[] = [];
    h.saveScene.mockImplementationOnce(async () => {
      order.push("flush");
    });
    h.loadSceneContent.mockImplementationOnce(async () => {
      order.push("load");
      return h.state.sceneContent;
    });
    const result = await autoApplyProseProposal(proposal());
    expect(result.applied).toBe(true);
    expect(h.saveScene).toHaveBeenCalledWith("scene-1");
    expect(order).toEqual(["flush", "load"]);
  });

  it("appends onto the flushed body, not the stale DB row", async () => {
    // Simulate an open editor holding unsaved typing: the flush persists the
    // newer doc into the DB, and the append must build on THAT, not on the
    // pre-flush HELLO_DOC — otherwise the resync clobbers the user's edit.
    h.saveScene.mockImplementationOnce(async () => {
      h.state.sceneContent = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello edited" }],
          },
        ],
      });
    });
    const result = await autoApplyProseProposal(proposal());
    expect(result.applied).toBe(true);
    const [, doc] = h.persistSceneBody.mock.calls[0];
    expect(blockTexts(doc)).toEqual(["Hello edited", "World"]);
    expect(aiMarkedText(doc)).toBe("World");
  });

  it("proceeds with the DB body when no editor is mounted (no-op flush)", async () => {
    const result = await autoApplyProseProposal(proposal());
    expect(result.applied).toBe(true);
    const [, doc] = h.persistSceneBody.mock.calls[0];
    expect(blockTexts(doc)).toEqual(["Hello", "World"]);
  });

  it("does not flush proposals gated before the body read", async () => {
    h.state.fileBacked = true;
    await autoApplyProseProposal(proposal());
    expect(h.saveScene).not.toHaveBeenCalled();

    h.state.fileBacked = false;
    await autoApplyProseProposal(proposal({ text: "  " }));
    expect(h.saveScene).not.toHaveBeenCalled();
  });
});

describe("autoApplyProseProposal — anchored insert", () => {
  beforeEach(() => {
    h.state.sceneContent = TWO_PARA;
  });

  it("inserts after the anchored block", async () => {
    const result = await autoApplyProseProposal(
      proposal({
        mode: "insert",
        anchorText: "alpha",
        anchorPosition: "after",
      }),
    );
    expect(result.applied).toBe(true);
    const [, doc] = h.persistSceneBody.mock.calls[0];
    expect(blockTexts(doc)).toEqual(["First alpha.", "World", "Second beta."]);
    expect(aiMarkedText(doc)).toBe("World");
  });

  it("inserts before the anchored block", async () => {
    const result = await autoApplyProseProposal(
      proposal({
        mode: "insert",
        anchorText: "alpha",
        anchorPosition: "before",
      }),
    );
    expect(result.applied).toBe(true);
    const [, doc] = h.persistSceneBody.mock.calls[0];
    expect(blockTexts(doc)).toEqual(["World", "First alpha.", "Second beta."]);
  });

  it("defaults to inserting after when position is omitted", async () => {
    const result = await autoApplyProseProposal(
      proposal({ mode: "insert", anchorText: "beta" }),
    );
    expect(result.applied).toBe(true);
    const [, doc] = h.persistSceneBody.mock.calls[0];
    expect(blockTexts(doc)).toEqual(["First alpha.", "Second beta.", "World"]);
  });

  it("aborts when the anchor matches no block", async () => {
    const result = await autoApplyProseProposal(
      proposal({ mode: "insert", anchorText: "nonexistent" }),
    );
    expect(result).toEqual({ applied: false, reason: "anchor-not-found" });
    expect(h.persistSceneBody).not.toHaveBeenCalled();
    expect(h.agentAcceptProseStage).not.toHaveBeenCalled();
  });

  it("aborts when the anchor matches multiple blocks (ambiguous)", async () => {
    // "a" appears in both "alpha" and "beta" → 2 matches → refuse to guess.
    const result = await autoApplyProseProposal(
      proposal({ mode: "insert", anchorText: "a" }),
    );
    expect(result).toEqual({ applied: false, reason: "anchor-ambiguous" });
    expect(h.persistSceneBody).not.toHaveBeenCalled();
  });
});

describe("autoApplyProseProposal — skips", () => {
  it("leaves insert/replace proposals untouched (needs a live editor)", async () => {
    for (const mode of ["insert", "replace"] as const) {
      vi.clearAllMocks();
      const result = await autoApplyProseProposal(proposal({ mode }));
      expect(result).toEqual({ applied: false, reason: "unsupported-mode" });
      expect(h.persistSceneBody).not.toHaveBeenCalled();
      expect(h.agentAcceptProseStage).not.toHaveBeenCalled();
    }
  });

  it("skips empty text", async () => {
    const result = await autoApplyProseProposal(proposal({ text: "   " }));
    expect(result).toEqual({ applied: false, reason: "empty-text" });
    expect(h.persistSceneBody).not.toHaveBeenCalled();
  });

  it("skips a missing scene", async () => {
    h.state.treeNodes = [];
    const result = await autoApplyProseProposal(proposal());
    expect(result).toEqual({ applied: false, reason: "scene-missing" });
  });

  it("skips file-backed scenes", async () => {
    h.state.fileBacked = true;
    const result = await autoApplyProseProposal(proposal());
    expect(result).toEqual({ applied: false, reason: "file-backed" });
    expect(h.persistSceneBody).not.toHaveBeenCalled();
  });

  it("aborts (does NOT clobber) when existing content is non-empty but unparseable", async () => {
    // Valid JSON the schema rejects — building an empty doc + persisting would
    // destroy the real prose. Must leave the row untouched.
    h.state.sceneContent = '{"foo":"bar"}';
    const result = await autoApplyProseProposal(proposal());
    expect(result).toEqual({ applied: false, reason: "content-unparseable" });
    expect(h.persistSceneBody).not.toHaveBeenCalled();
    expect(h.agentAcceptProseStage).not.toHaveBeenCalled();
  });

  it("treats empty-ish content ({} / []) as a fresh doc, not a clobber risk", async () => {
    for (const empty of ["", "{}", "[]"]) {
      vi.clearAllMocks();
      h.state.sceneContent = empty;
      const result = await autoApplyProseProposal(proposal());
      expect(result.applied).toBe(true);
      expect(h.persistSceneBody).toHaveBeenCalledTimes(1);
    }
  });
});
