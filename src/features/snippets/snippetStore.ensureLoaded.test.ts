/**
 * ensureEntriesLoaded の in-flight dedup 契約 (codexStore.ensureLoaded.test.ts
 * と同じ意味論。詳細コメントはそちらを参照)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSnippetStore } from "./snippetStore";
import type { Snippet } from "./api";

vi.mock("./api", () => ({
  listSnippets: vi.fn(),
  getSnippet: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  listSnippetsByMessageId: vi.fn(),
  searchSnippets: vi.fn(),
  incrementSnippetUsage: vi.fn(),
}));

import { listSnippets } from "./api";
const mockList = vi.mocked(listSnippets);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("snippetStore.ensureEntriesLoaded", () => {
  beforeEach(() => {
    useSnippetStore.setState({ entries: [], isLoading: false });
    vi.clearAllMocks();
  });

  it("同時に呼ばれた 2 回目は in-flight のロードに相乗りする (クエリ 1 回)", async () => {
    const d = deferred<Snippet[]>();
    mockList.mockReturnValue(d.promise);

    const p1 = useSnippetStore.getState().ensureEntriesLoaded();
    const p2 = useSnippetStore.getState().ensureEntriesLoaded();
    d.resolve([]);
    await Promise.all([p1, p2]);

    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("settle 後の呼び出しは再ロードする (over-cache しない)", async () => {
    mockList.mockResolvedValue([]);

    await useSnippetStore.getState().ensureEntriesLoaded();
    await useSnippetStore.getState().ensureEntriesLoaded();

    expect(mockList).toHaveBeenCalledTimes(2);
  });
});
