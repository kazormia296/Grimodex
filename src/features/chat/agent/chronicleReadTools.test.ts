import { describe, it, expect, vi, beforeEach } from "vitest";

// データソースを mock し、executor の orchestration（XPROJ fail-closed・整形）を検証する。
const treeState = {
  projectId: "p1" as string,
  nodes: [{ id: "s1", title: "シーン1" }] as { id: string; title: string }[],
  activeSceneId: "s1" as string,
};
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => treeState },
}));
vi.mock("@/features/codex/phaseResolver", () => ({
  computeGlobalSceneOrder: () => new Map([["s1", 0]]),
}));

const events: unknown[] = [];
const participants: unknown[] = [];
const sceneEvents: unknown[] = [];
const relations: unknown[] = [];
let calendarRow: unknown = null;
const codexEntries: { id: string; name: string }[] = [];

vi.mock("@/features/chronicle/api", () => ({
  listEvents: vi.fn(async () => events),
  listEventParticipantsForProject: vi.fn(async () => participants),
  listSceneEventsForProject: vi.fn(async () => sceneEvents),
  listEventRelations: vi.fn(async () => relations),
  getProjectCalendar: vi.fn(async () => calendarRow),
}));
vi.mock("@/features/codex/api", () => ({
  listCodexMatchTargets: vi.fn(async () => codexEntries),
}));

import * as chronicleApi from "@/features/chronicle/api";
import { listCodexMatchTargets } from "@/features/codex/api";
import {
  listEventsTool,
  getEventDetailTool,
  getCharacterTimelineTool,
  getChronicleStateTool,
} from "./chronicleReadTools";
import { invalidateChronicleToolCache } from "./chronicleToolCache";

function ev(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p.id,
    projectId: "p1",
    title: p.title ?? p.id,
    note: p.note ?? null,
    ordinal: p.ordinal ?? "a0",
    primaryCodexId: p.primaryCodexId ?? null,
    locationCodexId: p.locationCodexId ?? null,
    startTime: p.startTime ?? null,
    endTime: p.endTime ?? null,
    startMinute: p.startMinute ?? null,
    endMinute: p.endMinute ?? null,
    startGranularity: p.startGranularity ?? "none",
    endGranularity: p.endGranularity ?? "none",
    precision: "exact",
    kind: p.kind ?? "generic",
    createdAt: "",
    updatedAt: "",
  };
}

/** 12ヶ月×30日・startYear 1000 の暦行（暦整形の startDate 検証用）。 */
function calWithMonths(): Record<string, unknown> {
  return {
    projectId: "p1",
    daysPerYear: 360,
    seasonBoundaries: "[]",
    startYear: 1000,
    months: JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({ name: `${i + 1}月`, days: 30 })),
    ),
    weekdayNames: "[]",
    weekdayStartIndex: 0,
    leapRule: '{"kind":"none"}',
    ageReckoning: "full",
    eras: "[]",
    reform: "null",
    timezone: "null",
    lunarTzMinutes: 480,
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  treeState.projectId = "p1";
  treeState.activeSceneId = "s1";
  events.length = 0;
  participants.length = 0;
  sceneEvents.length = 0;
  relations.length = 0;
  calendarRow = null;
  codexEntries.length = 0;
  // ターン内共有キャッシュをテスト間で持ち越さない（runAgentLoop の毎ターン破棄相当）。
  invalidateChronicleToolCache();
  vi.mocked(chronicleApi.listEvents).mockClear();
  vi.mocked(chronicleApi.listSceneEventsForProject).mockClear();
  vi.mocked(listCodexMatchTargets).mockClear();
});

