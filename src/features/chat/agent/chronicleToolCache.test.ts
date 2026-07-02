import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";

const apiMock = vi.hoisted(() => ({
  listEvents: vi.fn(async () => [{ id: "e1" }]),
  listSceneEventsForProject: vi.fn(async () => [
    { sceneId: "s1", eventId: "e1" },
  ]),
}));
vi.mock("@/features/chronicle/api", () => apiMock);

const codexMock = vi.hoisted(() => ({
  listCodexMatchTargets: vi.fn(async () => [{ id: "c1", name: "アリス" }]),
}));
vi.mock("@/features/codex/api", () => codexMock);

const phaseMock = vi.hoisted(() => ({
  computeGlobalSceneOrder: vi.fn(() => new Map([["s1", 0]])),
}));
vi.mock("@/features/codex/phaseResolver", () => phaseMock);

import {
  getSharedEvents,
  getSharedSceneEvents,
  getSharedCodexNames,
  getSharedReadingOrder,
  invalidateChronicleToolCache,
} from "./chronicleToolCache";
import { beginAgentToolTurn } from "./toolTurnCache";

beforeEach(() => {
  invalidateChronicleToolCache();
  apiMock.listEvents.mockClear();
  apiMock.listSceneEventsForProject.mockClear();
  codexMock.listCodexMatchTargets.mockClear();
  phaseMock.computeGlobalSceneOrder.mockClear();
});

describe("chronicleToolCache", () => {
  it("同一 projectId の events / sceneEvents / codexNames はロード 1 回に畳む", async () => {
    await getSharedEvents("p1");
    await getSharedEvents("p1");
    await getSharedSceneEvents("p1");
    await getSharedSceneEvents("p1");
    const names = await getSharedCodexNames("p1");
    await getSharedCodexNames("p1");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(1);
    expect(apiMock.listSceneEventsForProject).toHaveBeenCalledTimes(1);
    expect(codexMock.listCodexMatchTargets).toHaveBeenCalledTimes(1);
    expect(names.get("c1")).toBe("アリス");
  });

  it("projectId が変わると再ロードする（プロジェクト切替で必ず無効化）", async () => {
    await getSharedEvents("p1");
    await getSharedEvents("p2");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
    expect(apiMock.listEvents).toHaveBeenLastCalledWith("p2");
  });

  it("invalidateChronicleToolCache で全て再ロードする", async () => {
    await getSharedEvents("p1");
    await getSharedSceneEvents("p1");
    await getSharedCodexNames("p1");
    invalidateChronicleToolCache();
    await getSharedEvents("p1");
    await getSharedSceneEvents("p1");
    await getSharedCodexNames("p1");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
    expect(apiMock.listSceneEventsForProject).toHaveBeenCalledTimes(2);
    expect(codexMock.listCodexMatchTargets).toHaveBeenCalledTimes(2);
  });

  it("beginAgentToolTurn（ターン境界）でも破棄される", async () => {
    await getSharedEvents("p1");
    beginAgentToolTurn();
    await getSharedEvents("p1");
    expect(apiMock.listEvents).toHaveBeenCalledTimes(2);
  });

  it("readingOrder は同一 nodes 参照の間だけ再計算しない", () => {
    const nodes = [] as unknown as TreeNodeData[];
    const first = getSharedReadingOrder(nodes);
    expect(getSharedReadingOrder(nodes)).toBe(first);
    expect(phaseMock.computeGlobalSceneOrder).toHaveBeenCalledTimes(1);
    // 新しい参照（tree の immutable 更新）では再計算する。
    getSharedReadingOrder([] as unknown as TreeNodeData[]);
    expect(phaseMock.computeGlobalSceneOrder).toHaveBeenCalledTimes(2);
  });
});
