import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { BeatMention } from "@/features/editor/beat/extractBeatMentions";
import {
  getCurrentWorkspaceIdentity,
  setCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import {
  _resetSceneBodyCommitRegistryForTests,
  subscribeSceneBodyCommits,
  type SceneBodyCommitPublication,
} from "@/lib/sceneBodyCommitRegistry";

/**
 * Behavioral contract for persistSceneBody — the single source of truth for the
 * scene-body save cascade, extracted from EditorPane.coreSave so that both the
 * live editor and the off-screen agent auto-apply path run the identical
 * side-effect fan-out. These assertions pin the orchestration the headless
 * writer relies on.
 */

// vi.mock factories are hoisted above module-level consts, so all mock fns and
// the mutable mock state must live inside vi.hoisted().
const h = vi.hoisted(() => ({
  state: {
    treeNodes: [] as Array<{ id: string; sourceUri?: string }>,
    codexEntries: [] as Array<{ id: string; name?: string }>,
    activeChatSceneId: null as string | null,
    fileBacked: false,
    electron: false,
  },
  saveSceneContent: vi.fn(async () => ({
    placedBeatPreview: null,
    unplacedBeatPreview: null,
    contentVersion: 1,
    contentUpdatedAt: "2026-07-13T00:00:01.000Z",
  })),
  saveAuthorshipSpans: vi.fn(async () => {}),
  saveForeshadowAnchors: vi.fn(async () => {}),
  saveAnnotationAnchors: vi.fn(async () => {}),
  extractBeatMentions: vi.fn<(doc: ProseMirrorNode) => BeatMention[]>(() => []),
  upsertSceneBeatMentions: vi.fn<
    (sceneId: string, mentions: BeatMention[]) => Promise<void>
  >(() => Promise.resolve()),
  extractBeatPovOverrides: vi.fn<(doc: ProseMirrorNode) => string[]>(() => []),
  upsertSceneBeatPovOverrides: vi.fn<
    (sceneId: string, povs: string[]) => Promise<void>
  >(() => Promise.resolve()),
  upsertSceneBodyMentions: vi.fn(() => Promise.resolve()),
  listCodexMatchTargets: vi.fn(async () => [] as Array<{ id: string }>),
  recordBodyMentionScans: vi.fn(() => Promise.resolve()),
  scheduleSceneIndex: vi.fn(),
  scheduleWriteBack: vi.fn(),
  setCharCount: vi.fn(),
  setNodePreview: vi.fn(),
  refreshAiRatio: vi.fn(() => Promise.resolve()),
  refreshContextLayers: vi.fn(() => Promise.resolve()),
  deriveSceneBodySnapshot: vi.fn(() => ({
    contentJson: JSON.stringify({ type: "doc", content: [] }),
    charCount: 42,
    placedBeatPreview: null,
    unplacedBeatsDoc: "[]",
    unplacedBeatPreview: null,
    authorshipSpans: [],
    foreshadowSetups: [],
    foreshadowPayoffs: [],
    annotationAnchors: [],
    beatMentions: [],
    beatPovOverrides: [],
    docContentSize: 2,
  })),
  saveSceneBodyBundle: vi.fn(async () => ({
    placedBeatPreview: null,
    unplacedBeatPreview: null,
    contentVersion: 2,
    contentUpdatedAt: "2026-07-28T00:00:00.000Z",
    dbTransactionCount: 1,
  })),
  bumpMatrixDataVersion: vi.fn(),
  recordCounter: vi.fn(),
  recordSerializedByteCounter: vi.fn(),
  publishTreeNodeMutation: vi.fn(),
}));

vi.mock("@/lib/perfLog", () => ({
  markStart: vi.fn(),
  markEnd: vi.fn(),
  recordCounter: h.recordCounter,
  recordSerializedByteCounter: h.recordSerializedByteCounter,
}));
vi.mock("@/lib/debugLog", () => ({
  debugLog: { error: vi.fn(), warn: vi.fn() },
  errorDetail: (e: unknown) => e,
}));
vi.mock("@/features/editor/charCountForBody", () => ({
  countSceneBodyChars: () => 42,
}));
vi.mock("@/features/editor/beat/unplacedBeatsStore", () => ({
  useUnplacedBeatsStore: { getState: () => ({ getBeats: () => [] }) },
}));
// persistSceneBody はチェーン単位の内側で非チェーンの saveSceneContentInner を
// 呼ぶ (公開 saveSceneContent だと自己 await デッドロック)。mock fn の名前は
// 既存 assertion 互換のため h.saveSceneContent のまま。pendingSceneWrites は
// mock しない — 実チェーンで直列化契約 (I1) をテストする。
vi.mock("@/features/tree/api", () => ({
  saveSceneContentInner: h.saveSceneContent,
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      nodes: h.state.treeNodes,
      projectId: "proj-1",
      setCharCount: h.setCharCount,
      setNodePreview: h.setNodePreview,
      refreshAiRatio: h.refreshAiRatio,
    }),
  },
}));
vi.mock("@/features/external-mount/externalRootStore", () => ({
  isFileBackedNode: () => h.state.fileBacked,
}));
vi.mock("@/features/external-mount/writeBack", () => ({
  scheduleWriteBack: h.scheduleWriteBack,
}));
vi.mock("@/features/attribution/api", () => ({
  saveAuthorshipSpans: h.saveAuthorshipSpans,
}));
vi.mock("@/features/foreshadow/saveAnchors", () => ({
  saveForeshadowAnchors: h.saveForeshadowAnchors,
}));
vi.mock("@/features/post-effect/syncAnnotations", () => ({
  saveAnnotationAnchors: h.saveAnnotationAnchors,
}));
vi.mock("@/features/editor/beat/extractBeatMentions", () => ({
  extractBeatMentions: h.extractBeatMentions,
}));
vi.mock("@/features/editor/beat/mentionApi", () => ({
  upsertSceneBeatMentions: h.upsertSceneBeatMentions,
}));
vi.mock("@/features/editor/beat/extractBeatPovOverrides", () => ({
  extractBeatPovOverrides: h.extractBeatPovOverrides,
}));
vi.mock("@/features/editor/beat/beatPovCacheApi", () => ({
  upsertSceneBeatPovOverrides: h.upsertSceneBeatPovOverrides,
}));
vi.mock("@/features/editor/beat/bodyMentionApi", () => ({
  upsertSceneBodyMentions: h.upsertSceneBodyMentions,
}));
vi.mock("@/features/codex/bodyMentionIndexState", () => ({
  recordBodyMentionScans: h.recordBodyMentionScans,
}));
vi.mock("@/features/codex/api", () => ({
  listCodexMatchTargets: h.listCodexMatchTargets,
}));
vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      activeSceneId: h.state.activeChatSceneId,
      refreshContextLayers: h.refreshContextLayers,
    }),
  },
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleSceneIndex: h.scheduleSceneIndex,
}));
vi.mock("@/lib/shell", () => ({
  isElectron: () => h.state.electron,
}));
vi.mock("@/features/editor/sceneBodySnapshot", () => ({
  deriveSceneBodySnapshot: h.deriveSceneBodySnapshot,
}));
vi.mock("@/features/editor/sceneBodyBundleApi", () => ({
  saveSceneBodyBundle: h.saveSceneBodyBundle,
}));
vi.mock("@/features/matrix/matrixDataVersion", () => ({
  bumpMatrixDataVersion: h.bumpMatrixDataVersion,
}));
vi.mock("@/lib/treeNodeMutationRegistry", () => ({
  publishTreeNodeMutation: h.publishTreeNodeMutation,
}));