describe("listEventsTool", () => {
  it("primaryCharacter 名を解決して返す＋kind フィルタ", async () => {
    events.push(
      ev({ id: "e1", title: "戴冠", kind: "generic", primaryCodexId: "c1" }),
      ev({ id: "b1", title: "誕生", kind: "birth", primaryCodexId: "c1" }),
    );
    codexEntries.push({ id: "c1", name: "アリス" });

    const all = await listEventsTool({});
    expect((all.content as { events: unknown[] }).events).toHaveLength(2);
    expect(
      (all.content as { events: { primaryCharacter: string }[] }).events[0]
        .primaryCharacter,
    ).toBe("アリス");

    const births = await getContentEvents(
      await listEventsTool({ kind: "birth" }),
    );
    expect(births).toHaveLength(1);
    expect(births[0].title).toBe("誕生");
  });

  it("プロジェクト未設定で fail-closed", async () => {
    treeState.projectId = "";
    const r = await listEventsTool({});
    expect(r.summary).toBe("No active project");
  });

  it("暦設定時に各イベントへ暦整形済み startDate を付す（暦なし/粒度 none は null）", async () => {
    calendarRow = calWithMonths();
    events.push(
      {
        ...ev({ id: "e1", title: "戴冠", startTime: 0 }),
        startGranularity: "day",
      },
      ev({ id: "e2", title: "順序のみ" }), // startTime null / 粒度 none
    );
    const evs = (await listEventsTool({})).content as {
      events: { id: string; startDate: string | null }[];
    };
    expect(evs.events.find((e) => e.id === "e1")?.startDate).toContain(
      "1000年",
    );
    expect(evs.events.find((e) => e.id === "e2")?.startDate).toBeNull();
  });
});

async function getContentEvents(
  r: Awaited<ReturnType<typeof listEventsTool>>,
): Promise<{ title: string }[]> {
  return (r.content as { events: { title: string }[] }).events;
}

describe("getEventDetailTool", () => {
  it("プロジェクト外/不明 eventId は not found（XPROJ）", async () => {
    events.push(ev({ id: "e1" }));
    const r = await getEventDetailTool({ eventId: "foreign" });
    expect(r.content).toBeNull();
    expect(r.summary).toBe("Event not found");
  });

  it("参加者・紐づきシーン・因果を名前付きで返す", async () => {
    events.push(
      ev({
        id: "e1",
        title: "毒殺",
        primaryCodexId: "c1",
        locationCodexId: "loc1",
      }),
      ev({ id: "e2", title: "王の死" }),
    );
    participants.push({ eventId: "e1", codexEntryId: "c2", role: "実行犯" });
    sceneEvents.push({ sceneId: "s1", eventId: "e1" });
    relations.push({ causeId: "e1", effectId: "e2" });
    codexEntries.push(
      { id: "c1", name: "アリス" },
      { id: "c2", name: "ボブ" },
      { id: "loc1", name: "城" },
    );

    const r = await getEventDetailTool({ eventId: "e1" });
    const c = r.content as {
      primaryCharacter: string;
      location: string;
      participants: { name: string; role: string }[];
      scenes: { title: string }[];
      relations: { cause: string; effect: string }[];
    };
    expect(c.primaryCharacter).toBe("アリス");
    expect(c.location).toBe("城");
    expect(c.participants).toEqual([
      { codexId: "c2", name: "ボブ", role: "実行犯" },
    ]);
    expect(c.scenes).toEqual([{ sceneId: "s1", title: "シーン1" }]);
    expect(c.relations).toEqual([{ cause: "毒殺", effect: "王の死" }]);
  });

  it("暦設定時に startDate/endDate を暦整形して付す（粒度 none/暦なしは null）", async () => {
    calendarRow = calWithMonths();
    events.push({
      ...ev({ id: "e1", title: "祭", startTime: 0, endTime: 90 }),
      startGranularity: "day",
      endGranularity: "day",
    });
    const c = (await getEventDetailTool({ eventId: "e1" })).content as {
      startDate: string | null;
      endDate: string | null;
    };
    expect(c.startDate).toContain("1000年"); // day0 = 1000年1月1日
    expect(c.endDate).toContain("1000年4月1日"); // day90 = 4月1日
  });
});

