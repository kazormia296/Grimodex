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

// ── SR announcer をモック（読み込み完了/ズーム通知の発火を検証） ──
const announceMocks = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("@/lib/a11y/announcer", () => announceMocks);

// ── tabStore.openPinned（シーンを開く）をモック ──
const tabMocks = vi.hoisted(() => ({ openPinned: vi.fn() }));
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => tabMocks },
}));

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
    onViewChange,
    onResizeSelectedBy,
  }: {
    eventsById: Map<string, unknown>;
    onMoveEvent?: (
      id: string,
      newStartDay: number | null,
      newCodexId: string | null,
    ) => void;
    onDeleteEvent?: (id: string) => void;
    onViewChange?: (v: { pxPerDay: number; viewStartDay: number }) => void;
    onResizeSelectedBy?: (edge: "start" | "end", deltaDays: number) => void;
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
      <button
        data-testid="zoom-btn"
        onClick={() => onViewChange?.({ pxPerDay: 9, viewStartDay: 0 })}
      >
        zoom
      </button>
      <button
        data-testid="pan-btn"
        onClick={() => onViewChange?.({ pxPerDay: 9, viewStartDay: 555 })}
      >
        pan
      </button>
      <button
        data-testid="resize-end-btn"
        onClick={() => onResizeSelectedBy?.("end", 5)}
      >
        resize-end
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
    onOpenScene,
  }: {
    event: EventRow;
    isScene?: boolean;
    onPatch: (patch: Partial<EventRow>) => void;
    onDelete: () => void;
    onLinkScene?: (sceneId: string, mode: "event" | "scene") => void;
    onUnlinkScene?: (sceneId: string) => void;
    onOpenScene?: () => void;
  }) => (
    <div>
      <span data-testid="insp-title">{event.title}</span>
      <span data-testid="insp-is-scene">{isScene ? "yes" : "no"}</span>
      <span data-testid="insp-can-open">{onOpenScene ? "yes" : "no"}</span>
      <button data-testid="open-scene-btn" onClick={() => onOpenScene?.()}>
        open-scene
      </button>
      <button
        data-testid="patch-btn"
        onClick={() => onPatch({ title: "新題" })}
      >
        patch
      </button>
      <button data-testid="delete-btn" onClick={() => onDelete()}>
        delete
      </button>
      <button
        data-testid="link-btn"
        onClick={() => onLinkScene?.("s1", "scene")}
      >
        link
      </button>
      <button
        data-testid="link-event-btn"
        onClick={() => onLinkScene?.("s1", "event")}
      >
        link-event
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
  useChronicleStore.setState({
    selectedEventId: null,
    selectedEventIds: [],
    pxPerDay: null,
    viewStartDay: null,
  });
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
    // scene 優先: シーン側プロパティへは書き戻さない。
    expect(useTreeStore.getState().updateChronicleDate).not.toHaveBeenCalled();
  });

  it("イベント優先リンクはイベントの日付/POV/場所をシーンへ同期する", async () => {
    apiMocks.listEvents.mockResolvedValue([
      makeEvent({
        id: "ea",
        startTime: 50,
        startGranularity: "day",
        primaryCodexId: "c1",
        locationCodexId: "loc1",
      }),
    ]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });

    fireEvent.click(screen.getByTestId("link-event-btn"));

    await waitFor(() => {
      expect(eventMocks.uiLinkSceneEvent).toHaveBeenCalledWith("s1", "ea");
    });
    expect(useTreeStore.getState().updateChronicleDate).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ chronicleStartTime: 50 }),
    );
    expect(useTreeStore.getState().updatePovCharacter).toHaveBeenCalledWith(
      "s1",
      "c1",
    );
    expect(useTreeStore.getState().updateLocation).toHaveBeenCalledWith(
      "s1",
      "loc1",
    );
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

