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
  uiLinkSceneEvent: vi.fn(),
  uiUnlinkSceneEvent: vi.fn(),
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
  ChronicleViewport: ({
    eventsById,
    onMoveEvent,
    onDeleteEvent,
  }: {
    eventsById: Map<string, unknown>;
    onMoveEvent?: (
      id: string,
      newStartDay: number | null,
      newCodexId: string | null,
    ) => void;
    onDeleteEvent?: (id: string) => void;
  }) => (
    <div data-testid="viewport" data-n={eventsById.size}>
      <button
        data-testid="move-scene-btn"
        onClick={() => onMoveEvent?.("scene:sc1", 200, null)}
      >
        move
      </button>
      <button
        data-testid="ctx-delete-scene-btn"
        onClick={() => onDeleteEvent?.("scene:sc1")}
      >
        ctx-delete
      </button>
    </div>
  ),
}));
vi.mock("./ChronicleToolbar", () => ({ ChronicleToolbar: () => null }));
vi.mock("./ChronicleInspector", () => ({
  ChronicleInspector: ({
    event,
    isScene,
    onPatch,
    onDelete,
    onLinkScene,
    onUnlinkScene,
  }: {
    event: EventRow;
    isScene?: boolean;
    onPatch: (patch: Partial<EventRow>) => void;
    onDelete: () => void;
    onLinkScene?: (sceneId: string) => void;
    onUnlinkScene?: (sceneId: string) => void;
  }) => (
    <div>
      <span data-testid="insp-title">{event.title}</span>
      <span data-testid="insp-is-scene">{isScene ? "yes" : "no"}</span>
      <button
        data-testid="patch-btn"
        onClick={() => onPatch({ title: "新題" })}
      >
        patch
      </button>
      <button data-testid="delete-btn" onClick={() => onDelete()}>
        delete
      </button>
      <button data-testid="link-btn" onClick={() => onLinkScene?.("s1")}>
        link
      </button>
      <button data-testid="unlink-btn" onClick={() => onUnlinkScene?.("s1")}>
        unlink
      </button>
    </div>
  ),
}));
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
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
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
  // scene-event 書き戻し先のツリーストア action は DB を叩くので mock に差し替える。
  useTreeStore.setState({
    nodes: [],
    updateNodeTitle: vi.fn().mockResolvedValue(undefined),
    updateSynopsis: vi.fn().mockResolvedValue(undefined),
    updatePovCharacter: vi.fn().mockResolvedValue(undefined),
    updateLocation: vi.fn().mockResolvedValue(undefined),
    updateChronicleDate: vi.fn().mockResolvedValue(undefined),
  });
  apiMocks.listSceneEvents.mockResolvedValue([]);
  apiMocks.listEventRelations.mockResolvedValue([]);
  apiMocks.listEventParticipantsForProject.mockResolvedValue([]);
  eventMocks.uiCreateEvent.mockResolvedValue({ id: "new", title: "" });
  eventMocks.uiUpdateEvent.mockResolvedValue(undefined);
  eventMocks.uiDeleteEvent.mockResolvedValue(undefined);
  eventMocks.uiAddEventRelation.mockResolvedValue(undefined);
  eventMocks.uiRemoveEventRelation.mockResolvedValue(undefined);
  eventMocks.uiLinkSceneEvent.mockResolvedValue(undefined);
  eventMocks.uiUnlinkSceneEvent.mockResolvedValue(undefined);
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

describe("ChroniclePanel scene link", () => {
  it("onLinkScene で uiLinkSceneEvent(sceneId, eventId) を呼び、成功後に再ロードする", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });

    const before = apiMocks.listSceneEvents.mock.calls.length;
    fireEvent.click(screen.getByTestId("link-btn"));

    await waitFor(() => {
      expect(eventMocks.uiLinkSceneEvent).toHaveBeenCalledWith("s1", "ea");
    });
    // refresh() が reloadKey を bump → ロード effect 再実行で scene 橋を読み直す。
    await waitFor(() => {
      expect(apiMocks.listSceneEvents.mock.calls.length).toBeGreaterThan(
        before,
      );
    });
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("onUnlinkScene 失敗時はエラーを通知する", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    eventMocks.uiUnlinkSceneEvent.mockRejectedValueOnce(new Error("boom"));
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });

    fireEvent.click(screen.getByTestId("unlink-btn"));

    await waitFor(() => {
      expect(eventMocks.uiUnlinkSceneEvent).toHaveBeenCalledWith("s1", "ea");
    });
    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledTimes(1);
    });
  });
});

