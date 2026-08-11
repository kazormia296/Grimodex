import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { BindParams } from "sql.js";
import type { Database } from "sql.js";

type AgentWriteResult = {
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
};

// Native agent_event_* を sql.js 上で再現する共有ホルダー。
const chronicleTestDb = vi.hoisted(() => ({
  sqldb: undefined as Database | undefined,
  handleInvoke: undefined as
    | ((cmd: string, args?: Record<string, unknown>) => unknown)
    | undefined,
}));

vi.mock("i18next", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: vi.fn(() => false),
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "test-session",
  recordChangeEvent: vi.fn(),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));
vi.mock("@/features/chronicle/chronicleStore", () => ({
  useChronicleStore: {
    getState: () => ({ bumpRevision: vi.fn() }),
  },
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleEventIndex: vi.fn(),
}));
vi.mock("@/features/concurrency/documentWriteNotification", () => ({
  notifySameRendererDocumentWrite: vi.fn(),
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ isReplaying: false, push: vi.fn() }),
  },
}));
vi.mock("@/features/agent-writes/undoJournal", () => ({
  applyUndoJournal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) =>
    chronicleTestDb.handleInvoke?.(cmd, args),
  ),
}));

vi.mock("@/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/sqlite-proxy");
  const schema = await import("@/db/schema");
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — sql.js/dist/sql-asm.js has no dedicated type declarations
  const initSqlJs = (await import("sql.js/dist/sql-asm.js")).default;
  const SQL = await initSqlJs();
  const sqldb = new SQL.Database();
  sqldb.run(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      note TEXT,
      detail TEXT,
      ordinal TEXT NOT NULL DEFAULT 'a0',
      primary_codex_id TEXT,
      lane_group TEXT,
      location_codex_id TEXT,
      start_time INTEGER,
      end_time INTEGER,
      start_minute INTEGER,
      end_minute INTEGER,
      start_granularity TEXT NOT NULL DEFAULT 'none',
      end_granularity TEXT NOT NULL DEFAULT 'none',
      precision TEXT NOT NULL DEFAULT 'exact',
      kind TEXT NOT NULL DEFAULT 'generic',
      secret INTEGER NOT NULL DEFAULT 0,
      reveal_scene_id TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE event_relations (
      project_id TEXT NOT NULL,
      cause_event_id TEXT NOT NULL,
      effect_event_id TEXT NOT NULL,
      PRIMARY KEY (cause_event_id, effect_event_id)
    );
    CREATE TABLE event_participants (
      event_id TEXT NOT NULL,
      codex_entry_id TEXT NOT NULL,
      role TEXT,
      PRIMARY KEY (event_id, codex_entry_id)
    );
    CREATE TABLE tree_nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      node_type TEXT NOT NULL,
      title TEXT NOT NULL,
      synopsis TEXT,
      intent TEXT,
      sort_order TEXT NOT NULL,
      story_time_order TEXT,
      story_time_label TEXT,
      pov_character_id TEXT,
      location_id TEXT,
      chronicle_start_time INTEGER,
      chronicle_start_minute INTEGER,
      chronicle_start_granularity TEXT NOT NULL DEFAULT 'none',
      chronicle_end_time INTEGER,
      chronicle_end_minute INTEGER,
      chronicle_end_granularity TEXT NOT NULL DEFAULT 'none',
      chronicle_precision TEXT NOT NULL DEFAULT 'exact',
      status TEXT,
      content TEXT NOT NULL,
      unplaced_beats_doc TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      unplaced_beat_preview TEXT,
      placed_beat_preview TEXT,
      source_uri TEXT,
      source_mtime INTEGER,
      archived_at TEXT,
      context_mode TEXT,
      aliases TEXT,
      excluded_aliases TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE scene_events (
      scene_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (scene_id, event_id)
    );
  `);
  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      const stmt = sqldb.prepare(sql);
      stmt.bind(params as BindParams);
      const rows: unknown[][] = [];
      while (stmt.step()) rows.push(stmt.get());
      stmt.free();
      // 'get' は単一行の値配列を期待する。chronicle api は .all() のみ使うが念のため。
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema },
  );

  const NOW = "2026-06-27T00:00:00.000Z";

  function queryEventVersion(
    eventId: string,
    projectId: string,
  ): number | null {
    const stmt = sqldb.prepare(
      "SELECT version FROM events WHERE id = ? AND project_id = ?",
    );
    stmt.bind([eventId, projectId] as BindParams);
    const version = stmt.step() ? Number(stmt.get()[0]) : null;
    stmt.free();
    return version;
  }

  function agentWriteResult(
    entityId: string,
    version: number,
  ): AgentWriteResult {
    return {
      entityId,
      version,
      changeEventUid: "uid-test",
      undoJournalId: "journal-test",
    };
  }

  chronicleTestDb.sqldb = sqldb;
  chronicleTestDb.handleInvoke = (cmd, args) => {
    const payload = (args?.payload ?? args) as Record<string, unknown>;
    switch (cmd) {
      case "event_get_version":
        return queryEventVersion(
          String(args?.eventId ?? payload.eventId),
          String(args?.projectId ?? payload.projectId),
        );
      case "agent_event_create": {
        const eventId = String(payload.eventId);
        const projectId = String(payload.projectId);
        sqldb.run(
          `INSERT INTO events (
            id, project_id, title, note, detail, ordinal, primary_codex_id,
            location_codex_id, start_time, end_time, start_minute, end_minute,
            start_granularity, end_granularity, precision, kind, secret,
            reveal_scene_id, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            eventId,
            projectId,
            String(payload.title ?? ""),
            (payload.note as string | null | undefined) ?? null,
            (payload.detail as string | null | undefined) ?? null,
            String(payload.ordinal ?? "a0"),
            (payload.primaryCodexId as string | null | undefined) ?? null,
            (payload.locationCodexId as string | null | undefined) ?? null,
            (payload.startTime as number | null | undefined) ?? null,
            (payload.endTime as number | null | undefined) ?? null,
            (payload.startMinute as number | null | undefined) ?? null,
            (payload.endMinute as number | null | undefined) ?? null,
            String(payload.startGranularity ?? "none"),
            String(payload.endGranularity ?? "none"),
            String(payload.precision ?? "exact"),
            String(payload.kind ?? "generic"),
            payload.secret ? 1 : 0,
            (payload.revealSceneId as string | null | undefined) ?? null,
            NOW,
            NOW,
          ] as BindParams,
        );
        return agentWriteResult(eventId, 0);
      }
      case "agent_event_update": {
        const eventId = String(payload.eventId);
        const projectId = String(payload.projectId);
        const baseVersion = Number(payload.baseVersion);
        const current = queryEventVersion(eventId, projectId);
        if (current !== baseVersion) {
          throw new Error(`event '${eventId}' version conflict`);
        }
        const patchKeys = [
          "title",
          "note",
          "detail",
          "ordinal",
          "primaryCodexId",
          "locationCodexId",
          "startTime",
          "endTime",
          "startMinute",
          "endMinute",
          "startGranularity",
          "endGranularity",
          "precision",
          "kind",
          "secret",
          "revealSceneId",
        ] as const;
        const columnMap: Record<string, string> = {
          title: "title",
          note: "note",
          detail: "detail",
          ordinal: "ordinal",
          primaryCodexId: "primary_codex_id",
          locationCodexId: "location_codex_id",
          startTime: "start_time",
          endTime: "end_time",
          startMinute: "start_minute",
          endMinute: "end_minute",
          startGranularity: "start_granularity",
          endGranularity: "end_granularity",
          precision: "precision",
          kind: "kind",
          secret: "secret",
          revealSceneId: "reveal_scene_id",
        };
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const key of patchKeys) {
          if (!(key in payload)) continue;
          sets.push(`${columnMap[key]} = ?`);
          const value = payload[key];
          params.push(key === "secret" ? (value ? 1 : 0) : value);
        }
        const nextVersion = baseVersion + 1;
        sets.push("version = ?", "updated_at = ?");
        params.push(nextVersion, NOW, eventId, projectId, baseVersion);
        const updated = sqldb.run(
          `UPDATE events SET ${sets.join(", ")}
            WHERE id = ? AND project_id = ? AND version = ?`,
          params as BindParams,
        );
        if (updated === 0) {
          throw new Error(`event '${eventId}' version conflict`);
        }
        return agentWriteResult(eventId, nextVersion);
      }
      case "agent_event_delete": {
        const eventId = String(payload.eventId);
        const projectId = String(payload.projectId);
        const baseVersion = Number(payload.baseVersion);
        const deleted = sqldb.run(
          "DELETE FROM events WHERE id = ? AND project_id = ? AND version = ?",
          [eventId, projectId, baseVersion] as BindParams,
        );
        if (deleted === 0) {
          throw new Error(`event '${eventId}' version conflict`);
        }
        return agentWriteResult(eventId, baseVersion + 1);
      }
      case "agent_event_set_participants": {
        const eventId = String(payload.eventId);
        const projectId = String(payload.projectId);
        const baseVersion = Number(payload.baseVersion);
        const codexEntryIds = payload.codexEntryIds as string[];
        const current = queryEventVersion(eventId, projectId);
        if (current !== baseVersion) {
          throw new Error(`event '${eventId}' version conflict`);
        }
        const nextVersion = baseVersion + 1;
        sqldb.run("BEGIN");
        try {
          sqldb.run(
            `UPDATE events SET version = ?, updated_at = ?
              WHERE id = ? AND project_id = ? AND version = ?`,
            [nextVersion, NOW, eventId, projectId, baseVersion] as BindParams,
          );
          sqldb.run("DELETE FROM event_participants WHERE event_id = ?", [
            eventId,
          ] as BindParams);
          for (const codexEntryId of codexEntryIds) {
            sqldb.run(
              `INSERT INTO event_participants (event_id, codex_entry_id, role)
               VALUES (?, ?, NULL)`,
              [eventId, codexEntryId] as BindParams,
            );
          }
          sqldb.run("COMMIT");
        } catch (e) {
          sqldb.run("ROLLBACK");
          throw e;
        }
        return agentWriteResult(eventId, nextVersion);
      }
      case "agent_scene_event_link": {
        const sceneId = String(payload.sceneId);
        const eventId = String(payload.eventId);
        sqldb.run(
          `INSERT OR IGNORE INTO scene_events (scene_id, event_id) VALUES (?, ?)`,
          [sceneId, eventId] as BindParams,
        );
        return agentWriteResult(
          eventId,
          queryEventVersion(eventId, String(payload.projectId)) ?? 0,
        );
      }
      case "agent_scene_event_unlink": {
        const sceneId = String(payload.sceneId);
        const eventId = String(payload.eventId);
        sqldb.run(
          "DELETE FROM scene_events WHERE scene_id = ? AND event_id = ?",
          [sceneId, eventId] as BindParams,
        );
        return agentWriteResult(
          eventId,
          queryEventVersion(eventId, String(payload.projectId)) ?? 0,
        );
      }
      case "agent_event_relation_add": {
        const causeEventId = String(payload.causeEventId);
        const effectEventId = String(payload.effectEventId);
        const projectId = String(payload.projectId);
        sqldb.run(
          `INSERT OR IGNORE INTO event_relations
            (project_id, cause_event_id, effect_event_id)
           VALUES (?, ?, ?)`,
          [projectId, causeEventId, effectEventId] as BindParams,
        );
        return agentWriteResult(causeEventId, 0);
      }
      case "agent_event_relation_remove": {
        const causeEventId = String(payload.causeEventId);
        const effectEventId = String(payload.effectEventId);
        const projectId = String(payload.projectId);
        sqldb.run(
          `DELETE FROM event_relations
            WHERE project_id = ? AND cause_event_id = ? AND effect_event_id = ?`,
          [projectId, causeEventId, effectEventId] as BindParams,
        );
        return agentWriteResult(causeEventId, 0);
      }
      default:
        return [];
    }
  };

  return { db };
});