describe("getCharacterTimelineTool", () => {
  it("関与イベントを作中順＋各時点年齢で返す", async () => {
    calendarRow = {
      projectId: "p1",
      daysPerYear: 360,
      seasonBoundaries: "[]",
      createdAt: "",
      updatedAt: "",
    };
    events.push(
      ev({
        id: "b",
        title: "誕生",
        kind: "birth",
        primaryCodexId: "c1",
        startTime: 0,
        ordinal: "a0",
      }),
      ev({
        id: "e1",
        title: "初陣",
        primaryCodexId: "c1",
        startTime: 360,
        ordinal: "a2",
      }),
      ev({ id: "e2", title: "祝祭", startTime: 720, ordinal: "a4" }),
    );
    participants.push({ eventId: "e2", codexEntryId: "c1", role: null });
    codexEntries.push({ id: "c1", name: "アリス" });

    const r = await getCharacterTimelineTool({ codexId: "c1" });
    const c = r.content as {
      character: string;
      events: { title: string; ageAtEvent: number | null }[];
    };
    expect(c.character).toBe("アリス");
    expect(c.events.map((e) => e.title)).toEqual(["誕生", "初陣", "祝祭"]);
    expect(c.events.find((e) => e.title === "初陣")?.ageAtEvent).toBe(1);
    expect(c.events.find((e) => e.title === "祝祭")?.ageAtEvent).toBe(2);
  });

  it("codexId 無しは引数エラー", async () => {
    const r = await getCharacterTimelineTool({});
    expect(r.summary).toContain("codexId");
  });
});

describe("ターン内共有キャッシュ", () => {
  it("同一ターンの複数 read ツールで listEvents / codex 名をロードし直さない", async () => {
    events.push(ev({ id: "e1", title: "戴冠" }));
    sceneEvents.push({ sceneId: "s1", eventId: "e1" });
    codexEntries.push({ id: "c1", name: "アリス" });

    await listEventsTool({});
    await getEventDetailTool({ eventId: "e1" });
    await getChronicleStateTool({});

    expect(vi.mocked(chronicleApi.listEvents)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(chronicleApi.listSceneEventsForProject),
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listCodexMatchTargets)).toHaveBeenCalledTimes(1);
  });
});

describe("getChronicleStateTool", () => {
  it("sceneId 省略時は activeSceneId を使い構造化スナップショットを返す", async () => {
    events.push(ev({ id: "e1", title: "戴冠", ordinal: "a1" }));
    sceneEvents.push({ sceneId: "s1", eventId: "e1" });
    codexEntries.push({ id: "c1", name: "アリス" });

    const r = await getChronicleStateTool({});
    const snap = r.content as {
      time: { source: string };
      recentEvents: unknown[];
    };
    expect(snap.time.source).toBe("stamped");
    expect(r.summary).toContain("stamped");
  });

  it("events 0 件は明示メッセージ", async () => {
    const r = await getChronicleStateTool({});
    expect(r.content).toBeNull();
    expect(r.summary).toBe("No chronicle events");
  });

  it("eras 付き暦で formattedDate に元号が載る（calendarFromRow 一本化で欠落解消）", async () => {
    const months = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({ name: `${i + 1}月`, days: 30 })),
    );
    calendarRow = {
      projectId: "p1",
      daysPerYear: 360,
      seasonBoundaries: "[]",
      startYear: 1000,
      months,
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: '{"kind":"none"}',
      ageReckoning: "full",
      eras: '[{"name":"明治","startYear":1000}]',
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 480,
      createdAt: "",
      updatedAt: "",
    };
    // day0 = 暦年 1000 = 明治1年。粒度 day のイベントを stamp してアンカーを日付付きに。
    events.push({
      ...ev({ id: "e1", title: "戴冠", ordinal: "a1", startTime: 0 }),
      startGranularity: "day",
      startMinute: null,
      endGranularity: "none",
      endMinute: null,
    });
    sceneEvents.push({ sceneId: "s1", eventId: "e1" });

    const r = await getChronicleStateTool({});
    const snap = r.content as { time: { formattedDate: string | null } };
    // 旧 parseCalendar は eras を捨てるため "1000年1月1日"（元号なし）になっていた。
    expect(snap.time.formattedDate).toContain("明治");
  });
});
