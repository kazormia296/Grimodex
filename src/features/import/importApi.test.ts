import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/codex/api", () => ({
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  deleteCodexEntry: vi.fn(),
}));

vi.mock("@/features/snippets/api", () => ({
  createSnippet: vi.fn(),
}));

vi.mock("@/features/codex/iconUtils", () => ({
  resizeAndConvertToWebP: vi.fn(),
}));

vi.mock("@/features/codex/tagApi", () => ({
  listCodexTags: vi.fn(),
  createCodexTag: vi.fn(),
  setEntryTags: vi.fn(),
}));

vi.mock("@/features/codex/detailApi", () => ({
  listDefinitionsByType: vi.fn(),
  createDefinition: vi.fn(),
  upsertValue: vi.fn(),
}));

vi.mock("@/features/codex/typeApi", () => ({
  ensureBuiltinTypes: vi.fn(),
  listCodexTypes: vi.fn(async () => []),
  createCodexType: vi.fn(),
}));

vi.mock("@/features/tree/api", () => ({
  createNode: vi.fn(async () => ({})),
  listNodes: vi.fn(async () => []),
  saveSceneContent: vi.fn(async () => undefined),
  updateNode: vi.fn(async () => undefined),
}));

vi.mock("@/db/client", () => {
  const insert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
  return { db: { insert } };
});

