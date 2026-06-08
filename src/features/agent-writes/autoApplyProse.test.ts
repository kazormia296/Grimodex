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
  persistSceneBody: vi.fn(async (_id: string, _doc: ProseMirrorNode) => {}),
  agentAcceptProseStage: vi.fn(async () => ({})),
  setLiveContent: vi.fn(),
}));

vi.mock("@/features/tree/api", () => ({
  loadSceneContent: h.loadSceneContent,
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
});
