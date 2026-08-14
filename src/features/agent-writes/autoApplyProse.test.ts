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
    sceneVersion: 0 as number,
    treeNodes: [] as Array<{ id: string; sourceUri?: string }>,
    liveSubscribers: [] as string[],
    fileBacked: false,
  },
  loadSceneContent: vi.fn(async () => h.state.sceneContent),
  getSceneVersion: vi.fn(async () => h.state.sceneVersion),
  saveScene: vi.fn(async (_id: string) => {}),
  persistSceneBody: vi.fn(
    async (
      _id: string,
      _doc: ProseMirrorNode,
      _options?: {
        origin?: "human" | "ai-apply";
        timelapseSteps?: readonly unknown[];
      },
    ) => {},
  ),
  agentAcceptProseStage: vi.fn(async () => ({})),
  setLiveContent: vi.fn(),
}));

vi.mock("@/features/tree/api", () => ({
  loadSceneContent: h.loadSceneContent,
  getSceneVersion: h.getSceneVersion,
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
vi.mock("@/features/editor/sceneContentStore", () => ({
  useSceneContentStore: {
    getState: () => ({ setLiveContent: h.setLiveContent }),
  },
  hasLiveContentSubscriber: (document: string | { kind: string; id: string }) =>
    h.state.liveSubscribers.includes(
      typeof document === "string" ? document : document.id,
    ),
}));
vi.mock("@/features/external-mount/externalRootStore", () => ({
  isFileBackedNode: () => h.state.fileBacked,
}));
import { autoApplyProseProposal } from "@/features/agent-writes/autoApplyProse";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";

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
  h.state.sceneVersion = 0;
  h.state.treeNodes = [{ id: "scene-1", sourceUri: undefined }];
  h.state.liveSubscribers = [];
  h.state.fileBacked = false;
  useExternalWriteStore.getState().clear();
});

describe("autoApplyProseProposal — append", () => {
  it("appends the text and tags it source='ai'", async () => {
    const result = await autoApplyProseProposal(proposal());
    expect(result.applied).toBe(true);
    expect(h.persistSceneBody).toHaveBeenCalledTimes(1);
    const [sceneId, doc, options] = h.persistSceneBody.mock.calls[0];
    expect(sceneId).toBe("scene-1");
    expect(options).toEqual({
      origin: "ai-apply",
      timelapseSteps: expect.arrayContaining([expect.any(Object)]),
    });
    expect(doc.textContent).toContain("World");
    expect(doc.textContent).toContain("Hello");
    // The appended text — and only the appended text — must carry source='ai'.
    expect(aiMarkedText(doc)).toBe("World");
  });

  it("passes replay steps to the atomic Native scene-body write", async () => {
    await autoApplyProseProposal(proposal());
    const options = h.persistSceneBody.mock.calls[0]?.[2];
    expect(options?.timelapseSteps).toEqual(
      expect.arrayContaining([expect.any(Object)]),
    );
  });

  it("does not persist replay steps when the proposal is skipped", async () => {
    h.state.sceneContent = '{"foo":"bar"}'; // unparseable → abort
    await autoApplyProseProposal(proposal());
    expect(h.persistSceneBody).not.toHaveBeenCalled();
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

  it("resyncs only when a live editor subscribes (tab pane or linear block)", async () => {
    await autoApplyProseProposal(proposal());
    expect(h.setLiveContent).not.toHaveBeenCalled();

    // タブ/リニアを問わず「購読している live editor がいる」ことが条件。
    h.state.liveSubscribers = ["scene-1"];
    await autoApplyProseProposal(proposal());
    expect(h.setLiveContent).toHaveBeenCalledTimes(1);
    expect(h.setLiveContent.mock.calls[0][0]).toEqual({
      kind: "tree",
      id: "scene-1",
      storage: "database",
    });
  });
});

describe("autoApplyProseProposal — authority", () => {
  it("rechecks authority after the editor flush before reading or writing", async () => {
    let releaseSave!: () => void;
    h.saveScene.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    let authoritative = true;

    const applying = autoApplyProseProposal(proposal(), () => authoritative);
    await vi.waitFor(() => expect(h.saveScene).toHaveBeenCalledOnce());
    authoritative = false;
    releaseSave();

    await expect(applying).resolves.toEqual({
      applied: false,
      reason: "authority-changed",
    });
    expect(h.loadSceneContent).not.toHaveBeenCalled();
    expect(h.agentAcceptProseStage).not.toHaveBeenCalled();
    expect(h.persistSceneBody).not.toHaveBeenCalled();
  });

  it("rechecks authority immediately before the scene-body write", async () => {
    let releaseAccept!: () => void;
    h.agentAcceptProseStage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAccept = () => resolve({});
        }),
    );
    let authoritative = true;

    const applying = autoApplyProseProposal(proposal(), () => authoritative);
    await vi.waitFor(() =>
      expect(h.agentAcceptProseStage).toHaveBeenCalledOnce(),
    );
    authoritative = false;
    releaseAccept();

    await expect(applying).resolves.toEqual({
      applied: false,
      reason: "authority-changed",
    });
    expect(h.persistSceneBody).not.toHaveBeenCalled();
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

describe("autoApplyProseProposal — stale base_version 検知", () => {
  it("baseVersion 不一致 → 適用せず proposed のまま残し conflict を surface する", async () => {
    h.state.sceneVersion = 3; // propose (base=1) の後に本文が保存され version が進んだ
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await autoApplyProseProposal(proposal({ baseVersion: 1 }));
      expect(result).toEqual({
        applied: false,
        reason: "stale-base-version",
      });
      // 適用も finalize もしない (row は `proposed` のまま → 手動レビューへ)
      expect(h.agentAcceptProseStage).not.toHaveBeenCalled();
      expect(h.persistSceneBody).not.toHaveBeenCalled();
      // 既存の scene 用 conflict 導線 (ExternalEditConflictBanner) に流す
      expect(useExternalWriteStore.getState().conflicts).toEqual([
        {
          documentKey: {
            kind: "tree",
            id: "scene-1",
            storage: "database",
          },
          sceneId: "scene-1",
          domain: "prose",
          opType: "prose.stale",
          entityId: "stage-1",
        },
      ]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("baseVersion 一致 → 従来通り適用する", async () => {
    h.state.sceneVersion = 2;
    const result = await autoApplyProseProposal(proposal({ baseVersion: 2 }));
    expect(result.applied).toBe(true);
    expect(h.persistSceneBody).toHaveBeenCalledTimes(1);
    expect(useExternalWriteStore.getState().conflicts).toEqual([]);
  });

  it("version の読み取りは flush → loadSceneContent の後 (直前の flush 分も検知)", async () => {
    const order: string[] = [];
    h.saveScene.mockImplementationOnce(async () => {
      order.push("flush");
    });
    h.loadSceneContent.mockImplementationOnce(async () => {
      order.push("load");
      return h.state.sceneContent;
    });
    h.getSceneVersion.mockImplementationOnce(async () => {
      order.push("version");
      return 0;
    });
    await autoApplyProseProposal(proposal({ baseVersion: 0 }));
    expect(order).toEqual(["flush", "load", "version"]);
  });

  it("baseVersion 未指定 (DB 由来でない proposal) → 比較せず従来動作", async () => {
    h.state.sceneVersion = 99;
    const result = await autoApplyProseProposal(proposal());
    expect(result.applied).toBe(true);
    expect(h.getSceneVersion).not.toHaveBeenCalled();
  });
});

describe("autoApplyProseProposal — open editor (dirty ゲート付き flush との協調)", () => {
  // saveScene() の外部 flush は dirty ゲート付き (editorSaveRegistry の
  // dirtyGatedSaveHandler)。externalWriteFeed の既存ポリシー
  // 「dirty なら conflict / clean なら自動反映」と揃える。
  it("clean な open editor: flush は no-op → version 不変 → 自動適用 + live resync", async () => {
    h.state.liveSubscribers = ["scene-1"];
    h.state.sceneVersion = 2;
    const result = await autoApplyProseProposal(proposal({ baseVersion: 2 }));
    expect(result.applied).toBe(true);
    expect(h.persistSceneBody).toHaveBeenCalledTimes(1);
    expect(h.setLiveContent).toHaveBeenCalledTimes(1);
    expect(h.setLiveContent.mock.calls[0][0]).toEqual({
      kind: "tree",
      id: "scene-1",
      storage: "database",
    });
  });

  it("dirty な open editor: flush が保存 + bump → stale ブロック → 手動レビューへ", async () => {
    h.state.liveSubscribers = ["scene-1"];
    h.state.sceneVersion = 2;
    h.saveScene.mockImplementationOnce(async () => {
      // dirty flush = 実保存 → saveSceneContent が version を bump する
      h.state.sceneVersion += 1;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await autoApplyProseProposal(proposal({ baseVersion: 2 }));
      expect(result).toEqual({ applied: false, reason: "stale-base-version" });
      expect(h.persistSceneBody).not.toHaveBeenCalled();
      expect(h.setLiveContent).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
