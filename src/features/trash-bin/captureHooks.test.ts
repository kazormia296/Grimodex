import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureCodexDeletion,
  captureForeshadowDeletion,
  captureSceneDeletion,
  captureSnippetDeletion,
} from "./captureHooks";
import { useTrashBinStore } from "./trashBinStore";
import type { CodexEntry } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import type { TreeNode } from "@/features/tree/api";
import type { ForeshadowRow } from "@/features/foreshadow/types";
import type {
  CodexEntryPayload,
  ForeshadowPayload,
  ScenePayload,
  SnippetPayload,
} from "./types";

const enqueueSpy = vi.fn();

beforeEach(() => {
  enqueueSpy.mockReset();
  vi.spyOn(useTrashBinStore, "getState").mockReturnValue({
    enqueuePending: enqueueSpy,
    // 他のフィールドは captureHooks では参照しないので unknown でキャスト
  } as unknown as ReturnType<typeof useTrashBinStore.getState>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeNode(over: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "node-1",
    projectId: "p",
    parentId: "folder-1",
    nodeType: "scene",
    title: "夜の散歩",
    synopsis: null,
    sortOrder: "a0",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    status: "draft",
    content: "{}",
    unplacedBeatsDoc: "[]",
    charCount: 120,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as TreeNode;
}

function makeCodex(over: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id: "cx-1",
    projectId: "p",
    parentId: null,
    type: "character",
    name: "ミレー",
    aliases: null,
    excludedAliases: null,
    summary: "村の少女",
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as CodexEntry;
}

function makeSnippet(over: Partial<Snippet> = {}): Snippet {
  return {
    id: "sn-1",
    projectId: "p",
    title: "メモ",
    content: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "snippet 本文" }],
        },
      ],
    }),
    tagsCache: null,
    contentSource: null,
    sceneId: null,
    sourceChatMessageId: null,
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as Snippet;
}

describe("captureSceneDeletion", () => {
  const bodyDoc = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "本文サンプル" }],
      },
    ],
  });

  it("ScenePayload を組み立てて enqueuePending を呼ぶ", () => {
    const node = makeNode();
    captureSceneDeletion({
      projectId: "p",
      node,
      content: bodyDoc,
      folderHintName: "Chapter 1",
      tempId: "tmp-1",
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const [input, options] = enqueueSpy.mock.calls[0];
    expect(input.kind).toBe("structure-item");
    expect(input.subKind).toBe("scene");
    expect(input.previewText).toBe("夜の散歩");
    expect(input.previewMeta).toMatchObject({
      folderName: "Chapter 1",
      nodeType: "scene",
    });
    const payload = input.payload as ScenePayload;
    expect(payload.originalId).toBe("node-1");
    expect(payload.title).toBe("夜の散歩");
    expect(payload.body).toBe(bodyDoc);
    expect(payload.beats).toBe("[]");
    expect(payload.folderHintId).toBe("folder-1");
    expect(payload.folderHintName).toBe("Chapter 1");
    expect(payload.metadata.status).toBe("draft");
    expect(payload.charCount).toBe(120);
    expect(options).toEqual({ tempId: "tmp-1" });
  });

  it("title が空のときは body プレビューを previewText に使う", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "本文の最初の一行" }],
        },
      ],
    });
    captureSceneDeletion({
      projectId: "p",
      node: makeNode({ title: "" }),
      content,
      folderHintName: null,
      tempId: "tmp-2",
    });
    const [input] = enqueueSpy.mock.calls[0];
    expect(input.previewText).toBe("本文の最初の一行");
    expect((input.previewMeta as Record<string, unknown>).bodyPreview).toBe(
      "本文の最初の一行",
    );
  });

  it("previewText は 500 文字で truncate される", () => {
    const longTitle = "あ".repeat(600);
    captureSceneDeletion({
      projectId: "p",
      node: makeNode({ title: longTitle }),
      content: bodyDoc,
      folderHintName: null,
      tempId: "tmp-3",
    });
    const [input] = enqueueSpy.mock.calls[0];
    expect([...input.previewText].length).toBe(501); // 500 + …
    expect(input.previewText.endsWith("…")).toBe(true);
  });
});

describe("captureCodexDeletion", () => {
  it("CodexEntryPayload を組み立てて enqueuePending を呼ぶ", () => {
    captureCodexDeletion({
      projectId: "p",
      entry: makeCodex(),
      categoryLabel: "人物",
      iconName: "User",
      tempId: "tmp-cx",
    });
    const [input, options] = enqueueSpy.mock.calls[0];
    expect(input.subKind).toBe("codex-entry");
    expect(input.previewText).toBe("ミレー");
    expect(input.previewMeta).toMatchObject({
      categoryLabel: "人物",
      iconName: "User",
      category: "character",
    });
    const payload = input.payload as CodexEntryPayload;
    expect(payload.originalId).toBe("cx-1");
    expect(payload.name).toBe("ミレー");
    expect(payload.category).toBe("character");
    expect(payload.summary).toBe("村の少女");
    expect(payload.fields).toEqual([]);
    expect(payload.links).toEqual([]);
    expect(payload.imageRefs).toEqual([]);
    expect(options.tempId).toBe("tmp-cx");
  });

  it("name が空なら summary または body プレビューを使う", () => {
    captureCodexDeletion({
      projectId: "p",
      entry: makeCodex({ name: "", summary: "概要のみ" }),
      categoryLabel: null,
      iconName: null,
      tempId: "tmp-cx-2",
    });
    const [input] = enqueueSpy.mock.calls[0];
    expect(input.previewText).toBe("概要のみ");
  });
});