import {
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "@/features/codex/api";
import { createSnippet } from "@/features/snippets/api";
import { resizeAndConvertToWebP } from "@/features/codex/iconUtils";
import {
  listCodexTags,
  createCodexTag,
  setEntryTags,
} from "@/features/codex/tagApi";
import {
  listDefinitionsByType,
  createDefinition,
  upsertValue,
} from "@/features/codex/detailApi";
import { ensureBuiltinTypes } from "@/features/codex/typeApi";
import {
  createNode,
  listNodes,
  saveSceneContent,
  updateNode,
} from "@/features/tree/api";
import { db } from "@/db/client";
import {
  importCodexEntries,
  importSnippets,
  importChapters,
  importChatSessionsBatch,
  importMemoNote,
  fieldValueToProseMirror,
} from "./importApi";
import type {
  ParsedCodexEntry,
  ParsedSnippet,
  ParsedChapter,
  ParsedChatSession,
} from "./novelcrafterParser";

const mockCreateCodexEntry = vi.mocked(createCodexEntry);
const mockUpdateCodexEntry = vi.mocked(updateCodexEntry);
const mockDeleteCodexEntry = vi.mocked(deleteCodexEntry);
const mockCreateSnippet = vi.mocked(createSnippet);
const mockResizeAndConvertToWebP = vi.mocked(resizeAndConvertToWebP);
const mockListCodexTags = vi.mocked(listCodexTags);
const mockCreateCodexTag = vi.mocked(createCodexTag);
const mockSetEntryTags = vi.mocked(setEntryTags);
const mockListDefinitionsByType = vi.mocked(listDefinitionsByType);
const mockCreateDefinition = vi.mocked(createDefinition);
const mockUpsertValue = vi.mocked(upsertValue);
const mockEnsureBuiltinTypes = vi.mocked(ensureBuiltinTypes);

function makeEntry(
  overrides: Partial<ParsedCodexEntry> = {},
): ParsedCodexEntry {
  return {
    id: "entry-uuid-1",
    ncId: "NC_001",
    type: "character",
    name: "アリス",
    aliases: ["Alice"],
    summary: "主人公",
    content: "{}",
    contextMode: "mentioned",
    tagsCache: "[]",
    ...overrides,
  };
}

function makeSnippet(overrides: Partial<ParsedSnippet> = {}): ParsedSnippet {
  return {
    id: "snippet-uuid-1",
    ncId: "NC_S001",
    title: "テストスニペット",
    content: "スニペット内容",
    ...overrides,
  };
}

describe("importCodexEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCodexEntry.mockResolvedValue({} as never);
    mockUpdateCodexEntry.mockResolvedValue({} as never);
    mockDeleteCodexEntry.mockResolvedValue(undefined);
    mockEnsureBuiltinTypes.mockResolvedValue(undefined);
    mockListCodexTags.mockResolvedValue([]);
    mockCreateCodexTag.mockResolvedValue({
      id: "new-tag-id",
      name: "",
      color: null,
      projectId: "default-project",
      typeFilter: null,
      createdAt: "",
    } as never);
    mockSetEntryTags.mockResolvedValue(undefined);
    mockListDefinitionsByType.mockResolvedValue([]);
    mockCreateDefinition.mockResolvedValue({
      id: "new-def-id",
      name: "",
      typeSlug: "",
      projectId: "default-project",
      fieldType: "text",
      fieldConfig: null,
      sortOrder: 0,
      includeInContext: 0,
      createdAt: "",
    } as never);
    mockUpsertValue.mockResolvedValue({} as never);
  });

  it("成功時に imported カウントを返す", async () => {
    const entries = [
      makeEntry(),
      makeEntry({ id: "entry-uuid-2", name: "ボブ" }),
    ];
    const result = await importCodexEntries(entries);

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(mockCreateCodexEntry).toHaveBeenCalledTimes(2);
    expect(mockUpdateCodexEntry).toHaveBeenCalledTimes(2);
    expect(mockEnsureBuiltinTypes).toHaveBeenCalledWith(
      "default-project",
      expect.anything(),
      { origin: "import" },
    );
    expect(mockCreateCodexEntry.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });

  it("サムネイルがある場合は resizeAndConvertToWebP を呼ぶ", async () => {
    mockResizeAndConvertToWebP.mockResolvedValue("data:image/webp;base64,abc");
    const entry = makeEntry({ thumbnail: new Uint8Array([1, 2, 3]) });

    await importCodexEntries([entry]);

    expect(mockResizeAndConvertToWebP).toHaveBeenCalledTimes(1);
    expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
      "default-project",
      entry.id,
      expect.objectContaining({ icon: "data:image/webp;base64,abc" }),
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });

  it("サムネイル変換失敗時はicon=nullでupdateを続行する", async () => {
    mockResizeAndConvertToWebP.mockRejectedValue(
      new Error("conversion failed"),
    );
    const entry = makeEntry({ thumbnail: new Uint8Array([1, 2, 3]) });

    const result = await importCodexEntries([entry]);

    expect(result.imported).toBe(1);
    expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
      "default-project",
      entry.id,
      expect.objectContaining({ icon: null }),
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });

  it("createCodexEntry 失敗時はエラーを記録し imported しない", async () => {
    mockCreateCodexEntry.mockRejectedValueOnce(new Error("DB error"));
    const entries = [
      makeEntry({ name: "失敗エントリ" }),
      makeEntry({ id: "entry-uuid-2", name: "成功エントリ" }),
    ];

    const result = await importCodexEntries(entries);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("失敗エントリ");
  });

  it("updateCodexEntry 失敗時は createCodexEntry で作ったエントリを削除してロールバックする", async () => {
    mockUpdateCodexEntry.mockRejectedValueOnce(new Error("update failed"));
    const entry = makeEntry({
      id: "rollback-id",
      name: "ロールバックエントリ",
    });

    const result = await importCodexEntries([entry]);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ロールバックエントリ");
    expect(mockDeleteCodexEntry).toHaveBeenCalledWith(
      "default-project",
      "rollback-id",
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });

  it("ロールバックの deleteCodexEntry が失敗してもエラーは元の updateCodexEntry エラーのみ", async () => {
    mockUpdateCodexEntry.mockRejectedValueOnce(new Error("update failed"));
    mockDeleteCodexEntry.mockRejectedValueOnce(new Error("delete also failed"));
    const entry = makeEntry({
      id: "rollback-id",
      name: "ロールバックエントリ",
    });

    const result = await importCodexEntries([entry]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("update failed");
  });

  it("進捗コールバックを正しい順序で呼ぶ", async () => {
    const entries = [
      makeEntry(),
      makeEntry({ id: "entry-uuid-2", name: "ボブ" }),
    ];
    const progressCalls: { done: number; total: number }[] = [];

    await importCodexEntries(entries, (p) =>
      progressCalls.push({ done: p.done, total: p.total }),
    );

    // 各エントリ開始前 + 最終完了
    expect(progressCalls[0]).toEqual({ done: 0, total: 2 });
    expect(progressCalls[1]).toEqual({ done: 1, total: 2 });
    expect(progressCalls[progressCalls.length - 1]).toEqual({
      done: 2,
      total: 2,
    });
  });

  it("子エントリより先に親エントリを insert する（カテゴリ跨ぎの親子関係）", async () => {
    // キャラクター(child)がロア(parent)より先にリストに並んでいるケース
    // → トポロジカルソートで parent が先に insert されることを確認
    const parent = makeEntry({
      id: "lore-parent-id",
      ncId: "NC_LORE_001",
      type: "lore",
      name: "門兵部隊",
      parentId: undefined,
    });
    const child = makeEntry({
      id: "char-child-id",
      ncId: "NC_CHAR_001",
      type: "character",
      name: "マルフーシャ",
      parentId: "lore-parent-id",
    });

    // child が parent より前に並んでいる
    await importCodexEntries([child, parent]);

    const createCalls = mockCreateCodexEntry.mock.calls;
    expect(createCalls).toHaveLength(2);
    const firstInsertedId = createCalls[0][0].id;
    const secondInsertedId = createCalls[1][0].id;
    expect(firstInsertedId).toBe("lore-parent-id");
    expect(secondInsertedId).toBe("char-child-id");
  });

  it("新規タグを codexTags に作成して setEntryTags で紐付ける", async () => {
    mockCreateCodexTag.mockResolvedValueOnce({
      id: "tag-abc",
      name: "Main Character",
      color: null,
      projectId: "default-project",
      typeFilter: null,
      createdAt: "",
    } as never);

    const entry = makeEntry({
      tagsCache: JSON.stringify([{ name: "Main Character", color: null }]),
    });
    await importCodexEntries([entry]);

    // タグが存在しないので createCodexTag が呼ばれる
    expect(mockCreateCodexTag).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Main Character",
        projectId: "default-project",
      }),
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
    // setEntryTags でエントリに紐付け
    expect(mockSetEntryTags).toHaveBeenCalledWith(entry.id, ["tag-abc"], {
      projectId: "default-project",
      writeContext: expect.objectContaining({ origin: "import" }),
    });
  });

  it("既存タグは createCodexTag せず setEntryTags だけ呼ぶ", async () => {
    mockListCodexTags.mockResolvedValue([
      {
        id: "existing-tag-id",
        name: "既存タグ",
        color: null,
        projectId: "default-project",
        typeFilter: null,
        createdAt: "",
      },
    ] as never);

    const entry = makeEntry({
      tagsCache: JSON.stringify([{ name: "既存タグ", color: null }]),
    });
    await importCodexEntries([entry]);

    expect(mockCreateCodexTag).not.toHaveBeenCalled();
    expect(mockSetEntryTags).toHaveBeenCalledWith(
      entry.id,
      ["existing-tag-id"],
      {
        projectId: "default-project",
        writeContext: expect.objectContaining({ origin: "import" }),
      },
    );
  });

  it("fields があれば詳細定義を作成して値を upsert する", async () => {
    mockCreateDefinition.mockResolvedValueOnce({
      id: "def-height",
      name: "身長",
      typeSlug: "character",
      projectId: "default-project",
      fieldType: "text",
      fieldConfig: null,
      sortOrder: 0,
      includeInContext: 1,
      createdAt: "",
    } as never);

    const entry = makeEntry({ fields: { 身長: "170cm" } });
    await importCodexEntries([entry]);

    expect(mockCreateDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "身長",
        typeSlug: "character",
        fieldType: "text",
        includeInContext: 1,
      }),
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
    expect(mockUpsertValue).toHaveBeenCalledWith(
      entry.id,
      "def-height",
      expect.stringContaining("170cm"),
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });

  it("既存の詳細定義は再作成せず値のみ upsert する", async () => {
    mockListDefinitionsByType.mockResolvedValue([
      {
        id: "existing-def-id",
        name: "身長",
        typeSlug: "character",
        projectId: "default-project",
        fieldType: "text",
        fieldConfig: null,
        sortOrder: 0,
        includeInContext: 1,
        createdAt: "",
      },
    ] as never);

    const entry = makeEntry({ fields: { 身長: "170cm" } });
    await importCodexEntries([entry]);

    expect(mockCreateDefinition).not.toHaveBeenCalled();
    expect(mockUpsertValue).toHaveBeenCalledWith(
      entry.id,
      "existing-def-id",
      expect.stringContaining("170cm"),
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });
});

