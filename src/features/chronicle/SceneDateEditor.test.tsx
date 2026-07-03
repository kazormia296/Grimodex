// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SceneDateEditor } from "./SceneDateEditor";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import type { ChronicleCalendar } from "./chronicleTime";

// 暦ロード（IPC/DB）は固定暦に差し替える。SceneDateEditor の写像/永続化だけを検証。
vi.mock("./useProjectCalendar", () => ({
  useProjectCalendar: (): { calendar: ChronicleCalendar } => ({
    calendar: {
      startYear: 1000,
      daysPerYear: 360,
      months: [{ name: "一月", days: 30 }],
      weekdayNames: [],
      seasonBoundaries: [{ name: "春", startDayOfYear: 0 }],
    },
  }),
}));

function makeNode(over: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: "scene-1",
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: "S",
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    chronicleStartTime: null,
    chronicleStartMinute: null,
    chronicleStartGranularity: "none",
    chronicleEndTime: null,
    chronicleEndMinute: null,
    chronicleEndGranularity: "none",
    chroniclePrecision: "exact",
    charCount: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...over,
  };
}

describe("SceneDateEditor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("粒度変更が chronicle* 列へ写像されて updateChronicleDate を呼ぶ", () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    useTreeStore.setState({ updateChronicleDate: spy });
    const { getByLabelText } = render(<SceneDateEditor node={makeNode()} />);
    fireEvent.change(getByLabelText("開始の粒度"), {
      target: { value: "year" },
    });
    expect(spy).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({
        chronicleStartGranularity: "year",
        chronicleStartTime: expect.any(Number),
      }),
    );
  });

  it("確度(precision)変更が chroniclePrecision として保存される", () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    useTreeStore.setState({ updateChronicleDate: spy });
    const { getByLabelText } = render(<SceneDateEditor node={makeNode()} />);
    fireEvent.change(getByLabelText("日付の確度"), {
      target: { value: "approx" },
    });
    expect(spy).toHaveBeenCalledWith("scene-1", {
      chroniclePrecision: "approx",
    });
  });

  it("既存の chronicle* 値を初期表示する（確度 select 反映）", () => {
    useTreeStore.setState({ updateChronicleDate: vi.fn() });
    const { getByLabelText } = render(
      <SceneDateEditor node={makeNode({ chroniclePrecision: "unknown" })} />,
    );
    expect((getByLabelText("日付の確度") as HTMLSelectElement).value).toBe(
      "unknown",
    );
  });

  it("開始粒度を設定すると Chronicle と統一された日付コントロールを出す（期間トグル）", () => {
    // 旧 EventDateEditor（bare な年/月/日 number 入力）ではなく、共有 EventDateFields
    // を使っていること＝Chronicle インスペクタと同じ「期間にする」トグルが出ることで gate。
    useTreeStore.setState({ updateChronicleDate: vi.fn() });
    const { getByText, getByLabelText } = render(
      <SceneDateEditor
        node={makeNode({
          chronicleStartGranularity: "day",
          chronicleStartTime: 100,
        })}
      />,
    );
    expect((getByLabelText("開始の粒度") as HTMLSelectElement).value).toBe(
      "day",
    );
    expect(getByText("期間にする")).toBeDefined();
  });

  it("scene 以外（folder / note）では何も描画しない", () => {
    useTreeStore.setState({ updateChronicleDate: vi.fn() });
    const folder = render(
      <SceneDateEditor node={makeNode({ nodeType: "folder" })} />,
    );
    expect(folder.container.firstChild).toBeNull();
    const note = render(
      <SceneDateEditor node={makeNode({ nodeType: "note" })} />,
    );
    expect(note.container.firstChild).toBeNull();
  });
});
