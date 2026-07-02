// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { EventRow } from "./api";

// 重い子コンポーネントは軽量スタブへ（key の重複検出は親側で起きるので実装不要）。
vi.mock("./ChronicleDatePicker", () => ({ ChronicleDatePicker: () => null }));
vi.mock("./ChronicleDetailField", () => ({
  ChronicleDetailField: () => <div data-testid="detail-field" />,
}));
vi.mock("./CodexEntryPicker", () => ({
  CodexEntryPicker: () => <div data-testid="codex-picker" />,
}));
vi.mock("./SceneLinkField", () => ({
  SceneLinkField: () => <div data-testid="scene-link" />,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { ChronicleInspector, DraftTextField } from "./ChronicleInspector";

const NOW = "2026-06-27T00:00:00.000Z";

function ev(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "ea",
    projectId: "p1",
    title: "出来事A",
    note: null,
    detail: null,
    ordinal: "a0",
    primaryCodexId: null,
    laneGroup: null,
    locationCodexId: null,
    startTime: 100,
    endTime: null,
    startMinute: null,
    endMinute: null,
    startGranularity: "day",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
    secret: false,
    revealSceneId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function renderInspector() {
  return render(
    <ChronicleInspector
      event={ev()}
      laneOptions={[]}
      locations={[]}
      scenes={[]}
      calendar={{ daysPerYear: 360, seasonBoundaries: [] }}
      allEvents={[]}
      onPatch={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
      onLinkScene={() => {}}
      onUnlinkScene={() => {}}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DraftTextField — ローカル下書き＋trailing debounce commit", () => {
  it("打鍵は即時に入力へ反映され、commit は debounce 後に最終値で 1 回だけ", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { getByRole } = render(
      <DraftTextField value="初期" onCommit={onCommit} />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "あ" } });
    fireEvent.change(input, { target: { value: "あい" } });
    fireEvent.change(input, { target: { value: "あいう" } });
    // 打鍵中は即時反映・未 commit（per-keystroke DB 書込を出さない）。
    expect(input.value).toBe("あいう");
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("あいう");
  });

  it("blur で pending を即 flush する", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { getByRole } = render(
      <DraftTextField value="初期" onCommit={onCommit} />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "編集後" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("編集後");
    // debounce 満了後の二重 commit なし。
    vi.advanceTimersByTime(1000);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("unmount（選択切替の remount）でも pending を flush して編集を失わない", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { getByRole, unmount } = render(
      <DraftTextField value="初期" onCommit={onCommit} />,
    );
    fireEvent.change(getByRole("textbox"), { target: { value: "途中" } });
    unmount();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("途中");
  });

  it("flush はスケジュール時点の commit 関数を使う（選択切替後の誤書込防止）", () => {
    vi.useFakeTimers();
    const commitA = vi.fn();
    const commitB = vi.fn();
    const { getByRole, rerender } = render(
      <DraftTextField value="初期" onCommit={commitA} />,
    );
    fireEvent.change(getByRole("textbox"), { target: { value: "Aの編集" } });
    // 打鍵後に onCommit prop が差し替わっても、pending は旧 commit へ流れる。
    rerender(<DraftTextField value="初期" onCommit={commitB} />);
    vi.advanceTimersByTime(500);
    expect(commitA).toHaveBeenCalledWith("Aの編集");
    expect(commitB).not.toHaveBeenCalled();
  });

  it("pending なしのときは外部更新（undo 等）を下書きへ取り込む", () => {
    const onCommit = vi.fn();
    const { getByRole, rerender } = render(
      <DraftTextField value="v1" onCommit={onCommit} />,
    );
    rerender(<DraftTextField value="v2" onCommit={onCommit} />);
    expect((getByRole("textbox") as HTMLInputElement).value).toBe("v2");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("打ち消し合って元の値へ戻った下書きは commit しない", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { getByRole } = render(
      <DraftTextField value="初期" onCommit={onCommit} />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "初期x" } });
    fireEvent.change(input, { target: { value: "初期" } });
    vi.advanceTimersByTime(500);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("multiline は textarea として描画され同じ debounce で commit する", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { getByRole } = render(
      <DraftTextField value="" onCommit={onCommit} multiline rows={3} />,
    );
    const area = getByRole("textbox") as HTMLTextAreaElement;
    expect(area.tagName.toLowerCase()).toBe("textarea");
    fireEvent.change(area, { target: { value: "あらすじ" } });
    vi.advanceTimersByTime(500);
    expect(onCommit).toHaveBeenCalledWith("あらすじ");
  });
});

describe("ChronicleInspector — 子要素の React key", () => {
  it("詳細欄と参照シーン節が同一 key で重複せず、React の重複 key 警告を出さない", () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });

    const { getAllByTestId } = renderInspector();

    spy.mockRestore();
    const dupKeyWarnings = errors.filter((e) =>
      /Encountered two children with the same key|same key/i.test(e),
    );
    expect(dupKeyWarnings).toEqual([]);
    // 詳細欄・参照シーン節はそれぞれ 1 つだけ（増殖しない）。
    expect(getAllByTestId("detail-field").length).toBe(1);
    expect(getAllByTestId("scene-link").length).toBe(1);
  });
});

describe("ChronicleInspector — 下部アクションの narrow 縮退", () => {
  it("アクション行は @container（コンテナクエリの基準）", () => {
    const { getByTestId } = renderInspector();
    expect(getByTestId("inspector-actions").className).toContain("@container");
  });

  it("アクションのラベルは collapse クラス付き span で畳める", () => {
    const { getByTestId } = renderInspector();
    const spans =
      getByTestId("inspector-actions").querySelectorAll("button span");
    expect(spans.length).toBeGreaterThan(0);
    spans.forEach((s) => expect(s.className).toContain("@max-"));
  });

  it("非 scene の削除ボタンに title を付ける（アイコンのみ縮退時の識別）", () => {
    const { getByTestId } = renderInspector();
    // 非 scene・onOpenScene/onStamp/onPull 未指定なので、行内のボタンは削除のみ。
    const btn = getByTestId("inspector-actions").querySelector(
      "button",
    ) as HTMLButtonElement;
    expect(btn.getAttribute("title")).toBeTruthy();
  });
});
