// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// perf 契約: ChatPanel の仮想化 (3ab21233) でメッセージ行は scroll out/in の
// たびに remount する。MessageBadge が mount 毎に codex+snippet の DB クエリを
// 再発行すると履歴スクロールの往復で IPC バーストになるため、ストアの ID
// 集合が変わらない限りモジュールキャッシュから返す。抽出の追加/削除 (= ID
// 集合の変化) では従来どおり再フェッチし、削除でバッジが残らない契約
// (0c27e08e) を維持する。

const { mockListCodex, mockListSnippets } = vi.hoisted(() => ({
  mockListCodex: vi.fn(),
  mockListSnippets: vi.fn(),
}));

vi.mock("@/features/codex/api", () => ({
  listCodexEntriesByMessageId: mockListCodex,
}));
vi.mock("@/features/snippets/api", () => ({
  listSnippetsByMessageId: mockListSnippets,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) => `${k}:${o?.count ?? ""}`,
  }),
}));
vi.mock("@/lib/animation", () => ({
  DURATIONS: { fast: 0 },
  EASINGS: { easeOut: "easeOut" },
  useReducedMotion: () => true,
}));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
  motion: {
    span: ({
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      ...rest
    }: Record<string, unknown>) => <span {...rest} />,
    button: ({
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      ...rest
    }: Record<string, unknown>) => <button {...rest} />,
  },
}));
// 実ストアは layoutStore→codexStore→chatStore の eager 連鎖を引き込むため、
// 購読反応だけ本物 (zustand) の最小ストアに差し替える。
vi.mock("@/features/codex/codexStore", async () => {
  const { create } = await import("zustand");
  return {
    useCodexStore: create(() => ({
      entries: [] as { id: string }[],
      requestSelectEntry: () => {},
    })),
  };
});
vi.mock("@/features/snippets/snippetStore", async () => {
  const { create } = await import("zustand");
  return {
    useSnippetStore: create(() => ({
      entries: [] as { id: string }[],
      requestSelectEntry: () => {},
    })),
  };
});
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ showPanel: vi.fn() }) },
}));

import { MessageBadge, _clearMessageBadgeCache } from "./MessageBadge";
import { useCodexStore } from "@/features/codex/codexStore";

const CODEX_ENTRY = { id: "e1", name: "アリス" };
const STORE_ENTRY = { id: "e1", updatedAt: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  _clearMessageBadgeCache();
  mockListCodex.mockReset().mockResolvedValue([CODEX_ENTRY]);
  mockListSnippets.mockReset().mockResolvedValue([]);
  useCodexStore.setState({ entries: [STORE_ENTRY] as never });
});

function renderBadge(messageId = "m1") {
  return render(<MessageBadge messageId={messageId} />);
}

describe("MessageBadge: remount キャッシュ (perf 契約)", () => {
  it("remount ではキャッシュから返し、DB クエリを再発行しない", async () => {
    const first = renderBadge();
    await waitFor(() => {
      expect(screen.getByTestId("badge-codex-m1")).toBeDefined();
    });
    expect(mockListCodex).toHaveBeenCalledTimes(1);
    expect(mockListSnippets).toHaveBeenCalledTimes(1);

    // 仮想化の scroll out/in を模す: unmount → remount
    first.unmount();
    renderBadge();
    expect(screen.getByTestId("badge-codex-m1")).toBeDefined();
    expect(mockListCodex).toHaveBeenCalledTimes(1);
    expect(mockListSnippets).toHaveBeenCalledTimes(1);
  });

  it("抽出なしの結果 (null) もキャッシュし、remount で再クエリしない", async () => {
    mockListCodex.mockResolvedValue([]);
    const first = renderBadge("m2");
    await waitFor(() => {
      expect(mockListCodex).toHaveBeenCalledTimes(1);
    });
    first.unmount();
    const { container } = renderBadge("m2");
    expect(mockListCodex).toHaveBeenCalledTimes(1);
    // data=null かつ stopped でないので何も描画しない
    expect(container.textContent).toBe("");
  });

  it("ストアの ID 集合が変わったら再フェッチする (削除反映の契約を維持)", async () => {
    renderBadge();
    await waitFor(() => {
      expect(screen.getByTestId("badge-codex-m1")).toBeDefined();
    });
    expect(mockListCodex).toHaveBeenCalledTimes(1);

    // エントリ削除 → ID 集合キーが変化 → DB を再読みしてバッジが消える
    mockListCodex.mockResolvedValue([]);
    useCodexStore.setState({ entries: [] });
    await waitFor(() => {
      expect(mockListCodex).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("badge-codex-m1")).toBeNull();
    });
  });

  it("エントリ編集 (updatedAt 変化) で再フェッチする — rename のラベル stale 防止", async () => {
    // バッジは fetch スナップショットの name を表示するため、ID 集合のみを
    // キーにすると rename 後もキャッシュにヒットし旧ラベルが残る (旧実装は
    // remount 毎の無条件再フェッチで拾えていた)。updatedAt 込みキーの gate。
    renderBadge();
    await waitFor(() => {
      expect(screen.getByTestId("badge-codex-m1")).toBeDefined();
    });
    expect(mockListCodex).toHaveBeenCalledTimes(1);

    mockListCodex.mockResolvedValue([{ id: "e1", name: "アリス改" }]);
    useCodexStore.setState({
      entries: [{ id: "e1", updatedAt: "2026-01-02T00:00:00Z" }] as never,
    });
    await waitFor(() => {
      expect(mockListCodex).toHaveBeenCalledTimes(2);
    });
  });

  it("メッセージ毎に独立してキャッシュされる", async () => {
    const a = renderBadge("m1");
    await waitFor(() => {
      expect(mockListCodex).toHaveBeenCalledWith("m1");
    });
    a.unmount();
    renderBadge("m3");
    await waitFor(() => {
      expect(mockListCodex).toHaveBeenCalledWith("m3");
    });
    expect(mockListCodex).toHaveBeenCalledTimes(2);
  });
});