describe("importSnippets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSnippet.mockResolvedValue({} as never);
  });

  it("成功時に imported カウントを返す", async () => {
    const snippets = [
      makeSnippet(),
      makeSnippet({ id: "snippet-uuid-2", title: "2番目" }),
    ];
    const result = await importSnippets(snippets);

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(mockCreateSnippet).toHaveBeenCalledTimes(2);
  });

  it("createSnippet 失敗時はエラーを記録し imported しない", async () => {
    mockCreateSnippet.mockRejectedValueOnce(new Error("DB error"));
    const snippets = [
      makeSnippet({ title: "失敗スニペット" }),
      makeSnippet({ id: "snippet-uuid-2", title: "成功スニペット" }),
    ];

    const result = await importSnippets(snippets);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("失敗スニペット");
  });

  it("createSnippet に正しい引数を渡す", async () => {
    const snippet = makeSnippet();
    await importSnippets([snippet]);

    expect(mockCreateSnippet).toHaveBeenCalledWith(
      {
        id: snippet.id,
        projectId: "default-project",
        title: snippet.title,
        content: snippet.content,
        contentSource: "human",
      },
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });

  it("進捗コールバックを正しい順序で呼ぶ", async () => {
    const snippets = [
      makeSnippet(),
      makeSnippet({ id: "snippet-uuid-2", title: "2番目" }),
    ];
    const progressCalls: { done: number; total: number }[] = [];

    await importSnippets(snippets, (p) =>
      progressCalls.push({ done: p.done, total: p.total }),
    );

    expect(progressCalls[0]).toEqual({ done: 0, total: 2 });
    expect(progressCalls[1]).toEqual({ done: 1, total: 2 });
    expect(progressCalls[progressCalls.length - 1]).toEqual({
      done: 2,
      total: 2,
    });
  });
});

