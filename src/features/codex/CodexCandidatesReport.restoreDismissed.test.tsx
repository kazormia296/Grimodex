// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const projectIdRef = vi.hoisted(() => ({ current: "p1" }));
vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => projectIdRef.current,
  getCurrentProjectId: () => projectIdRef.current,
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("./candidateExtractor", () => ({
  extractCodexCandidates: vi.fn(),
}));
vi.mock("./candidateJudgment", () => ({
  judgeCandidates: vi.fn(),
}));
vi.mock("./codexCandidateDismissals", () => ({
  loadDismissedCandidateKeys: vi.fn(),
  saveDismissedCandidateKeys: vi.fn(),
}));
// 構造抽出のダイアログは、戻す入口（onRestoreDismissedCandidates）を呼ぶ最小の代役にする。
vi.mock("./CodexStructureExtractDialog", () => ({
  CodexStructureExtractDialog: ({
    onRestoreDismissedCandidates,
  }: {
    onRestoreDismissedCandidates?: (keys: readonly string[]) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="fake-dialog-restore-a"
        onClick={() => onRestoreDismissedCandidates?.(["かんな"])}
      />
      <button
        type="button"
        data-testid="fake-dialog-restore-unknown"
        onClick={() => onRestoreDismissedCandidates?.(["未登録の表記"])}
      />
    </div>
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCodexStore } from "./codexStore";
import { extractCodexCandidates } from "./candidateExtractor";
import {
  loadDismissedCandidateKeys,
  saveDismissedCandidateKeys,
} from "./codexCandidateDismissals";
import { CodexCandidatesReport } from "./CodexCandidatesReport";

const mockExtract = vi.mocked(extractCodexCandidates);
const mockLoadDismissed = vi.mocked(loadDismissedCandidateKeys);
const mockSaveDismissed = vi.mocked(saveDismissedCandidateKeys);

function candidate(surface: string) {
  return {
    surface,
    lemma: surface,
    count: 3,
    firstSceneId: "s1",
    context: "",
  };
}

const lastSaved = () => {
  const calls = mockSaveDismissed.mock.calls;
  return [...(calls[calls.length - 1]![1] as Set<string>)].sort();
};

beforeEach(() => {
  vi.clearAllMocks();
  projectIdRef.current = "p1";
  mockLoadDismissed.mockResolvedValue(new Set(["かんな", "ふみ"]));
  mockSaveDismissed.mockResolvedValue(undefined);
  mockExtract.mockResolvedValue([
    candidate("かんな"),
    candidate("ふみ"),
    candidate("ゆう"),
  ]);
  useCodexStore.setState({ entries: [] } as never);
  useGlobalHistoryStore.getState().clear();
});

afterEach(() => cleanup());

async function openReport() {
  const user = userEvent.setup();
  render(<CodexCandidatesReport />);
  await user.click(await screen.findByTestId("codex-candidates-toggle"));
  // 見送り済みの 2 件は隠れ、残りの 1 件だけが行になる。
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  return user;
}

describe("CodexCandidatesReport: 構造抽出から却下を戻す（打ち手 3）", () => {
  it("戻した表記を除いた集合を保存し、その後の別の却下でも戻した表記が復活しない", async () => {
    const user = await openReport();

    await user.click(screen.getByTestId("fake-dialog-restore-a"));
    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalledTimes(1));
    expect(mockSaveDismissed.mock.calls[0]![0]).toBe("p1");
    expect(lastSaved()).toEqual(["ふみ"]);
    // 戻した「かんな」は候補画面の一覧にも出る。
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")).toHaveLength(2),
    );

    // 候補画面で別の表記を却下しても、戻した「かんな」は却下集合に戻らない。
    const yuuRow = screen
      .getAllByRole("listitem")
      .find((row) => row.textContent?.includes("ゆう"))!;
    await user.click(
      yuuRow.querySelector('[data-testid="codex-candidates-dismiss"]')!,
    );
    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalledTimes(2));
    expect(lastSaved()).toEqual(["ふみ", "ゆう"]);
  });

  it("却下集合にない key を戻そうとしても、何も保存しない", async () => {
    const user = await openReport();
    await user.click(screen.getByTestId("fake-dialog-restore-unknown"));
    // 保存の書き込みが走る余地を与えてから、呼ばれていないことを確かめる。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSaveDismissed).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("全体の undo で戻す前の集合に復元される", async () => {
    const user = await openReport();
    await user.click(screen.getByTestId("fake-dialog-restore-a"));
    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalledTimes(1));
    await useGlobalHistoryStore.getState().undo();
    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalledTimes(2));
    expect(lastSaved()).toEqual(["かんな", "ふみ"]);
  });
});
