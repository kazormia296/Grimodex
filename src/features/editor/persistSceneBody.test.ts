import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

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
    codexEntries: [] as unknown[],
    activeChatSceneId: null as string | null,
    fileBacked: false,
  },
  saveSceneContent: vi.fn(async () => ({
    placedBeatPreview: null,
    unplacedBeatPreview: null,
  })),
  saveAuthorshipSpans: vi.fn(async () => {}),
  saveForeshadowAnchors: vi.fn(async () => {}),
  saveAnnotationAnchors: vi.fn(async () => {}),
  upsertSceneBeatMentions: vi.fn(() => Promise.resolve()),
  upsertSceneBeatPovOverrides: vi.fn(() => Promise.resolve()),
  upsertSceneBodyMentions: vi.fn(() => Promise.resolve()),
  scheduleSceneIndex: vi.fn(),
  scheduleWriteBack: vi.fn(),
  setCharCount: vi.fn(),
  setNodePreview: vi.fn(),
  refreshAiRatio: vi.fn(() => Promise.resolve()),
  refreshContextLayers: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/perfLog", () => ({ markStart: vi.fn(), markEnd: vi.fn() }));
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
  extractBeatMentions: () => [],
}));
vi.mock("@/features/editor/beat/mentionApi", () => ({
  upsertSceneBeatMentions: h.upsertSceneBeatMentions,
}));
vi.mock("@/features/editor/beat/extractBeatPovOverrides", () => ({
  extractBeatPovOverrides: () => [],
}));
vi.mock("@/features/editor/beat/beatPovCacheApi", () => ({
  upsertSceneBeatPovOverrides: h.upsertSceneBeatPovOverrides,
}));
vi.mock("@/features/editor/beat/bodyMentionApi", () => ({
  upsertSceneBodyMentions: h.upsertSceneBodyMentions,
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: () => ({ entries: h.state.codexEntries }) },
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

import { persistSceneBody } from "@/features/editor/persistSceneBody";

const DOC_JSON = { type: "doc", content: [] };
const fakeDoc = { toJSON: () => DOC_JSON } as unknown as ProseMirrorNode;

beforeEach(() => {
  vi.clearAllMocks();
  h.state.treeNodes = [{ id: "scene-1", sourceUri: undefined }];
  h.state.codexEntries = [];
  h.state.activeChatSceneId = null;
  h.state.fileBacked = false;
});

describe("persistSceneBody — DB-native scene", () => {
  it("saves content with serialized doc JSON + char count", async () => {
    await persistSceneBody("scene-1", fakeDoc);
    expect(h.saveSceneContent).toHaveBeenCalledTimes(1);
    expect(h.saveSceneContent).toHaveBeenCalledWith("scene-1", {
      content: JSON.stringify(DOC_JSON),
      unplacedBeatsDoc: "[]",
      charCount: 42,
    });
  });

  it("reuses the save serialization for deferred body mention indexing", async () => {
    const toJSON = vi.fn(() => DOC_JSON);
    h.state.codexEntries = [{ id: "codex-1" }];

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
  });

  it("coalesces deferred body mention scans to the latest saved document", async () => {
    h.state.codexEntries = [{ id: "codex-1" }];
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
        return { placedBeatPreview: null, unplacedBeatPreview: null };
      })
      .mockImplementationOnce(async () => {
        call = 2;
        order.push("content_B");
        return { placedBeatPreview: null, unplacedBeatPreview: null };
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
});