describe("importChapters", () => {
  const mockCreateNode = vi.mocked(createNode);
  const mockSaveSceneContent = vi.mocked(saveSceneContent);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNode.mockResolvedValue({} as never);
    mockSaveSceneContent.mockResolvedValue({
      placedBeatPreview: null,
      contentVersion: 1,
      contentUpdatedAt: "2026-07-13T00:00:01.000Z",
    });
  });

  function makeChapter(overrides: Partial<ParsedChapter> = {}): ParsedChapter {
    return {
      id: "chap-1",
      title: "Act 1",
      scenes: [
        {
          id: "scene-1",
          title: "導入",
          body: "朝が来た。",
        },
      ],
      ...overrides,
    };
  }

  it("章とシーンを作成し、本文を createNode の同一 Native mutation に渡す", async () => {
    const result = await importChapters([makeChapter()]);

    expect(result.imported).toBe(2); // chapter + scene
    expect(result.errors).toHaveLength(0);
    expect(mockCreateNode).toHaveBeenCalledTimes(2);
    for (const call of mockCreateNode.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          writeContext: expect.objectContaining({ origin: "import" }),
        }),
      );
    }
    const sceneCall = mockCreateNode.mock.calls.find(
      ([data]) => data.nodeType === "scene",
    );
    expect(sceneCall?.[0]).toMatchObject({
      id: "scene-1",
      content: fieldValueToProseMirror("朝が来た。"),
    });
    expect(sceneCall?.[1]).toEqual(
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
    expect(mockSaveSceneContent).not.toHaveBeenCalled();
  });

  it("本文が空のシーンも空 body を createNode に同梱する", async () => {
    const chapter = makeChapter({
      scenes: [{ id: "scene-1", title: "メモ", body: "" }],
    });
    await importChapters([chapter]);
    const sceneCall = mockCreateNode.mock.calls.find(
      ([data]) => data.nodeType === "scene",
    );
    expect(sceneCall?.[0]).toMatchObject({
      id: "scene-1",
      content: "{}",
    });
    expect(mockSaveSceneContent).not.toHaveBeenCalled();
  });

  it("空入力のときはエラーなく0を返す", async () => {
    const result = await importChapters([]);
    expect(result.imported).toBe(0);
    expect(mockCreateNode).not.toHaveBeenCalled();
  });

  it("章作成失敗時はそのシーン群をスキップして次の章へ進む", async () => {
    mockCreateNode.mockRejectedValueOnce(new Error("DB"));
    const chapters = [
      makeChapter({ id: "chap-1", title: "失敗章" }),
      makeChapter({
        id: "chap-2",
        title: "成功章",
        scenes: [{ id: "scene-2", title: "S2", body: "" }],
      }),
    ];
    const result = await importChapters(chapters);
    expect(result.errors[0]).toContain("失敗章");
    expect(result.imported).toBe(2); // chap-2 + scene-2
  });
});

