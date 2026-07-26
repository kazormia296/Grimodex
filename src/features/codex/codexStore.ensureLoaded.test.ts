/**
 * ensureEntriesLoaded の in-flight dedup 契約 (perf レビュー 2026-06-10 残項目
 * 「パネル mount eager load に dedup ガード無し」)。
 *
 * 意味論: 同一キー (projectId|filterType) のロードが進行中のときだけ相乗りし、
 * settle 後は毎回ロードする。remount 時の再フェッチ (MCP 等の外部書き込みを
 * 拾う accidental freshness) は意図的に維持する — dedup の対象は
 * 「起動時の複数パネル同時 mount」によるクエリ重複のみ。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useCodexStore } from "./codexStore";
import type { CodexEntry } from "./api";

vi.mock("./api", () => ({
  listCodexEntries: vi.fn(),
  listCodexMatchTargets: vi.fn(() => Promise.resolve([])),
  listCodexTypes: vi.fn(() => Promise.resolve([])),
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  deleteCodexEntry: vi.fn(),
  listCodexEntriesByMessageId: vi.fn(),
  getCodexEntry: vi.fn(),
}));

import { listCodexEntries } from "./api";
const mockList = vi.mocked(listCodexEntries);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("codexStore.ensureEntriesLoaded", () => {
  beforeEach(() => {
    useCodexStore.setState({
      entries: [],
      isLoading: false,
      filterType: null,
    });
    vi.clearAllMocks();
  });

  it("同時に呼ばれた 2 回目は in-flight のロードに相乗りする (クエリ 1 回)", async () => {
    const d = deferred<CodexEntry[]>();
    mockList.mockReturnValue(d.promise);

    const p1 = useCodexStore.getState().ensureEntriesLoaded();
    const p2 = useCodexStore.getState().ensureEntriesLoaded();
    d.resolve([]);
    await Promise.all([p1, p2]);

    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("settle 後の呼び出しは再ロードする (over-cache しない = 外部書き込みの freshness 維持)", async () => {
    mockList.mockResolvedValue([]);

    await useCodexStore.getState().ensureEntriesLoaded();
    await useCodexStore.getState().ensureEntriesLoaded();

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("直接の loadEntries (mutation 後リフレッシュ) は常にロードし、進行中なら ensure はそれに相乗りする", async () => {
    const d = deferred<CodexEntry[]>();
    mockList.mockReturnValue(d.promise);

    const direct = useCodexStore.getState().loadEntries();
    const ensured = useCodexStore.getState().ensureEntriesLoaded();
    d.resolve([]);
    await Promise.all([direct, ensured]);

    expect(mockList).toHaveBeenCalledTimes(1);
  });
});