import {
  _resetBodyMentionScanSchedulerForTests,
  persistSceneBody,
} from "@/features/editor/persistSceneBody";
import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";

const DOC_JSON = { type: "doc", content: [] };
const fakeDoc = { toJSON: () => DOC_JSON } as unknown as ProseMirrorNode;

beforeEach(() => {
  _resetBodyMentionScanSchedulerForTests();
  _resetSceneBodyCommitRegistryForTests();
  vi.clearAllMocks();
  setCurrentWorkspaceIdentity({
    path: "/workspace/test",
    openRevision: 7,
  });
  h.listCodexMatchTargets.mockResolvedValue([]);
  h.state.treeNodes = [{ id: "scene-1", sourceUri: undefined }];
  h.state.codexEntries = [];
  h.state.activeChatSceneId = null;
  h.state.fileBacked = false;
  h.state.electron = false;
});

afterEach(() => {
  setCurrentWorkspaceIdentity(null);
  _resetSceneBodyCommitRegistryForTests();
});

describe("persistSceneBody — committed-body publication", () => {
  it("publishes the exact scope immediately after content commit even if a later side effect fails", async () => {
    const publications: SceneBodyCommitPublication[] = [];
    const unsubscribe = subscribeSceneBodyCommits((publication) => {
      publications.push(publication);
    });
    h.saveAuthorshipSpans.mockRejectedValueOnce(
      new Error("authorship side effect failed"),
    );

    await expect(persistSceneBody("scene-1", fakeDoc)).rejects.toThrow(
      "authorship side effect failed",
    );

    expect(getCurrentWorkspaceIdentity()).toEqual({
      path: "/workspace/test",
      openRevision: 7,
    });
    expect(publications).toEqual([
      {
        workspacePath: "/workspace/test",
        openRevision: 7,
        projectId: "proj-1",
        sceneId: "scene-1",
        contentVersion: 1,
      },
    ]);
    unsubscribe();
  });
});

