import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/features/chronicle/api";
import { debugLog } from "@/lib/debugLog";

const m = vi.hoisted(() => ({
  getProjectCalendar: vi.fn(),
  listEventParticipantsForProject: vi.fn(),
  listEventRelations: vi.fn(),
  listEvents: vi.fn(),
  listSceneEventsForProject: vi.fn(),
  listCodexIdsHiddenFromAi: vi.fn(),
}));

vi.mock("@/features/chronicle/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chronicle/api")>()),
  getProjectCalendar: m.getProjectCalendar,
  listEventParticipantsForProject: m.listEventParticipantsForProject,
  listEventRelations: m.listEventRelations,
  listEvents: m.listEvents,
  listSceneEventsForProject: m.listSceneEventsForProject,
}));

vi.mock(
  "@/features/codex/context/codexHiddenFromAi",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/codex/context/codexHiddenFromAi")
    >()),
    listCodexIdsHiddenFromAi: m.listCodexIdsHiddenFromAi,
  }),
);

import { buildChronicleSnapshotTextForScene } from "./chatContextPreparationComposition";

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "secret-event",
    projectId: "project-1",
    title: "秘密の出来事",
    note: null,
    detail: null,
    ordinal: "a0",
    primaryCodexId: "primary-id",
    laneGroup: null,
    locationCodexId: "location-id",
    startTime: null,
    endTime: null,
    startMinute: null,
    endMinute: null,
    startGranularity: "none",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
    secret: true,
    revealSceneId: "later-scene",
    version: 1,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function setChronicleRows(events: EventRow[]) {
  m.listEvents.mockResolvedValue(events);
  m.listEventParticipantsForProject.mockResolvedValue(
    events.length > 0
      ? [
          {
            eventId: "secret-event",
            codexEntryId: "participant-id",
            role: null,
          },
        ]
      : [],
  );
  m.listSceneEventsForProject.mockResolvedValue([]);
  m.getProjectCalendar.mockResolvedValue(null);
  m.listEventRelations.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  setChronicleRows([event()]);
  m.listCodexIdsHiddenFromAi.mockResolvedValue(new Set());
});