describe("ChroniclePanel シーンを開く / 選択伝播", () => {
  it("scene-event 選択で Timeline とアクティブシーンが該当シーンへ同期する", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "scene:sc1" });
    });
    await waitFor(() => {
      expect(useTimelineStore.getState().selectedNodeIds).toContain("sc1");
    });
    expect(useTreeStore.getState().activeSceneId).toBe("sc1");
  });

  it("イベント選択解除で、同期していた Timeline 選択も解除する（related 薄リング残留の防止）", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "scene:sc1" });
    });
    await waitFor(() => {
      expect(useTimelineStore.getState().selectedNodeIds).toContain("sc1");
    });
    // 選択解除 → 自分が同期した Timeline 選択も外れる（薄い related リングを残さない）。
    act(() => {
      useChronicleStore.setState({
        selectedEventId: null,
        selectedEventIds: [],
      });
    });
    await waitFor(() => {
      expect(useTimelineStore.getState().selectedNodeIds).toEqual([]);
    });
  });

  it("ユーザーが Timeline で直接選び直した選択は、イベント選択解除で消さない", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({
      nodes: [makeScene({ id: "sc1" }), makeScene({ id: "sc2" })],
    });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "scene:sc1" });
    });
    await waitFor(() => {
      expect(useTimelineStore.getState().selectedNodeIds).toContain("sc1");
    });
    // ユーザーが Timeline 側で別 scene を選び直す（chronicle の同期とは別経路）。
    act(() => {
      useTimelineStore.getState().selectNode("sc2");
    });
    act(() => {
      useChronicleStore.setState({
        selectedEventId: null,
        selectedEventIds: [],
      });
    });
    // sc2（ユーザー選択）は据え置き（自分が同期した sc1 とは違うので触らない）。
    await waitFor(() => {
      expect(useTimelineStore.getState().selectedNodeIds).toEqual(["sc2"]);
    });
  });

  it("scene-event はインスペクタの「シーンを開く」で openPinned する", async () => {
    apiMocks.listEvents.mockResolvedValue([]);
    useTreeStore.setState({ nodes: [makeScene({ id: "sc1" })] });
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "scene:sc1" });
    });
    expect(screen.getByTestId("insp-can-open").textContent).toBe("yes");
    fireEvent.click(screen.getByTestId("open-scene-btn"));
    expect(tabMocks.openPinned).toHaveBeenCalledWith("sc1");
  });

  it("リンク済み実イベントも該当シーンを開け、選択で同期する", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    apiMocks.listSceneEvents.mockResolvedValue([
      { sceneId: "scLinked", eventId: "ea" },
    ]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("insp-can-open").textContent).toBe("yes");
    });
    fireEvent.click(screen.getByTestId("open-scene-btn"));
    expect(tabMocks.openPinned).toHaveBeenCalledWith("scLinked");
    expect(useTreeStore.getState().activeSceneId).toBe("scLinked");
  });

  it("scene 紐付けの無いイベントは「シーンを開く」を出さない", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    apiMocks.listSceneEvents.mockResolvedValue([]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({ selectedEventId: "ea" });
    });
    expect(screen.getByTestId("insp-can-open").textContent).toBe("no");
  });
});

describe("ChroniclePanel a11y announce（読み込み完了 / ズームレベル）", () => {
  it("プロジェクト読み込み完了で announce し、revision 再取得では鳴らさない", async () => {
    apiMocks.listEvents.mockResolvedValue([
      makeEvent({ id: "ea" }),
      makeEvent({ id: "eb" }),
    ]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    await waitFor(() => {
      expect(announceMocks.announce).toHaveBeenCalledTimes(1);
    });
    expect(String(announceMocks.announce.mock.calls[0][0])).toContain("2");

    // undo/CRUD 由来の再取得（revision bump）では読み込み announce を繰り返さない。
    const before = apiMocks.listEvents.mock.calls.length;
    act(() => {
      useChronicleStore.getState().bumpRevision();
    });
    await waitFor(() => {
      expect(apiMocks.listEvents.mock.calls.length).toBeGreaterThan(before);
    });
    await screen.findByTestId("viewport");
    expect(announceMocks.announce).toHaveBeenCalledTimes(1);
  });

  it("ズーム（pxPerDay 変化）は debounce 後に1回だけ announce、パンでは鳴らさない", async () => {
    apiMocks.listEvents.mockResolvedValue([makeEvent({ id: "ea" })]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    await waitFor(() => {
      expect(announceMocks.announce).toHaveBeenCalledTimes(1); // 読み込み分
    });
    announceMocks.announce.mockClear();

    // ズーム連打 → debounce（400ms）内は無音、経過後に1回だけ。
    fireEvent.click(screen.getByTestId("zoom-btn"));
    fireEvent.click(screen.getByTestId("zoom-btn"));
    expect(announceMocks.announce).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(announceMocks.announce).toHaveBeenCalledTimes(1);
    expect(String(announceMocks.announce.mock.calls[0][0])).toContain("ズーム");

    // パン（pxPerDay 同値・viewStartDay のみ変化）では announce しない。
    announceMocks.announce.mockClear();
    fireEvent.click(screen.getByTestId("pan-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(announceMocks.announce).not.toHaveBeenCalled();
  });
});

describe("ChroniclePanel キーボード期間端伸縮（onResizeSelectedBy）", () => {
  it("選択中の期間イベントの終了端を差分で patch する", async () => {
    apiMocks.listEvents.mockResolvedValue([
      makeEvent({
        id: "ea",
        startTime: 100,
        endTime: 110,
        startGranularity: "day",
        endGranularity: "day",
      }),
    ]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({
        selectedEventId: "ea",
        selectedEventIds: ["ea"],
      });
    });
    fireEvent.click(screen.getByTestId("resize-end-btn")); // ("end", +5)
    await waitFor(() => {
      expect(eventMocks.uiUpdateEvent).toHaveBeenCalledWith({
        eventId: "ea",
        endTime: 115,
      });
    });
  });

  it("点イベント（endTime なし）は対象外（patch しない）", async () => {
    apiMocks.listEvents.mockResolvedValue([
      makeEvent({ id: "ea", startTime: 100, startGranularity: "day" }),
    ]);
    useProjectStore.setState({ currentProjectId: "p1" });
    render(<ChroniclePanel />);
    await screen.findByTestId("viewport");
    act(() => {
      useChronicleStore.setState({
        selectedEventId: "ea",
        selectedEventIds: ["ea"],
      });
    });
    fireEvent.click(screen.getByTestId("resize-end-btn"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(eventMocks.uiUpdateEvent).not.toHaveBeenCalled();
  });
});