describe("persistSceneBody — DB-native scene", () => {
  it("Electron uses one derived snapshot and one domain IPC for content + sidecars", async () => {
    h.state.electron = true;

    await persistSceneBody("scene-1", fakeDoc);

    expect(h.deriveSceneBodySnapshot).toHaveBeenCalledWith(fakeDoc, [], true);
    expect(h.saveSceneBodyBundle).toHaveBeenCalledTimes(1);
    expect(h.saveSceneBodyBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneId: "scene-1",
        projectId: "proj-1",
        includeSidecars: true,
        contentJson: JSON.stringify(DOC_JSON),
        charCount: 42,
      }),
    );
    expect(h.saveSceneContent).not.toHaveBeenCalled();
    expect(h.saveAuthorshipSpans).not.toHaveBeenCalled();
    expect(h.saveForeshadowAnchors).not.toHaveBeenCalled();
    expect(h.saveAnnotationAnchors).not.toHaveBeenCalled();
    expect(h.upsertSceneBeatMentions).not.toHaveBeenCalled();
    expect(h.upsertSceneBeatPovOverrides).not.toHaveBeenCalled();
    expect(h.bumpMatrixDataVersion).toHaveBeenCalledTimes(1);
    expect(h.recordCounter).toHaveBeenCalledWith("editor.coreSave.domainIpc");
    expect(h.recordCounter).toHaveBeenCalledWith(
      "editor.coreSave.dbTransaction",
      1,
    );
    expect(h.publishTreeNodeMutation).toHaveBeenCalledWith({
      workspacePath: "/workspace/test",
      workspaceOpenRevision: 7,
      projectId: "proj-1",
      nodeId: "scene-1",
      updatedAt: "2026-07-28T00:00:00.000Z",
    });
  });

  it("saves content with serialized doc JSON + char count", async () => {
    await persistSceneBody("scene-1", fakeDoc);
    expect(h.saveSceneContent).toHaveBeenCalledTimes(1);
    expect(h.saveSceneContent).toHaveBeenCalledWith("scene-1", {
      content: JSON.stringify(DOC_JSON),
      unplacedBeatsDoc: "[]",
      charCount: 42,
    });
    expect(h.publishTreeNodeMutation).not.toHaveBeenCalled();
  });

  it("records the serialized scene payload as UTF-8 bytes", async () => {
    const localizedJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "日本語の本文" }],
        },
      ],
    };
    const serialized = JSON.stringify(localizedJson);

    await persistSceneBody("scene-1", {
      toJSON: () => localizedJson,
    } as unknown as ProseMirrorNode);

    expect(h.recordSerializedByteCounter).toHaveBeenCalledWith(
      "editor.coreSave.serializeBytes",
      serialized,
    );
  });

  it("reuses the save serialization for deferred body mention indexing", async () => {
    const toJSON = vi.fn(() => DOC_JSON);
    h.state.codexEntries = [{ id: "codex-1" }];
    h.listCodexMatchTargets.mockResolvedValue(h.state.codexEntries);

    await persistSceneBody("scene-1", {
      toJSON,
    } as unknown as ProseMirrorNode);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(h.upsertSceneBodyMentions).toHaveBeenCalledWith(
      "scene-1",
      JSON.stringify(DOC_JSON),
      h.state.codexEntries,
    );
    expect(h.recordBodyMentionScans).toHaveBeenCalledWith(
      "proj-1",
      h.state.codexEntries,
      [
        {
          sceneId: "scene-1",
          version: 1,
          updatedAt: "2026-07-13T00:00:01.000Z",
        },
      ],
    );
  });

  it("coalesces deferred body mention scans to the latest saved document", async () => {
    h.state.codexEntries = [{ id: "codex-1" }];
    h.listCodexMatchTargets.mockResolvedValue(h.state.codexEntries);
    const firstDoc = {
      toJSON: () => ({ type: "doc", content: [{ text: "first" }] }),
    } as unknown as ProseMirrorNode;
    const secondDoc = {
      toJSON: () => ({ type: "doc", content: [{ text: "second" }] }),
    } as unknown as ProseMirrorNode;

    await Promise.all([
      persistSceneBody("scene-1", firstDoc),
      persistSceneBody("scene-1", secondDoc),
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(h.upsertSceneBodyMentions).toHaveBeenCalledTimes(1);
    expect(h.upsertSceneBodyMentions).toHaveBeenCalledWith(
      "scene-1",
      JSON.stringify({ type: "doc", content: [{ text: "second" }] }),
      h.state.codexEntries,
    );
  });

  it("strict quiescence drains a deferred body mention scan before scope replacement", async () => {
    h.state.codexEntries = [{ id: "codex-1" }];
    h.listCodexMatchTargets.mockResolvedValue(h.state.codexEntries);
    let releaseUpsert!: () => void;
    h.upsertSceneBodyMentions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUpsert = resolve;
        }),
    );

    await persistSceneBody("scene-1", fakeDoc);
    const flushing = flushQuiescenceProviderStage("scoped-mutations");
    await vi.waitFor(() => {
      expect(h.upsertSceneBodyMentions).toHaveBeenCalledTimes(1);
    });
    let settled = false;
    void flushing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseUpsert();
    await expect(flushing).resolves.toBeUndefined();
    expect(h.recordBodyMentionScans).toHaveBeenCalledTimes(1);
  });

  it("drops a deferred body mention scan after its Workspace authority changes", async () => {
    h.state.codexEntries = [{ id: "codex-1" }];
    h.listCodexMatchTargets.mockResolvedValue(h.state.codexEntries);

    await persistSceneBody("scene-1", fakeDoc);
    setCurrentWorkspaceIdentity({
      path: "/workspace/replacement",
      openRevision: 8,
    });
    await flushQuiescenceProviderStage("scoped-mutations");

    expect(h.listCodexMatchTargets).not.toHaveBeenCalled();
    expect(h.upsertSceneBodyMentions).not.toHaveBeenCalled();
    expect(h.recordBodyMentionScans).not.toHaveBeenCalled();
  });

  it("skips body parsing and scan-state writes when the project has no match targets", async () => {
    await persistSceneBody("scene-1", fakeDoc);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(h.listCodexMatchTargets).toHaveBeenCalledWith("proj-1");
    expect(h.upsertSceneBodyMentions).not.toHaveBeenCalled();
    expect(h.recordBodyMentionScans).not.toHaveBeenCalled();
  });

  it("uses the complete project target set even while panel entries are filtered", async () => {
    const character = { id: "character-a", name: "太郎" };
    const location = { id: "location-b", name: "東京" };
    h.state.codexEntries = [character];
    h.listCodexMatchTargets.mockResolvedValue([character, location]);

    await persistSceneBody("scene-1", fakeDoc);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(h.upsertSceneBodyMentions).toHaveBeenCalledWith(
      "scene-1",
      JSON.stringify(DOC_JSON),
      [character, location],
    );
  });

  it("runs the schema-dependent anchor/provenance cascade against the doc", async () => {
    await persistSceneBody("scene-1", fakeDoc);
    expect(h.saveAuthorshipSpans).toHaveBeenCalledWith("scene-1", fakeDoc);
    expect(h.saveForeshadowAnchors).toHaveBeenCalledWith("scene-1", fakeDoc);
    expect(h.saveAnnotationAnchors).toHaveBeenCalledWith(
      "proj-1",
      "scene-1",
      fakeDoc,
    );
    expect(h.setNodePreview).toHaveBeenCalled();
    expect(h.refreshAiRatio).toHaveBeenCalledWith("scene-1");
    expect(h.scheduleSceneIndex).toHaveBeenCalledWith("scene-1");
  });

  it("does not take the file-backed write-back path", async () => {
    await persistSceneBody("scene-1", fakeDoc);
    expect(h.scheduleWriteBack).not.toHaveBeenCalled();
  });

  it("refreshes chat context layers only when the scene is the active chat scene", async () => {
    await persistSceneBody("scene-1", fakeDoc);
    expect(h.refreshContextLayers).not.toHaveBeenCalled();
    h.state.activeChatSceneId = "scene-1";
    await persistSceneBody("scene-1", fakeDoc);
    expect(h.refreshContextLayers).toHaveBeenCalledTimes(1);
  });
});