describe("captureSnippetDeletion", () => {
  it("SnippetPayload を組み立てて enqueuePending を呼ぶ", () => {
    captureSnippetDeletion({
      projectId: "p",
      snippet: makeSnippet({ tagsCache: '[{"name":"foo","color":"#f00"}]' }),
      tempId: "tmp-sn",
    });
    const [input, options] = enqueueSpy.mock.calls[0];
    expect(input.subKind).toBe("snippet");
    expect(input.previewText).toBe("メモ");
    expect((input.previewMeta as Record<string, unknown>).tagsCache).toBe(
      '[{"name":"foo","color":"#f00"}]',
    );
    const payload = input.payload as SnippetPayload;
    expect(payload.originalId).toBe("sn-1");
    expect(payload.title).toBe("メモ");
    expect(payload.body).toContain("snippet 本文");
    expect(payload.tags).toBe('[{"name":"foo","color":"#f00"}]');
    expect(options.tempId).toBe("tmp-sn");
  });
});

describe("captureForeshadowDeletion", () => {
  it("restorable state axes and dirty timestamp are kept in the durable snapshot", () => {
    const foreshadow: ForeshadowRow = {
      id: "f1",
      projectId: "p",
      title: "伏線",
      intent: "意図",
      notes: "メモ",
      payoffSceneId: "scene-1",
      payoffFromPos: 2,
      payoffToPos: 8,
      payoffConfirmed: true,
      abandoned: true,
      secret: false,
      loadBearing: "critical",
      version: 0,
      codexLinkDirtyAt: new Date(1_784_000_000_000),
      createdAt: new Date(1_783_000_000_000),
      updatedAt: new Date(1_783_000_000_001),
    };

    captureForeshadowDeletion({
      projectId: "p",
      foreshadow,
      tempId: "tmp-foreshadow",
    });

    const [input] = enqueueSpy.mock.calls[0];
    const payload = input.payload as ForeshadowPayload;
    expect(payload).toMatchObject({
      originalId: "f1",
      payoffSceneRef: "scene-1",
      payoffFromPos: 2,
      payoffToPos: 8,
      payoffConfirmed: true,
      abandoned: true,
      secret: false,
      codexLinkDirtyAt: 1_784_000_000_000,
    });
  });
});

describe("空コンテンツのキャプチャは skip される", () => {
  it("scene: 本文空ならタイトルがあっても skip (デフォルト名対応)", () => {
    captureSceneDeletion({
      projectId: "p",
      node: makeNode({ title: "Scene 1", content: "{}" }),
      content: "{}",
      folderHintName: null,
      tempId: "tmp",
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("scene: 本文があれば保存される", () => {
    captureSceneDeletion({
      projectId: "p",
      node: makeNode({ title: "Scene 1" }),
      content:
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"本文だけ"}]}]}',
      folderHintName: null,
      tempId: "tmp",
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("scene: 空白のみの本文も skip", () => {
    captureSceneDeletion({
      projectId: "p",
      node: makeNode({ title: "夜の散歩" }),
      content:
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"   "}]}]}',
      folderHintName: null,
      tempId: "tmp",
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("codex: summary + body 両方空なら name があっても skip", () => {
    captureCodexDeletion({
      projectId: "p",
      entry: makeCodex({
        name: "新規キャラクター",
        summary: "",
        content: "{}",
      }),
      categoryLabel: null,
      iconName: null,
      tempId: "tmp",
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("codex: summary だけでも保存される", () => {
    captureCodexDeletion({
      projectId: "p",
      entry: makeCodex({
        name: "新規キャラクター",
        summary: "概要だけ書かれた",
        content: "{}",
      }),
      categoryLabel: null,
      iconName: null,
      tempId: "tmp",
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("snippet: body 空なら title があっても skip", () => {
    captureSnippetDeletion({
      projectId: "p",
      snippet: makeSnippet({ title: "新規スニペット", content: "{}" }),
      tempId: "tmp",
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("folder: title 空なら grid-chapter として skip (title 専用)", () => {
    captureSceneDeletion({
      projectId: "p",
      node: makeNode({ nodeType: "folder", title: "" }),
      content: "{}",
      folderHintName: null,
      tempId: "tmp",
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
