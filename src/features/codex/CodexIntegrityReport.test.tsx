// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  act,
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
vi.mock("./codexIntegrityDismissals", () => ({
  loadDismissedIntegrityKeys: vi.fn(),
  saveDismissedIntegrityKeys: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "sonner";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCodexStore } from "./codexStore";
import { listCodexRelations } from "./codexRelationApi";
import {
  loadDismissedIntegrityKeys,
  saveDismissedIntegrityKeys,
} from "./codexIntegrityDismissals";
import { CodexIntegrityReport } from "./CodexIntegrityReport";

const mockListRelations = vi.mocked(listCodexRelations);
const mockLoadDismissed = vi.mocked(loadDismissedIntegrityKeys);
const mockSaveDismissed = vi.mocked(saveDismissedIntegrityKeys);
const mockToastError = vi.mocked(toast.error);

// 別名衝突 (シオン×{a,b}) の安定キー (integrityIssueKey と一致させる)。
const SHION_KEY = "alias:シオン:a|b";

function setEntries(
  entries: { id: string; name: string; aliases?: string[] }[],
) {
  useCodexStore.setState({ entries } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  projectIdRef.current = "p1";
  mockListRelations.mockResolvedValue([]);
  mockLoadDismissed.mockResolvedValue(new Set());
  mockSaveDismissed.mockResolvedValue(undefined);
  setEntries([]);
  useCodexStore.setState({ requestSelectEntry: vi.fn() } as never);
  // 共有シングルトンの履歴をテスト間でリセット (undo/redo の取り違え防止)。
  useGlobalHistoryStore.getState().clear();
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

  it("プロジェクト切替で relations と非表示状態を新 project で再ロードする", async () => {
    setEntries([{ id: "a", name: "シオン" }]);
    const { rerender } = render(<CodexIntegrityReport />);
    await waitFor(() => expect(mockListRelations).toHaveBeenCalledTimes(1));
    expect(mockListRelations).toHaveBeenLastCalledWith("p1");
    expect(mockLoadDismissed).toHaveBeenLastCalledWith("p1");
    // プロジェクト切替 → deps=[projectId] で effect 再実行
    projectIdRef.current = "p2";
    rerender(<CodexIntegrityReport />);
    await waitFor(() => expect(mockListRelations).toHaveBeenCalledTimes(2));
    expect(mockListRelations).toHaveBeenLastCalledWith("p2");
    await waitFor(() =>
      expect(mockLoadDismissed).toHaveBeenLastCalledWith("p2"),
    );
  });

  it("× で指摘を非表示にすると一覧から消え、全件非表示で控えめバーに切り替わる", async () => {
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
    ]);
    render(<CodexIntegrityReport />);
    fireEvent.click(await screen.findByTestId("codex-integrity-toggle"));
    fireEvent.click(screen.getByTestId("codex-integrity-dismiss"));
    // 保存され、全件非表示 → 警告バナーは消え、控えめバーに切り替わる
    await screen.findByTestId("codex-integrity-all-hidden");
    expect(screen.queryByTestId("codex-integrity-toggle")).toBeNull();
    await waitFor(() =>
      expect(mockSaveDismissed).toHaveBeenCalledWith(
        "p1",
        new Set([SHION_KEY]),
      ),
    );
  });

  it("起動時に非表示済みなら控えめバーを出し、再表示で警告が戻る", async () => {
    mockLoadDismissed.mockResolvedValue(new Set([SHION_KEY]));
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
    ]);
    render(<CodexIntegrityReport />);
    // 最初は控えめバー (警告バナーは出ない)
    await screen.findByTestId("codex-integrity-all-hidden");
    expect(screen.queryByTestId("codex-integrity-toggle")).toBeNull();
    // 再表示 → 空集合で保存し、警告バナーが戻る
    fireEvent.click(screen.getByTestId("codex-integrity-restore"));
    await screen.findByTestId("codex-integrity-toggle");
    await waitFor(() =>
      expect(mockSaveDismissed).toHaveBeenCalledWith("p1", new Set()),
    );
  });

  it("一部だけ非表示なら警告は残り、展開末尾に再表示リンクを出す", async () => {
    // 2 件の別名衝突 (シオン/エリカ) のうち 1 件だけ非表示。
    mockLoadDismissed.mockResolvedValue(new Set([SHION_KEY]));
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
      { id: "c", name: "エリカ" },
      { id: "d", name: "エリカ" },
    ]);
    render(<CodexIntegrityReport />);
    const toggle = await screen.findByTestId("codex-integrity-toggle");
    // dismissed ロード後、表示は 1 件 (エリカ衝突のみ)
    await waitFor(() => expect(toggle.textContent).toContain("1"));
    fireEvent.click(toggle);
    expect(screen.getByTestId("codex-integrity-restore")).toBeTruthy();
  });

  it("非表示は undo で戻り redo で再び非表示になる", async () => {
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
    ]);
    render(<CodexIntegrityReport />);
    fireEvent.click(await screen.findByTestId("codex-integrity-toggle"));
    fireEvent.click(screen.getByTestId("codex-integrity-dismiss"));
    await screen.findByTestId("codex-integrity-all-hidden");

    // undo → 非表示解除 (空集合で保存) → 警告が戻る
    await act(async () => {
      await useGlobalHistoryStore.getState().undo();
    });
    await screen.findByTestId("codex-integrity-toggle");
    await waitFor(() =>
      expect(mockSaveDismissed).toHaveBeenLastCalledWith("p1", new Set()),
    );

    // redo → 再び非表示 (元の集合で保存) → 控えめバー
    await act(async () => {
      await useGlobalHistoryStore.getState().redo();
    });
    await screen.findByTestId("codex-integrity-all-hidden");
    await waitFor(() =>
      expect(mockSaveDismissed).toHaveBeenLastCalledWith(
        "p1",
        new Set([SHION_KEY]),
      ),
    );
  });

  it("保存失敗時はトーストを出し、楽観更新を巻き戻して指摘を保持する", async () => {
    mockSaveDismissed.mockRejectedValueOnce(new Error("db down"));
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
    ]);
    render(<CodexIntegrityReport />);
    fireEvent.click(await screen.findByTestId("codex-integrity-toggle"));
    fireEvent.click(screen.getByTestId("codex-integrity-dismiss"));
    // 失敗 → toast.error + DB 真実 (空) へ再同期 → 警告バナーが残る
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    await screen.findByTestId("codex-integrity-toggle");
    expect(screen.queryByTestId("codex-integrity-all-hidden")).toBeNull();
  });

  it("複数の指摘で × は当該 1 件だけを非表示にする", async () => {
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
      { id: "c", name: "エリカ" },
      { id: "d", name: "エリカ" },
    ]);
    render(<CodexIntegrityReport />);
    fireEvent.click(await screen.findByTestId("codex-integrity-toggle"));
    // 2 件分の dismiss ボタン
    const buttons = screen.getAllByTestId("codex-integrity-dismiss");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    // 1 件だけ非表示 → 残り 1 件は表示、dismiss ボタンも 1 個
    await waitFor(() =>
      expect(screen.getAllByTestId("codex-integrity-dismiss")).toHaveLength(1),
    );
    expect(screen.getByTestId("codex-integrity-restore")).toBeTruthy();
    // 保存は単一要素の集合
    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalled());
    const savedSet = mockSaveDismissed.mock.calls.at(-1)?.[1] as Set<string>;
    expect(savedSet.size).toBe(1);
  });

  it("保存失敗の巻き戻しは、後続 dismiss が来ていたら適用しない (desync 回避)", async () => {
    // 1 件目の save だけ手動で reject できる deferred にし、2 件目以降は成功させる。
    let rejectFirst!: (e: unknown) => void;
    const firstSave = new Promise<void>((_, rej) => {
      rejectFirst = rej;
    });
    mockSaveDismissed
      .mockReturnValueOnce(firstSave)
      .mockResolvedValue(undefined);
    setEntries([
      { id: "a", name: "シオン" },
      { id: "b", name: "シオン" },
      { id: "c", name: "エリカ" },
      { id: "d", name: "エリカ" },
    ]);
    render(<CodexIntegrityReport />);
    fireEvent.click(await screen.findByTestId("codex-integrity-toggle"));
    expect(screen.getAllByTestId("codex-integrity-dismiss")).toHaveLength(2);
    // A を非表示 (save は pending) → 続けて B を非表示 (ref を {A,B} へ置換)。
    fireEvent.click(screen.getAllByTestId("codex-integrity-dismiss")[0]);
    fireEvent.click(screen.getAllByTestId("codex-integrity-dismiss")[0]);
    await screen.findByTestId("codex-integrity-all-hidden");
    // ここで 1 件目の save を失敗させる。ref は既に {A,B} なので巻き戻ってはならない。
    await act(async () => {
      rejectFirst(new Error("db down"));
      await Promise.resolve();
    });
    // 2 件目の save まで流す。
    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalledTimes(2));
    // 全件非表示のまま (desync しない)、巻き戻しトーストも出ない。
    expect(screen.queryByTestId("codex-integrity-all-hidden")).not.toBeNull();
    expect(screen.queryByTestId("codex-integrity-toggle")).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
    // 最後に永続化された集合は 2 件 (A,B 両方)。
    const lastSet = mockSaveDismissed.mock.calls.at(-1)?.[1] as Set<string>;
    expect(lastSet.size).toBe(2);
  });
});
