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
vi.mock("./CodexStructureExtractDialog", () => ({
  CodexStructureExtractDialog: () => null,
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCodexStore } from "./codexStore";
import { extractCodexCandidates } from "./candidateExtractor";
import { judgeCandidates, type CandidateJudgment } from "./candidateJudgment";
import {
  loadDismissedCandidateKeys,
  saveDismissedCandidateKeys,
} from "./codexCandidateDismissals";
import { CodexCandidatesReport } from "./CodexCandidatesReport";

const mockExtract = vi.mocked(extractCodexCandidates);
const mockJudge = vi.mocked(judgeCandidates);
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

function judgment(surface: string): [string, CandidateJudgment] {
  return [
    surface,
    {
      surface,
      suggestedType: "character",
      summary: "",
      aliasOfId: "e1",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  projectIdRef.current = "p1";
  mockLoadDismissed.mockResolvedValue(new Set());
  mockSaveDismissed.mockResolvedValue(undefined);
  useCodexStore.setState({
    entries: [{ id: "e1", name: "ライカ", aliases: null }],
    requestSelectEntry: vi.fn(),
  } as never);
  useGlobalHistoryStore.getState().clear();
});

afterEach(() => cleanup());

describe("CodexCandidatesReport relational terms", () => {
  it("shows the alias button for an alias hint on a non-relational term but not on a relational one", async () => {
    mockExtract.mockResolvedValue([
      candidate("ライカ嬢"),
      candidate("姉ちゃん"),
    ]);
    mockJudge.mockResolvedValue(
      new Map([judgment("ライカ嬢"), judgment("姉ちゃん")]),
    );
    const user = userEvent.setup();
    render(<CodexCandidatesReport />);

    await user.click(await screen.findByTestId("codex-candidates-toggle"));
    await user.click(await screen.findByTestId("codex-candidates-judge"));

    // 対照：呼び名でない行には別名ボタンが出る（判定が読み込まれたことの確認）。
    await waitFor(() =>
      expect(
        screen.getAllByTestId("codex-candidates-register-alias"),
      ).toHaveLength(1),
    );
    const rows = screen.getAllByRole("listitem");
    const relationalRow = rows.find((row) =>
      row.textContent?.includes("姉ちゃん"),
    );
    const ordinaryRow = rows.find((row) =>
      row.textContent?.includes("ライカ嬢"),
    );
    expect(relationalRow).toBeDefined();
    expect(ordinaryRow).toBeDefined();
    expect(
      relationalRow!.querySelector(
        '[data-testid="codex-candidates-register-alias"]',
      ),
    ).toBeNull();
    expect(
      ordinaryRow!.querySelector(
        '[data-testid="codex-candidates-register-alias"]',
      ),
    ).not.toBeNull();
    // 新規作成と却下は呼び名の行にも残る。
    expect(
      relationalRow!.querySelector('[data-testid="codex-candidates-accept"]'),
    ).not.toBeNull();
    expect(
      relationalRow!.querySelector('[data-testid="codex-candidates-dismiss"]'),
    ).not.toBeNull();
    expect(relationalRow!.textContent).not.toContain("ライカ");
  });
});