describe("persistSceneBody — file-backed scene", () => {
  beforeEach(() => {
    h.state.treeNodes = [{ id: "scene-1", sourceUri: "file:///x.md" }];
    h.state.fileBacked = true;
  });

  it("schedules write-back and char count, then short-circuits the schema cascade", async () => {
    await persistSceneBody("scene-1", fakeDoc);
    expect(h.saveSceneContent).toHaveBeenCalledTimes(1);
    expect(h.scheduleWriteBack).toHaveBeenCalledWith(
      "scene-1",
      "file:///x.md",
      JSON.stringify(DOC_JSON),
    );
    expect(h.setCharCount).toHaveBeenCalledWith("scene-1", 42);
    expect(h.scheduleSceneIndex).toHaveBeenCalledWith("scene-1");
    // schema-dependent side-effects are intentionally skipped for file-backed
    expect(h.saveAuthorshipSpans).not.toHaveBeenCalled();
    expect(h.saveForeshadowAnchors).not.toHaveBeenCalled();
    expect(h.saveAnnotationAnchors).not.toHaveBeenCalled();
  });

  it("uses the Electron bundle without sidecars and preserves write-back", async () => {
    h.state.electron = true;

    await persistSceneBody("scene-1", fakeDoc);

    expect(h.deriveSceneBodySnapshot).toHaveBeenCalledWith(fakeDoc, [], false);
    expect(h.saveSceneBodyBundle).toHaveBeenCalledTimes(1);
    expect(h.saveSceneBodyBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneId: "scene-1",
        includeSidecars: false,
      }),
    );
    expect(h.saveSceneContent).not.toHaveBeenCalled();
    expect(h.bumpMatrixDataVersion).not.toHaveBeenCalled();
    expect(h.scheduleWriteBack).toHaveBeenCalledWith(
      "scene-1",
      "file:///x.md",
      JSON.stringify(DOC_JSON),
    );
  });
});