describe("importMemoNote", () => {
  const mockCreateNode = vi.mocked(createNode);
  const mockListNodes = vi.mocked(listNodes);
  const mockUpdateNode = vi.mocked(updateNode);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNode.mockResolvedValue({ id: "memo-1" } as never);
    mockListNodes.mockResolvedValue([]);
  });

  it("note ノードを作成し contextMode を suppress に設定する", async () => {
    await importMemoNote("メモリ/脚注", "メモリ本文\n\n脚注本文");

    expect(mockCreateNode).toHaveBeenCalledTimes(1);
    const arg = mockCreateNode.mock.calls[0]![0];
    expect(arg.nodeType).toBe("note");
    expect(arg.title).toBe("メモリ/脚注");
    const doc = JSON.parse(arg.content!) as {
      content: { content?: { text: string }[] }[];
    };
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]!.content?.[0]?.text).toBe("メモリ本文");
    expect(doc.content[1]!.content?.[0]?.text).toBe("脚注本文");

    // AI 文脈への自動注入を防ぐ contract — 退避メモの存在意義そのもの
    expect(mockUpdateNode).toHaveBeenCalledWith(
      "memo-1",
      { contextMode: "suppress" },
      expect.objectContaining({
        writeContext: expect.objectContaining({ origin: "import" }),
      }),
    );
  });

  it("既存ルートノードの末尾より後ろの sortOrder で追加する", async () => {
    mockListNodes.mockResolvedValue([
      { sortOrder: "a5" },
      { sortOrder: "a1" },
    ] as never);

    await importMemoNote("t", "b");

    const arg = mockCreateNode.mock.calls[0]![0];
    // 未ソートの listNodes 結果でも最大キー "a5" の後ろに採番される
    expect(arg.sortOrder! > "a5").toBe(true);
  });
});

describe("importChatSessionsBatch", () => {
  const mockDbInsert = vi.mocked(db.insert);
  let mockValues: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValues = vi.fn(async () => undefined);
    mockDbInsert.mockReturnValue({ values: mockValues } as never);
  });

  function makeSession(
    overrides: Partial<ParsedChatSession> = {},
  ): ParsedChatSession {
    return {
      id: "sess-1",
      title: "テスト",
      titleFromFrontmatter: false,
      createdAt: "2026-03-07T00:00:00.000Z",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      ...overrides,
    };
  }

  it("セッション1件 + メッセージ2件を挿入する", async () => {
    const result = await importChatSessionsBatch([makeSession()]);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
    // 1 insert for the session, 1 batched insert for the messages (chunked).
    expect(mockDbInsert).toHaveBeenCalledTimes(2);
    // The message insert is batched: a single call carrying both rows, not one
    // insert per message (DB-write-amplification DoS guard).
    const messageInsert = mockValues.mock.calls[1][0];
    expect(Array.isArray(messageInsert)).toBe(true);
    expect(messageInsert).toHaveLength(2);
  });

  it("titleFromFrontmatter=true なら titleManual=1 で保存する", async () => {
    const valuesSpy = vi.fn(async (_v: unknown) => undefined);
    mockDbInsert.mockReturnValue({ values: valuesSpy } as never);

    await importChatSessionsBatch([
      makeSession({ titleFromFrontmatter: true, title: "手書きタイトル" }),
    ]);

    // First call is the session insert
    const sessionPayload = valuesSpy.mock.calls[0]?.[0] as {
      titleManual: number;
    };
    expect(sessionPayload.titleManual).toBe(1);
  });

  it("titleFromFrontmatter=false なら titleManual=0 で保存する", async () => {
    const valuesSpy = vi.fn(async (_v: unknown) => undefined);
    mockDbInsert.mockReturnValue({ values: valuesSpy } as never);

    await importChatSessionsBatch([makeSession()]);

    const sessionPayload = valuesSpy.mock.calls[0]?.[0] as {
      titleManual: number;
    };
    expect(sessionPayload.titleManual).toBe(0);
  });
});