import { db } from "@/db/client";
import {
  events,
  eventParticipants,
  eventRelations,
  sceneEvents,
  treeNodes,
} from "@/db/schema";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  normalizeEvent,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  addEventRelation,
  linkSceneToEvent,
  linkScenesToEvent,
  unlinkSceneFromEvent,
  setEventParticipants,
  listEventParticipants,
  listSceneEvents,
  listEventRelations,
  listEventParticipantsForProject,
  listSceneEventsForProject,
  calendarFromRow,
} from "./api";
import { EventVersionConflictError } from "./eventOcc";

const NOW = "2026-06-27T00:00:00.000Z";

beforeAll(async () => {
  // sql.js 初期化(mock factory の await)を確実に終わらせる。
  await db.delete(events);
});

beforeEach(async () => {
  await db.delete(events);
  await db.delete(eventRelations);
  await db.delete(eventParticipants);
  await db.delete(sceneEvents);
  await db.delete(treeNodes);
});

describe("normalizeEvent", () => {
  it("snake_case の DB 行を EventRow へ正規化する", () => {
    const row = {
      id: "e1",
      project_id: "p1",
      title: "戴冠",
      note: "脚注",
      detail: '{"type":"doc","content":[]}',
      ordinal: "a3",
      primary_codex_id: "c1",
      location_codex_id: "loc1",
      start_time: 12,
      end_time: 20,
      start_minute: 870,
      end_minute: 90,
      start_granularity: "time",
      end_granularity: "day",
      precision: "approx",
      kind: "birth",
      secret: 1,
      reveal_scene_id: "s3",
      version: 4,
      created_at: NOW,
      updated_at: NOW,
    };
    expect(normalizeEvent(row)).toEqual({
      id: "e1",
      projectId: "p1",
      title: "戴冠",
      note: "脚注",
      detail: '{"type":"doc","content":[]}',
      ordinal: "a3",
      primaryCodexId: "c1",
      laneGroup: null,
      locationCodexId: "loc1",
      startTime: 12,
      endTime: 20,
      startMinute: 870,
      endMinute: 90,
      startGranularity: "time",
      endGranularity: "day",
      precision: "approx",
      kind: "birth",
      secret: true,
      revealSceneId: "s3",
      version: 4,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("camelCase の invoke 戻り行も正規化する", () => {
    const out = normalizeEvent({
      id: "e2",
      projectId: "p2",
      title: "x",
      ordinal: "a1",
      primaryCodexId: "c9",
      startTime: 5,
    });
    expect(out.projectId).toBe("p2");
    expect(out.ordinal).toBe("a1");
    expect(out.primaryCodexId).toBe("c9");
    expect(out.startTime).toBe(5);
    expect(out.note).toBeNull();
  });

  it("startTime=0 は 0 のまま、null/未指定は null として保持する", () => {
    expect(normalizeEvent({ id: "e", start_time: 0 }).startTime).toBe(0);
    expect(normalizeEvent({ id: "e", startTime: 0 }).startTime).toBe(0);
    expect(normalizeEvent({ id: "e", start_time: null }).startTime).toBeNull();
    expect(normalizeEvent({ id: "e" }).startTime).toBeNull();
  });

  it("欠損フィールドは既定値へフォールバックする", () => {
    const out = normalizeEvent({ id: "e" });
    expect(out.ordinal).toBe("a0");
    expect(out.precision).toBe("exact");
    expect(out.kind).toBe("generic");
  });
});

describe("calendarFromRow", () => {
  it("閏ルール・曜日起点・年齢表記を CalendarRow から復元する", () => {
    // calendarFromRow は CalendarRowData（暦の値フィールドのみ）を受ける。
    // projectId/createdAt/updatedAt は消費しないので渡さない。
    const cal = calendarFromRow({
      daysPerYear: 365,
      seasonBoundaries: JSON.stringify([{ name: "冬", startDayOfYear: 270 }]),
      startYear: 2000,
      months: JSON.stringify([{ name: "2月", days: 28 }]),
      weekdayNames: JSON.stringify(["日", "月", "火", "水", "木", "金", "土"]),
      weekdayStartIndex: 6,
      leapRule: JSON.stringify({ kind: "gregorian", monthIndex: 0 }),
      ageReckoning: "counting",
      eras: JSON.stringify([{ name: "明治", startYear: 1868 }]),
      reform: JSON.stringify({
        gregorianStart: { year: 1582, monthIndex: 9, dayOfMonth: 15 },
        region: "gregorian1582",
      }),
      timezone: JSON.stringify({ label: "JST", offsetMinutes: 540 }),
      lunarTzMinutes: 540,
    });

    expect(cal.weekdayStartIndex).toBe(6);
    expect(cal.leap).toEqual({ kind: "gregorian", monthIndex: 0 });
    expect(cal.ageReckoning).toBe("counting");
    expect(cal.eras).toEqual([{ name: "明治", startYear: 1868 }]);
    expect(cal.reform?.region).toBe("gregorian1582");
    expect(cal.timezone?.label).toBe("JST");
    expect(cal.lunarTzMinutes).toBe(540);
  });
});

async function seed(
  id: string,
  projectId: string,
  ordinal: string,
  title = id,
): Promise<void> {
  await db
    .insert(events)
    .values({ id, projectId, ordinal, title, createdAt: NOW, updatedAt: NOW });
}

describe("listEvents", () => {
  it("照会した projectId の行だけを返す(他プロジェクトは除外)", async () => {
    await seed("e1", "p1", "a0");
    await seed("e2", "p1", "a1");
    await seed("x1", "p2", "a0");
    const rows = await listEvents("p1");
    expect(rows.map((r) => r.id).sort()).toEqual(["e1", "e2"]);
    expect(rows.every((r) => r.projectId === "p1")).toBe(true);
  });

  it("(ordinal asc, id asc) で決定論的に並ぶ(ordinal 重複は id で安定)", async () => {
    // 挿入順をわざと崩す。ordinal "a5" は重複 → id で tiebreak。
    await seed("e2", "p1", "a1");
    await seed("e1", "p1", "a0");
    await seed("e3b", "p1", "a5");
    await seed("e3a", "p1", "a5");
    const rows = await listEvents("p1");
    expect(rows.map((r) => r.id)).toEqual(["e1", "e2", "e3a", "e3b"]);
  });
});

describe("updateEvent (fail-closed scoping)", () => {
  it("他プロジェクトの id を渡しても no-op(書込みは遮断)", async () => {
    await seed("e1", "p1", "a0", "orig");
    await updateEvent("e1", "p2", { title: "hacked" });
    const [row] = await listEvents("p1");
    expect(row.title).toBe("orig");
  });

  it("projectId が一致すれば更新される", async () => {
    await seed("e1", "p1", "a0", "orig");
    const updated = await updateEvent("e1", "p1", { title: "ok" });
    const [row] = await listEvents("p1");
    expect(row.title).toBe("ok");
    expect(updated?.version).toBe(1);
  });

  it("古い baseVersion は拒否し、現行行を上書きしない", async () => {
    await seed("e1", "p1", "a0", "orig");
    await updateEvent("e1", "p1", { title: "fresh" }, { baseVersion: 0 });

    await expect(
      updateEvent("e1", "p1", { title: "stale" }, { baseVersion: 0 }),
    ).rejects.toBeInstanceOf(EventVersionConflictError);
    const row = await getEvent("p1", "e1");
    expect(row?.title).toBe("fresh");
    expect(row?.version).toBe(1);
  });
});

describe("detail（出来事の詳細・ProseMirror JSON）", () => {
  const DOC = '{"type":"doc","content":[{"type":"paragraph"}]}';

  it("createEvent は detail を保存し、listEvents で読み戻せる", async () => {
    const ev = await createEvent({ projectId: "p1", detail: DOC });
    expect(ev.detail).toBe(DOC);
    const [row] = await listEvents("p1");
    expect(row.detail).toBe(DOC);
  });

  it("detail 未指定の createEvent は null", async () => {
    const ev = await createEvent({ projectId: "p1" });
    expect(ev.detail).toBeNull();
  });

  it("updateEvent で detail を更新できる", async () => {
    await seed("e1", "p1", "a0");
    await updateEvent("e1", "p1", { detail: DOC });
    const ev = await getEvent("p1", "e1");
    expect(ev?.detail).toBe(DOC);
  });

  it("getEvent は projectId 不一致で null（fail-closed）", async () => {
    await seed("e1", "p1", "a0");
    expect(await getEvent("p2", "e1")).toBeNull();
    expect(await getEvent("p1", "e1")).not.toBeNull();
  });
});

describe("deleteEvent (fail-closed scoping)", () => {
  it("他プロジェクトの id では削除されない", async () => {
    await seed("e1", "p1", "a0");
    await deleteEvent("e1", "p2");
    expect((await listEvents("p1")).length).toBe(1);
  });

  it("projectId が一致すれば削除される", async () => {
    await seed("e1", "p1", "a0");
    await deleteEvent("e1", "p1");
    expect((await listEvents("p1")).length).toBe(0);
  });
});

describe("createEvent", () => {
  it("連続生成で ordinal が単調増加する", async () => {
    const a = await createEvent({ projectId: "p1" });
    const b = await createEvent({ projectId: "p1" });
    const c = await createEvent({ projectId: "p1" });
    expect(cmpKeys(a.ordinal, b.ordinal)).toBeLessThan(0);
    expect(cmpKeys(b.ordinal, c.ordinal)).toBeLessThan(0);
    expect(new Set([a.ordinal, b.ordinal, c.ordinal]).size).toBe(3);
  });

  it("明示 ordinal はそのまま使う", async () => {
    const e = await createEvent({ projectId: "p1", ordinal: "z9" });
    expect(e.ordinal).toBe("z9");
  });

  it("ordinal 採番は projectId ごとに独立", async () => {
    await seed("hi", "p2", "z0"); // p2 に大きい ordinal があっても p1 は影響なし
    const e = await createEvent({ projectId: "p1" });
    expect(e.ordinal).toBe("a0");
  });
});

describe("addEventRelation", () => {
  it("自己ループ(cause === effect)は挿入しない", async () => {
    await addEventRelation("p1", "a", "a");
    expect((await listEventRelations("p1")).length).toBe(0);
  });

  it("同一エッジの重複はデデュープされる", async () => {
    await seed("c", "p1", "a0");
    await seed("e", "p1", "a1");
    await addEventRelation("p1", "c", "e");
    await addEventRelation("p1", "c", "e");
    const rels = await listEventRelations("p1");
    expect(rels.length).toBe(1);
    expect(rels[0]).toEqual({ causeId: "c", effectId: "e" });
  });

  it("cause/effect が projectId に属さない因果エッジは挿入しない", async () => {
    await seed("p1-cause", "p1", "a0");
    await seed("p2-effect", "p2", "a0");

    await addEventRelation("p1", "p1-cause", "p2-effect");

    expect(await listEventRelations("p1")).toEqual([]);
    expect(await listEventRelations("p2")).toEqual([]);
  });
});

describe("linkSceneToEvent", () => {
  async function seedScene(id: string, projectId: string): Promise<void> {
    await db.insert(treeNodes).values({
      id,
      projectId,
      nodeType: "scene",
      title: id,
      sortOrder: "a0",
      content: "{}",
      unplacedBeatsDoc: "[]",
      charCount: 0,
    });
  }

  it("scene と event が同じ project に属する場合だけ link する", async () => {
    await seedScene("s1", "p1");
    await seed("e1", "p1", "a0");

    await linkSceneToEvent("p1", "s1", "e1");

    expect(await listSceneEvents(["e1"])).toEqual([
      { sceneId: "s1", eventId: "e1" },
    ]);
  });

  it("scene と event の project が不一致なら link しない", async () => {
    await seedScene("s2", "p2");
    await seed("e1", "p1", "a0");

    await linkSceneToEvent("p1", "s2", "e1");

    expect(await listSceneEvents(["e1"])).toEqual([]);
  });
});

describe("linkScenesToEvent (一括リンク)", () => {
  async function seedScene(id: string, projectId: string): Promise<void> {
    await db.insert(treeNodes).values({
      id,
      projectId,
      nodeType: "scene",
      title: id,
      sortOrder: "a0",
      content: "{}",
      unplacedBeatsDoc: "[]",
      charCount: 0,
    });
  }

  it("同一 project のシーンだけをまとめて link する（不正/他プロジェクトはスキップ）", async () => {
    await seedScene("s1", "p1");
    await seedScene("s2", "p1");
    await seedScene("sx", "p2"); // 他プロジェクト
    await seed("e1", "p1", "a0");

    await linkScenesToEvent("p1", ["s1", "s2", "sx", "ghost"], "e1");

    expect(
      (await listSceneEvents(["e1"])).map((l) => l.sceneId).sort(),
    ).toEqual(["s1", "s2"]);
  });

  it("event が projectId に属さなければ何も link しない（fail-closed）", async () => {
    await seedScene("s1", "p1");
    await seed("e1", "p2", "a0");

    await linkScenesToEvent("p1", ["s1"], "e1");

    expect(await listSceneEvents(["e1"])).toEqual([]);
  });

  it("重複 sceneId・既存リンクはデデュープされる（onConflictDoNothing）", async () => {
    await seedScene("s1", "p1");
    await seed("e1", "p1", "a0");
    await db.insert(sceneEvents).values({ sceneId: "s1", eventId: "e1" });

    await linkScenesToEvent("p1", ["s1", "s1"], "e1");

    expect(await listSceneEvents(["e1"])).toEqual([
      { sceneId: "s1", eventId: "e1" },
    ]);
  });

  it("空配列は no-op", async () => {
    await seed("e1", "p1", "a0");
    await linkScenesToEvent("p1", [], "e1");
    expect(await listSceneEvents(["e1"])).toEqual([]);
  });
});

describe("unlinkSceneFromEvent (fail-closed scoping)", () => {
  async function seedScene(id: string, projectId: string): Promise<void> {
    await db.insert(treeNodes).values({
      id,
      projectId,
      nodeType: "scene",
      title: id,
      sortOrder: "a0",
      content: "{}",
      unplacedBeatsDoc: "[]",
      charCount: 0,
    });
  }

  it("event が projectId に属していれば link を解除する", async () => {
    await seedScene("s1", "p1");
    await seed("e1", "p1", "a0");
    await db.insert(sceneEvents).values({ sceneId: "s1", eventId: "e1" });

    await unlinkSceneFromEvent("p1", "s1", "e1");

    expect(await listSceneEvents(["e1"])).toEqual([]);
  });

  it("他プロジェクトの projectId では解除されない(XPROJ 遮断)", async () => {
    await seedScene("s1", "p1");
    await seed("e1", "p1", "a0");
    await db.insert(sceneEvents).values({ sceneId: "s1", eventId: "e1" });

    await unlinkSceneFromEvent("p2", "s1", "e1");

    expect(await listSceneEvents(["e1"])).toEqual([
      { sceneId: "s1", eventId: "e1" },
    ]);
  });
});

describe("setEventParticipants (fail-closed scoping)", () => {
  it("event が projectId に属していれば参加者集合を置き換える", async () => {
    await seed("e1", "p1", "a0");
    await db
      .insert(eventParticipants)
      .values({ eventId: "e1", codexEntryId: "old" });

    await setEventParticipants("e1", "p1", ["c1", "c2"]);

    const rows = await listEventParticipants("e1");
    expect(rows.map((r) => r.codexEntryId).sort()).toEqual(["c1", "c2"]);
  });

  it("空配列を渡すと全参加者を削除する", async () => {
    await seed("e1", "p1", "a0");
    await db
      .insert(eventParticipants)
      .values({ eventId: "e1", codexEntryId: "c1" });

    await setEventParticipants("e1", "p1", []);

    expect(await listEventParticipants("e1")).toEqual([]);
  });

  it("他プロジェクトの projectId では参加者を変更しない(XPROJ 遮断)", async () => {
    await seed("e1", "p1", "a0");
    await db
      .insert(eventParticipants)
      .values({ eventId: "e1", codexEntryId: "keep" });

    await setEventParticipants("e1", "p2", ["hacked"]);

    expect(await listEventParticipants("e1")).toEqual([
      { eventId: "e1", codexEntryId: "keep", role: null },
    ]);
  });

  it("participants は event aggregate version を進め、古い base を拒否する", async () => {
    await seed("e1", "p1", "a0");
    await expect(
      setEventParticipants("e1", "p1", ["fresh"], { baseVersion: 0 }),
    ).resolves.toBe(1);

    await expect(
      setEventParticipants("e1", "p1", ["stale"], { baseVersion: 0 }),
    ).rejects.toBeInstanceOf(EventVersionConflictError);
    expect(await listEventParticipants("e1")).toEqual([
      { eventId: "e1", codexEntryId: "fresh", role: null },
    ]);
    expect((await getEvent("p1", "e1"))?.version).toBe(1);
  });
});

// ───────── C0: project-scoped bulk read API ─────────
async function seedParticipant(
  eventId: string,
  codexEntryId: string,
  role: string | null = null,
): Promise<void> {
  await db.insert(eventParticipants).values({ eventId, codexEntryId, role });
}
async function seedSceneEvent(sceneId: string, eventId: string): Promise<void> {
  await db.insert(sceneEvents).values({ sceneId, eventId });
}

describe("listEventParticipantsForProject (XPROJ via events JOIN)", () => {
  it("照会 project の event に属する参加者だけを返す(他 project は除外)", async () => {
    await seed("e1", "p1", "a0");
    await seed("x1", "p2", "a0");
    await seedParticipant("e1", "c1", "主役");
    await seedParticipant("x1", "c9"); // 別 project の event の参加者

    const rows = await listEventParticipantsForProject("p1");
    expect(rows).toEqual([{ eventId: "e1", codexEntryId: "c1", role: "主役" }]);
  });

  it("eventIds 指定でその event 群の参加者に絞る", async () => {
    await seed("e1", "p1", "a0");
    await seed("e2", "p1", "a1");
    await seedParticipant("e1", "c1");
    await seedParticipant("e2", "c2");

    const rows = await listEventParticipantsForProject("p1", ["e2"]);
    expect(rows).toEqual([{ eventId: "e2", codexEntryId: "c2", role: null }]);
  });

  it("eventIds=[] は何も返さない(undefined=全件 とは区別)", async () => {
    await seed("e1", "p1", "a0");
    await seedParticipant("e1", "c1");
    expect(await listEventParticipantsForProject("p1", [])).toEqual([]);
    expect((await listEventParticipantsForProject("p1")).length).toBe(1);
  });

  it("孤児 participant(events に対応 event が無い)は JOIN で落ちる", async () => {
    await seedParticipant("ghost", "c1"); // 対応 event 無し
    expect(await listEventParticipantsForProject("p1")).toEqual([]);
  });
});

describe("listSceneEventsForProject (XPROJ via events JOIN)", () => {
  it("照会 project の event に紐づく scene_events だけを返す", async () => {
    await seed("e1", "p1", "a0");
    await seed("x1", "p2", "a0");
    await seedSceneEvent("s1", "e1");
    await seedSceneEvent("sx", "x1"); // 別 project

    const rows = await listSceneEventsForProject("p1");
    expect(rows).toEqual([{ sceneId: "s1", eventId: "e1" }]);
  });

  it("opts.eventIds で絞る", async () => {
    await seed("e1", "p1", "a0");
    await seed("e2", "p1", "a1");
    await seedSceneEvent("s1", "e1");
    await seedSceneEvent("s2", "e2");

    const rows = await listSceneEventsForProject("p1", { eventIds: ["e1"] });
    expect(rows).toEqual([{ sceneId: "s1", eventId: "e1" }]);
  });

  it("opts.sceneIds で絞る", async () => {
    await seed("e1", "p1", "a0");
    await seedSceneEvent("s1", "e1");
    await seedSceneEvent("s2", "e1");

    const rows = await listSceneEventsForProject("p1", { sceneIds: ["s2"] });
    expect(rows).toEqual([{ sceneId: "s2", eventId: "e1" }]);
  });

  it("空フィルタ配列は何も返さない", async () => {
    await seed("e1", "p1", "a0");
    await seedSceneEvent("s1", "e1");
    expect(await listSceneEventsForProject("p1", { eventIds: [] })).toEqual([]);
    expect(await listSceneEventsForProject("p1", { sceneIds: [] })).toEqual([]);
  });
});
