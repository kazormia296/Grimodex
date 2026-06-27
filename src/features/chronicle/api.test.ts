import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { BindParams } from "sql.js";

// chronicle のテーブル群は browser-mock のスキーマに無いため、本テスト専用に
// sql.js(in-memory SQLite) を立て、その上に drizzle-proxy を載せて @/db/client を
// 差し替える。これで listEvents の ORDER BY / projectId スコープ / ordinal 採番など
// 「実際の SQL 挙動」を assert できる(SQL 文字列の捕捉では足りない部分)。
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
      ordinal TEXT NOT NULL DEFAULT 'a0',
      primary_codex_id TEXT,
      location_codex_id TEXT,
      start_time INTEGER,
      end_time INTEGER,
      precision TEXT NOT NULL DEFAULT 'exact',
      kind TEXT NOT NULL DEFAULT 'generic',
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
  return { db };
});

import { db } from "@/db/client";
import { events, eventParticipants, eventRelations } from "@/db/schema";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  normalizeEvent,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  addEventRelation,
  listEventRelations,
} from "./api";

const NOW = "2026-06-27T00:00:00.000Z";

beforeAll(async () => {
  // sql.js 初期化(mock factory の await)を確実に終わらせる。
  await db.delete(events);
});

beforeEach(async () => {
  await db.delete(events);
  await db.delete(eventRelations);
  await db.delete(eventParticipants);
});

describe("normalizeEvent", () => {
  it("snake_case の DB 行を EventRow へ正規化する", () => {
    const row = {
      id: "e1",
      project_id: "p1",
      title: "戴冠",
      note: "脚注",
      ordinal: "a3",
      primary_codex_id: "c1",
      location_codex_id: "loc1",
      start_time: 12,
      end_time: 20,
      precision: "approx",
      kind: "birth",
      created_at: NOW,
      updated_at: NOW,
    };
    expect(normalizeEvent(row)).toEqual({
      id: "e1",
      projectId: "p1",
      title: "戴冠",
      note: "脚注",
      ordinal: "a3",
      primaryCodexId: "c1",
      locationCodexId: "loc1",
      startTime: 12,
      endTime: 20,
      precision: "approx",
      kind: "birth",
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
    await updateEvent("e1", "p1", { title: "ok" });
    const [row] = await listEvents("p1");
    expect(row.title).toBe("ok");
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
    await addEventRelation("p1", "c", "e");
    await addEventRelation("p1", "c", "e");
    const rels = await listEventRelations("p1");
    expect(rels.length).toBe(1);
    expect(rels[0]).toEqual({ causeId: "c", effectId: "e" });
  });
});
