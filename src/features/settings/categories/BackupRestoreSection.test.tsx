// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * backup restore Phase 1: バックアップ一覧＋復元 UI のガード。復元は破壊的
 * （ワークスペース全体を置換）なので 2 クリック確認を必須にし、正しい fileName で
 * restoreBackup を呼び、成功後に reload することを固定する。
 */

const apiMock = vi.hoisted(() => ({
  listBackups: vi.fn(),
  restoreBackup: vi.fn(() => Promise.resolve()),
}));
const toastMock = vi.hoisted(() => {
  const fn = vi.fn();
  return Object.assign(fn, { success: vi.fn(), error: vi.fn(), info: vi.fn() });
});
// 各テストで activeWorkspacePath を差し替えられるように可変ホルダにする。
const storeMock = vi.hoisted(() => ({ path: "/ws" as string | null }));
// inline-AI ペンディング判定の戻り値を各テストで差し替える。
const guardMock = vi.hoisted(() => ({ pending: false }));

vi.mock("../backupApi", () => apiMock);
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (
    sel: (s: { activeWorkspacePath: string | null }) => unknown,
  ) => sel({ activeWorkspacePath: storeMock.path }),
}));
// 復元前の静止化 helper は no-op に。
vi.mock("@/hooks/useAutoSave", () => ({
  flushAllAutoSaves: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/features/tree/pendingSceneWrites", () => ({
  awaitAllPendingSceneWrites: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/features/timelapse/recorder", () => ({
  flushNow: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/features/editor/inlineAi/pendingGuard", () => ({
  guardInlineAiPending: () => guardMock.pending,
}));

import { BackupRestoreSection } from "./BackupRestoreSection";

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.path = "/ws";
  guardMock.pending = false;
  apiMock.restoreBackup.mockResolvedValue(undefined);
});

describe("BackupRestoreSection", () => {
  it("バックアップ一覧を表示し、各行に復元ボタンを出す", async () => {
    apiMock.listBackups.mockResolvedValue([
      {
        fileName: "grimodex-20260707-120000.db",
        sizeBytes: 2_500_000,
        modifiedMs: 1,
        format: "db",
      },
    ]);
    render(<BackupRestoreSection />);
    await waitFor(() => expect(apiMock.listBackups).toHaveBeenCalled());
    await screen.findByText(/2\.4 MB/);
    expect(screen.getByRole("button", { name: "復元" })).toBeInTheDocument();
  });

  it("復元は 2 クリック確認後に fileName で restoreBackup を呼び reload する", async () => {
    const reloadSpy = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    apiMock.listBackups.mockResolvedValue([
      {
        fileName: "grimodex-A.db",
        sizeBytes: 100,
        modifiedMs: 1,
        format: "db",
      },
    ]);
    render(<BackupRestoreSection />);
    const btn = await screen.findByRole("button", { name: "復元" });

    // 1 クリック目: 確認モードに入るだけで復元しない。
    fireEvent.click(btn);
    expect(apiMock.restoreBackup).not.toHaveBeenCalled();
    const confirmBtn = await screen.findByRole("button", {
      name: "全体を置換して復元",
    });

    // 2 クリック目: 復元 → 成功トースト → reload。
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(apiMock.restoreBackup).toHaveBeenCalledWith("grimodex-A.db"),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(reloadSpy).toHaveBeenCalled();
  });

  it("gzip (.db.gz) バックアップも 2 クリックで復元できる", async () => {
    const reloadSpy = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    apiMock.listBackups.mockResolvedValue([
      {
        fileName: "grimodex-B.db.gz",
        sizeBytes: 100,
        modifiedMs: 1,
        format: "db.gz",
      },
    ]);
    render(<BackupRestoreSection />);
    fireEvent.click(await screen.findByRole("button", { name: "復元" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "全体を置換して復元" }),
    );
    await waitFor(() =>
      expect(apiMock.restoreBackup).toHaveBeenCalledWith("grimodex-B.db.gz"),
    );
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
  });

  it("未対応形式は復元ボタンが disabled で restoreBackup を呼ばない", async () => {
    apiMock.listBackups.mockResolvedValue([
      {
        fileName: "grimodex-C.zip",
        sizeBytes: 100,
        modifiedMs: 1,
        format: "zip",
      },
    ]);
    render(<BackupRestoreSection />);
    const btn = await screen.findByRole("button", { name: "復元" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(apiMock.restoreBackup).not.toHaveBeenCalled();
  });

  it("ワークスペース未オープン時は一覧を取得しない", async () => {
    storeMock.path = null;
    render(<BackupRestoreSection />);
    await screen.findByText("ワークスペースが開かれていません");
    expect(apiMock.listBackups).not.toHaveBeenCalled();
  });

  it("inline-AI ペンディング中は確認後も復元しない", async () => {
    guardMock.pending = true;
    apiMock.listBackups.mockResolvedValue([
      {
        fileName: "grimodex-A.db",
        sizeBytes: 100,
        modifiedMs: 1,
        format: "db",
      },
    ]);
    render(<BackupRestoreSection />);
    const btn = await screen.findByRole("button", { name: "復元" });
    fireEvent.click(btn); // 確認モードへ
    const confirmBtn = await screen.findByRole("button", {
      name: "全体を置換して復元",
    });
    fireEvent.click(confirmBtn); // guard がブロック
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "復元" })).toBeInTheDocument(),
    );
    expect(apiMock.restoreBackup).not.toHaveBeenCalled();
  });

  it("RESTORE_SESSION_LOST エラーでは reload して回復させる", async () => {
    const reloadSpy = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    // Tauri は AppError を文字列で reject する。
    apiMock.restoreBackup.mockRejectedValue(
      "RESTORE_SESSION_LOST: 復元DBを開けませんでした",
    );
    apiMock.listBackups.mockResolvedValue([
      {
        fileName: "grimodex-A.db",
        sizeBytes: 100,
        modifiedMs: 1,
        format: "db",
      },
    ]);
    render(<BackupRestoreSection />);
    fireEvent.click(await screen.findByRole("button", { name: "復元" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "全体を置換して復元" }),
    );
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
  });

  it("通常の復元エラーでは reload せずセッションを維持する", async () => {
    const reloadSpy = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    apiMock.restoreBackup.mockRejectedValue("復元DBの適用に失敗しました");
    apiMock.listBackups.mockResolvedValue([
      {
        fileName: "grimodex-A.db",
        sizeBytes: 100,
        modifiedMs: 1,
        format: "db",
      },
    ]);
    render(<BackupRestoreSection />);
    fireEvent.click(await screen.findByRole("button", { name: "復元" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "全体を置換して復元" }),
    );
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    // 復元ボタンが戻る（再試行可能）＝ reload していない。
    await screen.findByRole("button", { name: "復元" });
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