function makeScene(over: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: "sc1",
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: "旅立ち",
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status: "draft",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    chronicleStartTime: 100,
    chronicleStartMinute: null,
    chronicleStartGranularity: "day",
    chronicleEndTime: null,
    chronicleEndMinute: null,
    chronicleEndGranularity: "none",
    chroniclePrecision: "exact",
    charCount: 0,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("ChroniclePanel scene-event union", () => {
  it("作中日付を持つシーンは実イベント0でもトークンとして現れる", async () => {
    apiMocks.listEvents.mockResolvedValue([]); // 実イベントなし
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    const vp = await screen.findByTestId("viewport");
    expect(vp.getAttribute("data-n")).toBe("1"); // scene-event 1件
  });

  it("scene-event 選択で isScene モードになり、編集はツリーストアへ書き戻す（uiUpdateEvent は呼ばない）", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "scene:sc1" });
    });
    expect(screen.getByTestId("insp-is-scene").textContent).toBe("yes");

    fireEvent.click(screen.getByTestId("patch-btn")); // onPatch({title:"新題"})
    await waitFor(() => {
      expect(useTreeStore.getState().updateNodeTitle).toHaveBeenCalledWith(
        "sc1",
        "新題",
      );
    });
    expect(eventMocks.uiUpdateEvent).not.toHaveBeenCalled();
  });

  it("scene-event の削除は作中日付クリア（uiDeleteEvent は呼ばない）", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "scene:sc1" });
    });

    fireEvent.click(screen.getByTestId("delete-btn"));
    await waitFor(() => {
      expect(useTreeStore.getState().updateChronicleDate).toHaveBeenCalledWith(
        "sc1",
        expect.objectContaining({ chronicleStartTime: null }),
      );
    });
    expect(eventMocks.uiDeleteEvent).not.toHaveBeenCalled();
  });

  it("scene-event のドラッグ再配置は作中日付へ書き戻す（uiUpdateEvent は呼ばない）", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({
      nodes: [makeScene({ id: "sc1", chronicleStartTime: 100 })],
    });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");

    fireEvent.click(screen.getByTestId("move-scene-btn")); // onMoveEvent("scene:sc1",200,null)
    await waitFor(() => {
      expect(useTreeStore.getState().updateChronicleDate).toHaveBeenCalledWith(
        "sc1",
        expect.objectContaining({ chronicleStartTime: 200 }),
      );
    });
    expect(eventMocks.uiUpdateEvent).not.toHaveBeenCalled();
  });

  it("コンテキストメニュー削除も scene-event は作中日付クリア（uiDeleteEvent は呼ばない）", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");

    fireEvent.click(screen.getByTestId("ctx-delete-scene-btn"));
    await waitFor(() => {
      expect(useTreeStore.getState().updateChronicleDate).toHaveBeenCalledWith(
        "sc1",
        expect.objectContaining({ chronicleStartTime: null }),
      );
    });
    expect(eventMocks.uiDeleteEvent).not.toHaveBeenCalled();
  });

  it("一括削除は scene=日付クリア / 実event=削除 に振り分ける（混在で片方も落ちない）", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.getState().setSelection(["ea", "scene:sc1"], "ea"); // 実+scene 混在
    });

    fireEvent.click(screen.getByTestId("bulk-delete"));
    await waitFor(() => {
      expect(eventMocks.uiDeleteEvent).toHaveBeenCalledWith("ea");
    });
    expect(useTreeStore.getState().updateChronicleDate).toHaveBeenCalledWith(
      "sc1",
      expect.objectContaining({ chronicleStartTime: null }),
    );
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("一括レーン割当は scene=POV更新 / 実event=uiUpdateEvent に振り分ける", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.getState().setSelection(["ea", "scene:sc1"], "ea");
    });

    fireEvent.click(screen.getByTestId("bulk-unassign")); // handleBulkAssign("")
    await waitFor(() => {
      expect(useTreeStore.getState().updatePovCharacter).toHaveBeenCalledWith(
        "sc1",
        null,
      );
    });
    expect(eventMocks.uiUpdateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ea" }),
    );
  });

  it("通常イベント選択は isScene=no のまま", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });
    expect(screen.getByTestId("insp-is-scene").textContent).toBe("no");
  });
});
