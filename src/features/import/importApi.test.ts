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

import {
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "@/features/codex/api";
import { createSnippet } from "@/features/snippets/api";
import { resizeAndConvertToWebP } from "@/features/codex/iconUtils";
import { importCodexEntries, importSnippets } from "./importApi";
import type { ParsedCodexEntry, ParsedSnippet } from "./novelcrafterParser";

const mockCreateCodexEntry = vi.mocked(createCodexEntry);
const mockUpdateCodexEntry = vi.mocked(updateCodexEntry);
const mockDeleteCodexEntry = vi.mocked(deleteCodexEntry);
const mockCreateSnippet = vi.mocked(createSnippet);
const mockResizeAndConvertToWebP = vi.mocked(resizeAndConvertToWebP);

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
  });

  it("サムネイルがある場合は resizeAndConvertToWebP を呼ぶ", async () => {
    mockResizeAndConvertToWebP.mockResolvedValue("data:image/webp;base64,abc");
    const entry = makeEntry({ thumbnail: new Uint8Array([1, 2, 3]) });

    await importCodexEntries([entry]);

    expect(mockResizeAndConvertToWebP).toHaveBeenCalledTimes(1);
    expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
      entry.id,
      expect.objectContaining({ icon: "data:image/webp;base64,abc" }),
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
      entry.id,
      expect.objectContaining({ icon: null }),
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
    expect(mockDeleteCodexEntry).toHaveBeenCalledWith("rollback-id");
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

    expect(mockCreateSnippet).toHaveBeenCalledWith({
      id: snippet.id,
      projectId: "default-project",
      title: snippet.title,
      content: snippet.content,
      contentSource: "human",
    });
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
