// @vitest-environment happy-dom
/**
 * 「前回のチェック以降に N 件の変更があります」（DR-INN-1）の UI 試験。
 * 判定の規則そのものは impactPending.test／parity.test が持つ。ここでは
 * 出る／出ない条件・AI を呼ばないこと・古い結果の破棄・失敗は表示なし・押下の挙動の不変を固定する。
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import type { CodexSnapshot } from "@/features/impact-review/diff";

const gate = vi.hoisted(() => ({
  presentation: "enabled" as "enabled" | "disabled" | "hidden" | "pending",
}));
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({
    presentation: gate.presentation,
    tooltip: null,
    capability: {},
  }),
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({ blockIfUnlicensed: () => false }));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@/features/post-effect/errorToast", () => ({
  postEffectErrorToast: vi.fn(),
  postEffectPartialToast: () => false,
}));
// AI 経路・候補絞り・書込みは「呼ばれないこと」を固定するための spy。
vi.mock("@/features/post-effect/api", () => ({
  runPostEffectMulti: vi.fn(),
  flushPendingSceneSaves: vi.fn(async () => undefined),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: vi.fn(),
}));
vi.mock("@/features/impact-review/narrowing", () => ({
  narrowCandidateScenes: vi.fn(),
}));
vi.mock("@/features/impact-review/runImpactReview", () => ({
  runImpactReview: vi.fn(),
}));
vi.mock("@/features/impact-review/snapshot", () => ({
  buildCodexSnapshot: vi.fn(),
}));
vi.mock("@/features/impact-review/baseline", () => ({
  getBaseline: vi.fn(),
  saveBaseline: vi.fn(),
}));

import { toast } from "sonner";
import { runPostEffectMulti } from "@/features/post-effect/api";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { narrowCandidateScenes } from "@/features/impact-review/narrowing";
import { runImpactReview } from "@/features/impact-review/runImpactReview";
import { buildCodexSnapshot } from "@/features/impact-review/snapshot";
import { getBaseline, saveBaseline } from "@/features/impact-review/baseline";
import { useImpactPendingEpochStore } from "@/features/impact-review/impactPendingEpoch";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";
import { ImpactCheckButton } from "./ImpactCheckButton";

const baseline: CodexSnapshot = {
  name: "アリス",
  aliases: [],
  summary: "15歳。",
  contentPlain: "町に住む。",
  details: [{ name: "年齢", value: "15" }],
  phases: [],
};

function built(
  snapshot: CodexSnapshot,
  extra: { contextMode?: string; hasRestrictedPhases?: boolean } = {},
) {
  return {
    snapshot,
    projectId: "p1",
    entryType: "character",
    entryName: snapshot.name,
    sourceRevision: {
      kind: "sqlite_write_clock_v1" as const,
      expected_lineage: "l",
      expected_seq: "1",
    },
    ...extra,
  };
}

const twoChanges: CodexSnapshot = {
  ...baseline,
  summary: "17歳。",
  details: [{ name: "年齢", value: "17" }],
};

function arrange(
  snapshot: CodexSnapshot | null,
  base: CodexSnapshot | null = baseline,
  extra: { contextMode?: string; hasRestrictedPhases?: boolean } = {},
) {
  vi.mocked(buildCodexSnapshot).mockResolvedValue(
    snapshot ? built(snapshot, extra) : null,
  );
  vi.mocked(getBaseline).mockResolvedValue(base);
}

const LINE = "codex-impact-check-pending";

beforeEach(() => {
  vi.clearAllMocks();
  gate.presentation = "enabled";
  usePostEffectRunStore.setState({ runs: {} });
});
afterEach(() => cleanup());

describe("ImpactCheckButton: 前回のチェック以降の変更の 1 行", () => {
  it("baseline があり門を通り変更があれば、件数の 1 行をボタンの上に出す（複数形）", async () => {
    arrange(twoChanges);
    render(<ImpactCheckButton entryId="e1" />);
    const line = await screen.findByTestId(LINE);
    expect(line).toHaveTextContent("前回のチェック以降に 2 件の変更があります");
    // ボタンの上（DOM 順で先）。
    const button = screen.getByTestId("codex-impact-check");
    expect(
      line.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("en では単数形・複数形の文言（件数の複数形）", async () => {
    await i18next.changeLanguage("en");
    try {
      arrange({ ...baseline, details: [{ name: "年齢", value: "17" }] });
      const first = render(<ImpactCheckButton entryId="e1" />);
      expect(await screen.findByTestId(LINE)).toHaveTextContent(
        "1 change since the last check",
      );
      first.unmount();
      arrange(twoChanges);
      render(<ImpactCheckButton entryId="e2" />);
      expect(await screen.findByTestId(LINE)).toHaveTextContent(
        "2 changes since the last check",
      );
    } finally {
      await i18next.changeLanguage("ja");
    }
  });

  it("1 件は ja で件数をそのまま出す", async () => {
    arrange({ ...baseline, details: [{ name: "年齢", value: "17" }] });
    render(<ImpactCheckButton entryId="e1" />);
    expect(await screen.findByTestId(LINE)).toHaveTextContent(
      "前回のチェック以降に 1 件の変更があります",
    );
  });

  it.each([
    ["baseline が無い（一度も押していない）", () => arrange(twoChanges, null)],
    ["変更が無い", () => arrange(baseline)],
    ["空白だけの違い", () => arrange({ ...baseline, summary: "15 歳 。" })],
    [
      "contextMode が hidden（押しても止まる）",
      () => arrange(twoChanges, baseline, { contextMode: "hidden" }),
    ],
    [
      "contextMode が suppress",
      () => arrange(twoChanges, baseline, { contextMode: "suppress" }),
    ],
    [
      "Phase が制限的",
      () => arrange(twoChanges, baseline, { hasRestrictedPhases: true }),
    ],
    ["項目が無い", () => arrange(null)],
  ])("出さない: %s", async (_name, setup) => {
    setup();
    render(<ImpactCheckButton entryId="e1" />);
    await waitFor(() => expect(getBaseline).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId(LINE)).toBeNull();
    // ボタン自体は従来どおり出る。
    expect(screen.getByTestId("codex-impact-check")).toBeInTheDocument();
  });

  it("AI gate が disabled なら出さず（ボタンは disabled）、hidden ならボタンごと出さない", async () => {
    arrange(twoChanges);
    gate.presentation = "disabled";
    const { rerender } = render(<ImpactCheckButton entryId="e1" />);
    await act(async () => {});
    expect(screen.queryByTestId(LINE)).toBeNull();
    expect(screen.getByTestId("codex-impact-check")).toBeDisabled();
    // disabled の間は読みもしない。
    expect(buildCodexSnapshot).not.toHaveBeenCalled();

    gate.presentation = "hidden";
    rerender(<ImpactCheckButton entryId="e1" />);
    expect(screen.queryByTestId("codex-impact-check")).toBeNull();
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it("影響チェックの実行中は出さず、終了後に再計算して出す", async () => {
    arrange(twoChanges);
    render(<ImpactCheckButton entryId="e1" />);
    await screen.findByTestId(LINE);

    act(() => {
      usePostEffectRunStore.getState().begin({
        runId: "r1",
        projectId: "p1",
        effectType: "impact_review",
        scopeType: "project",
        scopeTargetId: null,
      });
    });
    expect(screen.queryByTestId(LINE)).toBeNull();

    // 完走して baseline が現在へ進んだ想定。
    arrange(twoChanges, twoChanges);
    act(() => usePostEffectRunStore.getState().complete("r1", 0));
    await waitFor(() => expect(getBaseline).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it("読みが失敗しても表示なし（toast も出さない）", async () => {
    vi.mocked(buildCodexSnapshot).mockRejectedValue(new Error("db down"));
    vi.mocked(getBaseline).mockResolvedValue(baseline);
    render(<ImpactCheckButton entryId="e1" />);
    await waitFor(() => expect(buildCodexSnapshot).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId(LINE)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("entryId が変わったら古い項目の結果を出さず、遅れて返った古い読みも捨てる", async () => {
    let resolveOld: (v: ReturnType<typeof built> | null) => void = () => {};
    vi.mocked(buildCodexSnapshot).mockImplementation((id: string) =>
      id === "e1"
        ? new Promise((r) => {
            resolveOld = r;
          })
        : Promise.resolve(built(baseline)),
    );
    vi.mocked(getBaseline).mockResolvedValue(baseline);
    const { rerender } = render(<ImpactCheckButton entryId="e1" />);
    await waitFor(() => expect(buildCodexSnapshot).toHaveBeenCalledTimes(1));

    rerender(<ImpactCheckButton entryId="e2" />);
    await waitFor(() => expect(buildCodexSnapshot).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveOld(built(twoChanges)); // e1 の古い読みが後から「変更あり」で返る
    });
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it("同じ項目で再計算が重なったとき、遅れて返った古い読みは新しい結果を上書きしない", async () => {
    let resolveOld: (v: ReturnType<typeof built>) => void = () => {};
    arrange(twoChanges);
    render(<ImpactCheckButton entryId="e1" />);
    await screen.findByTestId(LINE);

    // 1 回目の再計算は遅く（古い「変更あり」を返す）、2 回目は速く「変更なし」を返す。
    vi.mocked(buildCodexSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveOld = r;
          }),
      )
      .mockResolvedValueOnce(built(baseline));
    act(() => useImpactPendingEpochStore.getState().bump());
    await waitFor(() => expect(buildCodexSnapshot).toHaveBeenCalledTimes(2));
    act(() => useImpactPendingEpochStore.getState().bump());
    await waitFor(() => expect(screen.queryByTestId(LINE)).toBeNull());
    await act(async () => {
      resolveOld(built(twoChanges));
    });
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it("再計算の読みが失敗したら、前の結果を残さず表示なしにする", async () => {
    arrange(twoChanges);
    render(<ImpactCheckButton entryId="e1" />);
    await screen.findByTestId(LINE);
    vi.mocked(buildCodexSnapshot).mockRejectedValueOnce(new Error("db down"));
    act(() => useImpactPendingEpochStore.getState().bump());
    await waitFor(() => expect(screen.queryByTestId(LINE)).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("unmount 後に返った読みは state を書かない（警告なし）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveSnap: (v: ReturnType<typeof built>) => void = () => {};
    vi.mocked(buildCodexSnapshot).mockImplementation(
      () =>
        new Promise((r) => {
          resolveSnap = r;
        }),
    );
    vi.mocked(getBaseline).mockResolvedValue(baseline);
    const { unmount } = render(<ImpactCheckButton entryId="e1" />);
    await waitFor(() => expect(buildCodexSnapshot).toHaveBeenCalled());
    unmount();
    await act(async () => {
      resolveSnap(built(twoChanges));
    });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("ImpactCheckButton: AI を呼ばない", () => {
  it("mount・再計算では AI 経路・候補絞り・保存が 0 回（押下するまで runImpactReview も呼ばない）", async () => {
    arrange(twoChanges);
    const { rerender } = render(<ImpactCheckButton entryId="e1" />);
    await screen.findByTestId(LINE);
    rerender(<ImpactCheckButton entryId="e2" />);
    await screen.findByTestId(LINE);

    expect(runPostEffectMulti).not.toHaveBeenCalled();
    expect(resolveRoleSendOverride).not.toHaveBeenCalled();
    expect(narrowCandidateScenes).not.toHaveBeenCalled();
    expect(saveBaseline).not.toHaveBeenCalled();
    expect(runImpactReview).not.toHaveBeenCalled();
  });
});

describe("ImpactCheckButton: started の完走後に印が残らない", () => {
  it("store の complete が baseline の前進より先でも、onDone の合図で再計算して消える", async () => {
    arrange(twoChanges);
    let captured: {
      onDone?: (e: never) => void;
      onError?: (e: never) => void;
    } = {};
    vi.mocked(runImpactReview).mockImplementation(async (_id, cb) => {
      captured = cb as typeof captured;
      usePostEffectRunStore.getState().begin({
        runId: "r1",
        projectId: "p1",
        effectType: "impact_review",
        scopeType: "project",
        scopeTargetId: null,
      });
      return {
        status: "started",
        changeCount: 2,
        changeSummary: "",
        candidateSceneCount: 1,
      };
    });
    render(<ImpactCheckButton entryId="e1" />);
    await screen.findByTestId(LINE);
    await act(async () => {
      screen.getByTestId("codex-impact-check").click();
    });
    expect(screen.queryByTestId(LINE)).toBeNull(); // 実行中は出さない

    // post-effect/api の順序: store の complete → （baseline の前進を待つ）→ onDone。
    // complete の時点の baseline はまだ古い。
    act(() => usePostEffectRunStore.getState().complete("r1", 1));
    await screen.findByTestId(LINE); // 古い baseline を読んで「変更あり」が一瞬戻る

    // baseline が進み、runImpactReview の onDone が callbacks.onDone を呼ぶ。
    arrange(twoChanges, twoChanges);
    await act(async () => {
      captured.onDone?.({ summary: undefined } as never);
    });
    await waitFor(() => expect(screen.queryByTestId(LINE)).toBeNull());
  });

  it("onError でも再計算の合図を出す", async () => {
    arrange(twoChanges);
    let captured: { onError?: (e: never) => void } = {};
    vi.mocked(runImpactReview).mockImplementation(async (_id, cb) => {
      captured = cb as typeof captured;
      return {
        status: "started",
        changeCount: 2,
        changeSummary: "",
        candidateSceneCount: 1,
      };
    });
    render(<ImpactCheckButton entryId="e1" />);
    await screen.findByTestId(LINE);
    await act(async () => {
      screen.getByTestId("codex-impact-check").click();
    });
    await screen.findByTestId(LINE);
    const before = vi.mocked(getBaseline).mock.calls.length;
    await act(async () => {
      captured.onError?.({ error: "boom" } as never);
    });
    await waitFor(() =>
      expect(vi.mocked(getBaseline).mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe("ImpactCheckButton: 押下の挙動は不変", () => {
  const statuses = [
    ["no-change", "info", "変更がありません"],
    ["no-candidates", "info", "影響しそうなシーンは見つかりませんでした"],
    ["source-changed", "warning", "実行直前に設定または本文が更新されました"],
    ["started", "info", "3 件のシーンを確認中"],
  ] as const;

  it.each(statuses)(
    "status %s の toast が従来どおり、完了後に再計算する",
    async (status, kind, text) => {
      arrange(twoChanges);
      vi.mocked(runImpactReview).mockResolvedValue({
        status,
        changeCount: 2,
        changeSummary: "",
        candidateSceneCount: 3,
      });
      render(<ImpactCheckButton entryId="e1" />);
      await screen.findByTestId(LINE);

      // 押下の run が baseline を現在へ進めた想定。
      arrange(twoChanges, twoChanges);
      await act(async () => {
        screen.getByTestId("codex-impact-check").click();
      });

      expect(runImpactReview).toHaveBeenCalledWith("e1", expect.any(Object));
      expect(toast[kind]).toHaveBeenCalledWith(expect.stringContaining(text));
      // epoch の合図で再計算され、印が消える。
      await waitFor(() => expect(screen.queryByTestId(LINE)).toBeNull());
    },
  );
});