describe("buildChronicleSnapshotTextForScene", () => {
  it("checks all candidate ids, hides hidden people, and includes secret events", async () => {
    // 日付つきの場面と、その前の出来事。hidden が無ければ、人物の名前・id が年表のまとめに出る
    // 入力にする（出ないことの assertion が、そもそも出ない入力で空虚に通らないように）。
    setChronicleRows([
      event({
        startTime: 10,
        startGranularity: "day",
      }),
    ]);
    const sceneNode = {
      id: "scene-1",
      projectId: "project-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Scene",
      synopsis: null,
      intent: null,
      sortOrder: "a0",
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      chronicleStartTime: 100,
      chronicleStartGranularity: "day" as const,
      chroniclePrecision: "exact" as const,
      charCount: 0,
      createdAt: "",
      updatedAt: "",
    };
    const laterSceneNode = {
      ...sceneNode,
      id: "later-scene",
      title: "Later Scene",
      sortOrder: "a1",
      chronicleStartTime: null,
      chronicleStartGranularity: "none" as const,
    };
    const names = () =>
      new Map([
        ["primary-id", "Primary Name"],
        ["location-id", "Location Name"],
        ["participant-id", "Participant Name"],
        ["name-id", "Map Name"],
      ]);
    const build = () =>
      buildChronicleSnapshotTextForScene(
        "project-1",
        "scene-1",
        [sceneNode, laterSceneNode],
        "ja",
        names(),
        ["scene-id"],
        ["mention-id"],
        true,
      );
    const hiddenIds = [
      "location-id",
      "mention-id",
      "name-id",
      "participant-id",
      "primary-id",
      "scene-id",
    ];

    // 基準：hidden が無ければ、人物の名前・id が出る（この入力は、除去の有無を区別できる）。
    m.listCodexIdsHiddenFromAi.mockResolvedValueOnce(new Set());
    const baseline = await build();
    expect(baseline).toContain("秘密の出来事");
    expect(baseline).toContain("（読者にはまだ明かされていない）");
    for (const value of [
      "Primary Name",
      "Participant Name",
      "Location Name",
      "mention-id",
      "scene-id",
    ]) {
      expect(baseline, `baseline must contain ${value}`).toContain(value);
    }

    // hidden を渡すと、同じ入力から、名前も id も消え、出来事は残る。
    m.listCodexIdsHiddenFromAi.mockResolvedValueOnce(new Set(hiddenIds));
    const text = await build();

    expect(m.listCodexIdsHiddenFromAi).toHaveBeenLastCalledWith({
      entryIds: hiddenIds,
      projectId: "project-1",
      sceneId: "scene-1",
    });
    expect(text).toContain("秘密の出来事");
    for (const value of [
      ...hiddenIds,
      "Primary Name",
      "Location Name",
      "Participant Name",
      "Map Name",
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it("shows neither a hidden place nor an older place when the latest place is hidden", async () => {
    // 見える人物 P の最新の所在が hidden の場所のとき、場所は出ず、より前の（見える）場所にも戻らない。
    // 出来事の locationCodexId を残し、名前の表からだけ落とす設計（DR-CSR-6）を固定する。
    const placeEvent = (id: string, place: string, startTime: number) =>
      event({
        id,
        title: `出来事 ${id}`,
        secret: false,
        primaryCodexId: "person-id",
        locationCodexId: place,
        startTime,
        startGranularity: "day",
        ordinal: id,
      });
    setChronicleRows([
      placeEvent("e-old", "old-place-id", 5),
      placeEvent("e-new", "new-place-id", 10),
    ]);
    m.listEventParticipantsForProject.mockResolvedValue([]);
    const sceneNode = {
      id: "scene-1",
      projectId: "project-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Scene",
      synopsis: null,
      intent: null,
      sortOrder: "a0",
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      chronicleStartTime: 100,
      chronicleStartGranularity: "day" as const,
      chroniclePrecision: "exact" as const,
      charCount: 0,
      createdAt: "",
      updatedAt: "",
    };
    const build = () =>
      buildChronicleSnapshotTextForScene(
        "project-1",
        "scene-1",
        [sceneNode],
        "ja",
        new Map([
          ["person-id", "Person Name"],
          ["old-place-id", "Old Place"],
          ["new-place-id", "New Place"],
        ]),
        [],
        [],
        true,
      );

    // 基準：hidden が無ければ、最新の所在（新しい場所）が出る。
    m.listCodexIdsHiddenFromAi.mockResolvedValueOnce(new Set());
    const baseline = await build();
    expect(baseline).toContain("Person Name");
    expect(baseline).toContain("New Place");
    expect(baseline).not.toContain("Old Place");

    // 最新の場所が hidden：場所は出ず、古い場所にも戻らない。人物は出る。
    m.listCodexIdsHiddenFromAi.mockResolvedValueOnce(new Set(["new-place-id"]));
    const text = await build();
    expect(text).toContain("Person Name");
    expect(text).not.toContain("New Place");
    expect(text).not.toContain("new-place-id");
    expect(text).not.toContain("Old Place");
  });

  it("skips the chronicle summary if hidden Codex resolution fails", async () => {
    m.listCodexIdsHiddenFromAi.mockRejectedValueOnce(new Error("offline"));
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});

    const text = await buildChronicleSnapshotTextForScene(
      "project-1",
      "scene-1",
      [],
      "ja",
      new Map(),
      [],
      [],
      true,
    );

    expect(text).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "ChatContextPreparation",
      expect.stringContaining("Chronicle snapshot skipped"),
      expect.anything(),
    );
  });

  it("does not resolve hidden ids when the candidate list is empty", async () => {
    setChronicleRows([]);

    await buildChronicleSnapshotTextForScene(
      "project-1",
      "scene-1",
      [
        {
          id: "scene-1",
          projectId: "project-1",
          parentId: null,
          nodeType: "scene",
          title: "Scene",
          synopsis: null,
          intent: null,
          sortOrder: "a0",
          status: null,
          storyTimeOrder: null,
          storyTimeLabel: null,
          povCharacterId: null,
          locationId: null,
          chronicleStartTime: 1,
          chronicleStartGranularity: "day",
          chroniclePrecision: "exact",
          charCount: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      "ja",
      new Map(),
      [],
      [],
      true,
    );

    expect(m.listCodexIdsHiddenFromAi).not.toHaveBeenCalled();
  });
});
