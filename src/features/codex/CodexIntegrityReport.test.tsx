// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

const projectIdRef = vi.hoisted(() => ({ current: "p1" }));
vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => projectIdRef.current,
  // codexStore など同モジュールを import する依存が居るため両方提供。
  getCurrentProjectId: () => projectIdRef.current,
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("./codexRelationApi", () => ({
  listCodexRelations: vi.fn(),
}));
vi.mock("./codexRelationEvents", () => ({
  subscribeCodexRelationsChanged: vi.fn(() => () => {}),
}));

import { useCodexStore } from "./codexStore";
import { listCodexRelations } from "./codexRelationApi";
import { CodexIntegrityReport } from "./CodexIntegrityReport";

const mockListRelations = vi.mocked(listCodexRelations);

function setEntries(
  entries: { id: string; name: string; aliases?: string[] }[],
) {
  useCodexStore.setState({ entries } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  projectIdRef.current = "p1";
  mockListRelations.mockResolvedValue([]);
  setEntries([]);
  useCodexStore.setState({ requestSelectEntry: vi.fn() } as never);
});

afterEach(() => cleanup());

describe("CodexIntegrityReport", () => {
  it("問題が無いときは何も描画しない", async () => {
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "エリカ" },
    ]);
    render(<CodexIntegrityReport />);
    await waitFor(() => expect(mockListRelations).toHaveBeenCalled());
    expect(screen.queryByTestId("codex-integrity-toggle")).toBeNull();
  });

  it("別名衝突を件数バッジ付きで表示し、展開で当事者エントリを出す", async () => {
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
    ]);
    render(<CodexIntegrityReport />);
    const toggle = await screen.findByTestId("codex-integrity-toggle");
    // 件数バッジ = 1
    expect(toggle.textContent).toContain("1");
    // 展開前は当事者は出ない
    expect(screen.queryAllByRole("button", { name: "シオン" })).toHaveLength(0);
    fireEvent.click(toggle);
    // 展開後、両エントリ名のリンクが出る
    expect(screen.getAllByRole("button", { name: "シオン" }).length).toBe(2);
  });

  it("エントリ名クリックで requestSelectEntry が呼ばれる", async () => {
    const spy = vi.fn();
    useCodexStore.setState({ requestSelectEntry: spy } as never);
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
    ]);
    render(<CodexIntegrityReport />);
    fireEvent.click(await screen.findByTestId("codex-integrity-toggle"));
    fireEvent.click(screen.getAllByRole("button", { name: "シオン" })[0]);
    expect(spy).toHaveBeenCalledWith("a");
  });

  it("自己参照リレーションを relation ロード後に表示する", async () => {
    setEntries([{ id: "a", name: "シオン" }]);
    mockListRelations.mockResolvedValue([
      { fromCodexId: "a", toCodexId: "a", relationType: "custom" },
    ] as never);
    render(<CodexIntegrityReport />);
    const toggle = await screen.findByTestId("codex-integrity-toggle");
    expect(toggle.textContent).toContain("1");
  });

  it("削除済みエントリを指す stale relation は除外する", async () => {
    setEntries([{ id: "a", name: "シオン" }]); // 'ghost' は存在しない
    mockListRelations.mockResolvedValue([
      { fromCodexId: "a", toCodexId: "ghost", relationType: "custom" },
      { fromCodexId: "ghost", toCodexId: "a", relationType: "custom" },
    ] as never);
    render(<CodexIntegrityReport />);
    await waitFor(() => expect(mockListRelations).toHaveBeenCalled());
    // ghost を含む relation は live でないので重複扱いされない → 問題0 → 非表示
    expect(screen.queryByTestId("codex-integrity-toggle")).toBeNull();
  });

  it("プロジェクト切替で relations を新 project で再ロードする", async () => {
    setEntries([{ id: "a", name: "シオン" }]);
    const { rerender } = render(<CodexIntegrityReport />);
    await waitFor(() => expect(mockListRelations).toHaveBeenCalledTimes(1));
    expect(mockListRelations).toHaveBeenLastCalledWith("p1");
    // プロジェクト切替 → deps=[projectId] で effect 再実行
    projectIdRef.current = "p2";
    rerender(<CodexIntegrityReport />);
    await waitFor(() => expect(mockListRelations).toHaveBeenCalledTimes(2));
    expect(mockListRelations).toHaveBeenLastCalledWith("p2");
  });
});
