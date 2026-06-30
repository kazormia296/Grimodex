// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import type { EventRow } from "./api";

// ── ./api を丸ごとモック（DB に触らせない）。読み取りのみ。 ──
const apiMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  listSceneEvents: vi.fn(),
  listEventRelations: vi.fn(),
  listEventParticipantsForProject: vi.fn(),
}));
vi.mock("./api", () => apiMocks);

// ── 手動 CRUD は tracked-write（ui* ラッパ）経由になったのでこちらをモック ──
const eventMocks = vi.hoisted(() => ({
  uiCreateEvent: vi.fn(),
  uiUpdateEvent: vi.fn(),
  uiDeleteEvent: vi.fn(),
  uiAddEventRelation: vi.fn(),
  uiRemoveEventRelation: vi.fn(),
  uiSetEventParticipants: vi.fn(),
}));
vi.mock("@/features/agent-writes/event", () => eventMocks);

// ── toast（sonner）をモックしてエラー通知の発火だけ検証 ──
const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMocks }));

// ── 暦/季節フックは DB と本文ロードに依存するのでスタブ化 ──
vi.mock("./useSeasonConflicts", () => ({
  useSeasonConflicts: () => ({
    hasCalendar: false,
    calendar: null,
    conflicts: [],
    conflictIds: new Set<string>(),
    ageConflicts: [],
    ageConflictIds: new Set<string>(),
    saveCalendar: vi.fn(),
    ensureDefaultCalendar: vi.fn(),
  }),
}));

// ── 重い子コンポーネントは観測しやすいテストダブルへ差し替える ──
vi.mock("./ChronicleViewport", () => ({
  ChronicleViewport: ({ eventsById }: { eventsById: Map<string, unknown> }) => (
    <div data-testid="viewport" data-n={eventsById.size} />
  ),
}));
vi.mock("./ChronicleToolbar", () => ({ ChronicleToolbar: () => null }));
vi.mock("./ChronicleInspector", () => ({
  ChronicleInspector: ({
    event,
    onPatch,
  }: {
    event: EventRow;
    onPatch: (patch: Partial<EventRow>) => void;
  }) => (
    <div>
      <span data-testid="insp-title">{event.title}</span>
      <button
        data-testid="patch-btn"
        onClick={() => onPatch({ title: "新題" })}
      >
        patch
      </button>
    </div>
  ),
}));
vi.mock("./ChronicleTieView", () => ({ ChronicleTieView: () => null }));
vi.mock("./ChronicleCalendarEditor", () => ({
  ChronicleCalendarEditor: () => null,
}));
vi.mock("./ChronicleExtractDialog", () => ({
  ChronicleExtractDialog: () => null,
}));

import { ChroniclePanel } from "./ChroniclePanel";
import { useProjectStore } from "@/features/project/projectStore";
import { useChronicleStore } from "./chronicleStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";

const NOW = "2026-06-27T00:00:00.000Z";

function makeEvent(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "ea",
    projectId: "p1",
    title: "原題",
    note: null,
    detail: null,
    ordinal: "a0",
    primaryCodexId: null,
    locationCodexId: null,
    startTime: null,
    endTime: null,
    startMinute: null,
    endMinute: null,
    startGranularity: "none",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
    secret: false,
    revealSceneId: null,
    laneGroup: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ currentProjectId: null });
  useChronicleStore.setState({ selectedEventId: null });
  useCodexStore.setState({ entries: [] });
  useTimelineStore.setState({ selectedNodeIds: [] });
  useTreeStore.setState({ nodes: [] });
  apiMocks.listSceneEvents.mockResolvedValue([]);
  apiMocks.listEventRelations.mockResolvedValue([]);
  apiMocks.listEventParticipantsForProject.mockResolvedValue([]);
  eventMocks.uiCreateEvent.mockResolvedValue({ id: "new", title: "" });
  eventMocks.uiUpdateEvent.mockResolvedValue(undefined);
  eventMocks.uiDeleteEvent.mockResolvedValue(undefined);
  eventMocks.uiAddEventRelation.mockResolvedValue(undefined);
  eventMocks.uiRemoveEventRelation.mockResolvedValue(undefined);
});

describe("ChroniclePanel project switch", () => {
  it("プロジェクト切替で新データ到着前に旧 events と選択を捨てる", async () => {
    // p1 は即解決、p2 は保留(=新データ未到着の状態を再現)。
    let resolveP2: (rows: EventRow[]) => void = () => {};
    const p2Pending = new Promise<EventRow[]>((res) => {
      resolveP2 = res;
    });
    apiMocks.listEvents.mockImplementation((pid: string) => {
      if (pid === "p1") return Promise.resolve([makeEvent({ id: "ea" })]);
      if (pid === "p2") return p2Pending;
      return Promise.resolve([]);
    });

    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);

    // p1 のデータが描画される（viewport が出る = events 1件）。
    const vp = await screen.findByTestId("viewport");
    expect(vp.getAttribute("data-n")).toBe("1");

    // 旧プロジェクトの出来事を選択しておく。
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });
    expect(useChronicleStore.getState().selectedEventId).toBe("ea");

    // p2 へ切替。新データはまだ来ない。
    act(() => {
      useProjectStore.setState({ currentProjectId: "p2" });
    });

    // 新データ到着前に旧 events は消えている（viewport 消失）し、選択も null。
    expect(screen.queryByTestId("viewport")).toBeNull();
    expect(useChronicleStore.getState().selectedEventId).toBeNull();

    // 後片付け（保留 promise を解決させてリーク回避）。
    await act(async () => {
      resolveP2([]);
      await p2Pending;
    });
  });
});

describe("ChroniclePanel optimistic patch", () => {
  it("uiUpdateEvent 失敗時に楽観更新を巻き戻し、エラーを通知する", async () => {
    apiMocks.listEvents.mockResolvedValue([
      makeEvent({ id: "ea", title: "原題" }),
    ]);
    eventMocks.uiUpdateEvent.mockRejectedValueOnce(new Error("boom"));

    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);

    await screen.findByTestId("viewport");

    // 出来事を選択して Inspector を表示。
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });
    expect(screen.getByTestId("insp-title").textContent).toBe("原題");

    // patch をトリガ → 楽観更新→失敗→巻き戻し。
    fireEvent.click(screen.getByTestId("patch-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("insp-title").textContent).toBe("原題");
    });
    expect(eventMocks.uiUpdateEvent).toHaveBeenCalledWith({
      eventId: "ea",
      title: "新題",
    });
    expect(toastMocks.error).toHaveBeenCalledTimes(1);
  });
});