describe("persistSceneBody — write-write serialization (M3 review I1)", () => {
  const flushTasks = () => new Promise<void>((r) => setTimeout(r, 0));

  it("並行 persist は content+cascade の単一チェーン単位で直列化される", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    let call = 0;
    // A の content 書き込みを人工的に遅延させ、B を即時にする。チェーンが
    // 無ければ B の content/spans が A の cascade を追い越して
    // 「新 content + 旧 spans」で確定しうる。
    h.saveSceneContent
      .mockImplementationOnce(async () => {
        call = 1;
        order.push("content_A");
        await gateA;
        return {
          placedBeatPreview: null,
          unplacedBeatPreview: null,
          contentVersion: 1,
          contentUpdatedAt: "2026-07-13T00:00:01.000Z",
        };
      })
      .mockImplementationOnce(async () => {
        call = 2;
        order.push("content_B");
        return {
          placedBeatPreview: null,
          unplacedBeatPreview: null,
          contentVersion: 2,
          contentUpdatedAt: "2026-07-13T00:00:02.000Z",
        };
      });
    h.saveAuthorshipSpans
      .mockImplementationOnce(async () => {
        order.push(`spans_${call === 1 ? "A" : "B"}`);
      })
      .mockImplementationOnce(async () => {
        order.push(`spans_${call === 1 ? "A" : "B"}`);
      });

    const pA = persistSceneBody("scene-1", fakeDoc);
    const pB = persistSceneBody("scene-1", fakeDoc);

    await flushTasks();
    // B は A のチェーン単位 (content + cascade) 完了まで開始しない
    expect(order).toEqual(["content_A"]);

    releaseA();
    await Promise.all([pA, pB]);
    expect(order).toEqual(["content_A", "spans_A", "content_B", "spans_B"]);
  });

  it("古い保存の Beat mention / POV cache が完了するまで後続保存を開始しない", async () => {
    const mentionsA = [
      { beatId: "beat-a", codexId: "codex-a", role: "actor" as const },
    ];
    const mentionsB = [
      { beatId: "beat-b", codexId: "codex-b", role: "target" as const },
    ];
    const povsA = ["character-a"];
    const povsB = ["character-b"];
    const docA = {
      toJSON: () => ({ type: "doc", content: [{ text: "first" }] }),
    } as unknown as ProseMirrorNode;
    const docB = {
      toJSON: () => ({ type: "doc", content: [{ text: "second" }] }),
    } as unknown as ProseMirrorNode;
    h.extractBeatMentions.mockImplementation((doc) =>
      doc === docA ? mentionsA : mentionsB,
    );
    h.extractBeatPovOverrides.mockImplementation((doc) =>
      doc === docA ? povsA : povsB,
    );

    let releaseMentionA!: () => void;
    const mentionGateA = new Promise<void>((resolve) => {
      releaseMentionA = resolve;
    });
    let releasePovA!: () => void;
    const povGateA = new Promise<void>((resolve) => {
      releasePovA = resolve;
    });
    let mentionHead: BeatMention[] = [];
    let povHead: string[] = [];
    const order: string[] = [];

    h.saveSceneContent
      .mockImplementationOnce(async () => {
        order.push("content_A");
        return {
          placedBeatPreview: null,
          unplacedBeatPreview: null,
          contentVersion: 1,
          contentUpdatedAt: "2026-07-13T00:00:01.000Z",
        };
      })
      .mockImplementationOnce(async () => {
        order.push("content_B");
        return {
          placedBeatPreview: null,
          unplacedBeatPreview: null,
          contentVersion: 2,
          contentUpdatedAt: "2026-07-13T00:00:02.000Z",
        };
      });
    h.upsertSceneBeatMentions
      .mockImplementationOnce(async (_sceneId, mentions) => {
        order.push("mentions_A:start");
        await mentionGateA;
        mentionHead = mentions;
        order.push("mentions_A:end");
      })
      .mockImplementationOnce(async (_sceneId, mentions) => {
        mentionHead = mentions;
        order.push("mentions_B");
      });
    h.upsertSceneBeatPovOverrides
      .mockImplementationOnce(async (_sceneId, povs) => {
        order.push("pov_A:start");
        await povGateA;
        povHead = povs;
        order.push("pov_A:end");
      })
      .mockImplementationOnce(async (_sceneId, povs) => {
        povHead = povs;
        order.push("pov_B");
      });

    const saveA = persistSceneBody("scene-1", docA);
    const saveB = persistSceneBody("scene-1", docB);

    await flushTasks();
    expect(order).toEqual(["content_A", "mentions_A:start"]);
    expect(h.saveSceneContent).toHaveBeenCalledTimes(1);

    releaseMentionA();
    await flushTasks();
    expect(order).toEqual([
      "content_A",
      "mentions_A:start",
      "mentions_A:end",
      "pov_A:start",
    ]);
    expect(h.saveSceneContent).toHaveBeenCalledTimes(1);

    releasePovA();
    await Promise.all([saveA, saveB]);

    expect(order).toEqual([
      "content_A",
      "mentions_A:start",
      "mentions_A:end",
      "pov_A:start",
      "pov_A:end",
      "content_B",
      "mentions_B",
      "pov_B",
    ]);
    expect(mentionHead).toEqual(mentionsB);
    expect(povHead).toEqual(povsB);
  });
});
