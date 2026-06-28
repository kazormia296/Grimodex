# Chronicle P0（作中年表 データ基盤）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax.

**Goal:** 作中年表(Chronicle)の永続データ基盤（Event/参加者/scene参照/暦）と季節判定の純関数を、UI 無しで完全にテスト可能な形で追加する。

**Architecture:** 既存 plot-threads と同方針＝Drizzle 直書き(`db_execute`、Rust コマンド無し)。新4テーブルを `src/db/schema.ts`(TS) と `src-tauri/src/database/migrate.rs`(Rust ミラー) に追加。CRUD は `src/features/chronicle/api.ts`。時間/季節ロジックは純関数 `src/features/chronicle/chronicleTime.ts`（happy-dom 単体テストで gate）。

**Tech Stack:** TypeScript / Drizzle ORM(sqlite-proxy) / Rust(rusqlite) / Vitest / fractional-indexing。

## Global Constraints

- ES modules のみ（CommonJS 禁止）。2スペースインデント。TypeScript strict。
- DB 操作は Drizzle 経由・生 SQL 禁止（Rust migrate.rs の CREATE TABLE は例外＝スキーマ定義の正本ミラー）。
- 純関数に乱数/`Date.now()` 禁止（決定性）。
- 1ファイル1責務、200行超えたら分割。
- schema.ts(TS) と migrate.rs(Rust) は**必ずミラー**（カラム名 snake_case 一致）。
- id は `crypto.randomUUID()`。タイムスタンプは `new Date().toISOString()`。
- 検証: `npx tsc --noEmit` / `pnpm lint:fix` / `pnpm test --run <path>` / `cd src-tauri && cargo check`。

---

## File Structure

- Create: `src/features/chronicle/chronicleTime.ts` — 暦/季節/ordinal の純関数（`seasonOf`, `nextEventOrdinal`, 型）
- Create: `src/features/chronicle/chronicleTime.test.ts` — 上記の単体テスト
- Create: `src/features/chronicle/api.ts` — events/participants/scene_events/calendar の CRUD（Row 型＋normalizer＋関数）
- Modify: `src/db/schema.ts` — `events` / `eventParticipants` / `sceneEvents` / `projectCalendar` テーブル＋型＋`EVENT_PRECISIONS`
- Modify: `src-tauri/src/database/migrate.rs` — 上記4テーブルの `CREATE TABLE IF NOT EXISTS`（plot_threads 群の直後）

---

### Task 1: 暦/季節の純関数（`chronicleTime.ts`）

**Files:**
- Create: `src/features/chronicle/chronicleTime.ts`
- Test: `src/features/chronicle/chronicleTime.test.ts`

**Interfaces:**
- Produces:
  - `interface SeasonBoundary { name: string; startDayOfYear: number }`
  - `interface ChronicleCalendar { daysPerYear: number; seasonBoundaries: SeasonBoundary[] }`
  - `seasonOf(time: number, calendar: ChronicleCalendar): string | null`
  - `nextEventOrdinal(existing: string[]): string`

- [x] **Step 1: 失敗するテストを書く**

```typescript
// src/features/chronicle/chronicleTime.test.ts
import { describe, it, expect } from "vitest";
import {
  seasonOf,
  nextEventOrdinal,
  type ChronicleCalendar,
} from "./chronicleTime";

const CAL: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [
    { name: "春", startDayOfYear: 0 },
    { name: "夏", startDayOfYear: 90 },
    { name: "秋", startDayOfYear: 180 },
    { name: "冬", startDayOfYear: 270 },
  ],
};

describe("seasonOf", () => {
  it("各境界の代表日を正しい季節へ写像", () => {
    expect(seasonOf(0, CAL)).toBe("春");
    expect(seasonOf(100, CAL)).toBe("夏");
    expect(seasonOf(200, CAL)).toBe("秋");
    expect(seasonOf(300, CAL)).toBe("冬");
  });
  it("年をまたいでも mod で循環（720=2年後の0日目→春）", () => {
    expect(seasonOf(720, CAL)).toBe("春");
    expect(seasonOf(720 + 300, CAL)).toBe("冬");
  });
  it("負の時刻も循環で処理（-1→最終日→冬）", () => {
    expect(seasonOf(-1, CAL)).toBe("冬");
  });
  it("最初の境界より前の日（境界が0始まりでない場合）は最後の季節へ巻き戻る", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 100,
      seasonBoundaries: [
        { name: "A", startDayOfYear: 10 },
        { name: "B", startDayOfYear: 60 },
      ],
    };
    expect(seasonOf(5, cal)).toBe("B");
    expect(seasonOf(10, cal)).toBe("A");
    expect(seasonOf(59, cal)).toBe("A");
    expect(seasonOf(60, cal)).toBe("B");
  });
  it("境界が空 or daysPerYear<=0 なら null", () => {
    expect(seasonOf(10, { daysPerYear: 360, seasonBoundaries: [] })).toBeNull();
    expect(
      seasonOf(10, { daysPerYear: 0, seasonBoundaries: CAL.seasonBoundaries }),
    ).toBeNull();
  });
});

describe("nextEventOrdinal", () => {
  it("空配列なら初期キーを返す", () => {
    expect(typeof nextEventOrdinal([])).toBe("string");
    expect(nextEventOrdinal([]).length).toBeGreaterThan(0);
  });
  it("既存の最大キーより後（cmpKeys で大）のキーを返す", () => {
    const a = nextEventOrdinal([]);
    const b = nextEventOrdinal([a]);
    expect(b > a).toBe(true);
    const c = nextEventOrdinal([a, b]);
    expect(c > b).toBe(true);
  });
});
```

- [x] **Step 2: テストが失敗するのを確認**

Run: `pnpm test --run src/features/chronicle/chronicleTime.test.ts`
Expected: FAIL（`chronicleTime` モジュールが無い）

- [x] **Step 3: 最小実装を書く**

```typescript
// src/features/chronicle/chronicleTime.ts
import { generateKeyBetween, cmpKeys } from "@/features/tree/fractionalIndex";

export interface SeasonBoundary {
  /** 季節名（例「冬」）。 */
  name: string;
  /** その季節が始まる年内通日（0-based, 0..daysPerYear-1）。 */
  startDayOfYear: number;
}

export interface ChronicleCalendar {
  /** 1年の日数（作中暦。グレゴリオなら 365）。 */
  daysPerYear: number;
  /** 季節境界。startDayOfYear 昇順の循環区間として解釈する。 */
  seasonBoundaries: SeasonBoundary[];
}

/**
 * 数値時刻（紀元からの日数）→ その日の作中季節名。
 * 境界は startDayOfYear 昇順に並べた循環区間。最初の境界より前の通日は
 * 「最後の季節が年末から巻き込んでいる」とみなして最後の境界へ巻き戻す。
 * 決定性: 乱数/時刻なし。
 */
export function seasonOf(time: number, calendar: ChronicleCalendar): string | null {
  const { daysPerYear, seasonBoundaries } = calendar;
  if (daysPerYear <= 0 || seasonBoundaries.length === 0) return null;
  const dayOfYear =
    ((Math.floor(time) % daysPerYear) + daysPerYear) % daysPerYear;
  const sorted = [...seasonBoundaries].sort(
    (a, b) => a.startDayOfYear - b.startDayOfYear,
  );
  let current = sorted[sorted.length - 1]; // 巻き戻し既定値
  for (const b of sorted) {
    if (dayOfYear >= b.startDayOfYear) current = b;
    else break;
  }
  return current.name;
}

/**
 * 既存の ordinal 群の「最後」に挿す新しい fractional-index を返す。
 * storyTimeOrder と同 idiom（base62・cmpKeys 辞書順）。
 */
export function nextEventOrdinal(existing: string[]): string {
  if (existing.length === 0) return generateKeyBetween(null, null);
  let max = existing[0];
  for (const k of existing) if (cmpKeys(k, max) > 0) max = k;
  return generateKeyBetween(max, null);
}
```

- [x] **Step 4: テストが通るのを確認**

Run: `pnpm test --run src/features/chronicle/chronicleTime.test.ts`
Expected: PASS（全ケース green）

- [x] **Step 5: コミット**

```bash
git add src/features/chronicle/chronicleTime.ts src/features/chronicle/chronicleTime.test.ts
git commit -m "feat(chronicle): 暦/季節判定とordinal生成の純関数を追加"
```

---

### Task 2: スキーマ4テーブル（TS Drizzle）

**Files:**
- Modify: `src/db/schema.ts`（`plotThreadBranches` の型定義群の直後＝`PLOT_BRANCH_KINDS` 定義の後ろ）

**Interfaces:**
- Consumes: 既存 `projects`, `codexEntries`, `treeNodes`, `sqliteTable/text/integer/index/primaryKey`。
- Produces: `events`, `eventParticipants`, `sceneEvents`, `projectCalendar` テーブル、`ChronicleEvent`/`NewChronicleEvent` 型、`EVENT_PRECISIONS`/`EventPrecision`。

- [x] **Step 1: 実装を書く（plotThreadBranches 型群の直後に追記）**

`src/db/schema.ts` の `export type PlotThreadBranch = ...` と `PLOT_BRANCH_KINDS` 定義の直後に以下を追加:

```typescript
// ───────── Chronicle（作中年表） ─────────
// Scene-anchored ではない独立した「出来事」。point(end_time=null)/interval 両対応。
// reading-order の plot-thread とは別概念（作中時間=fabula 軸）。
// CRUD は plot_thread_branches 同様 db_execute Drizzle 直書き（Rust コマンド無し）。
// src-tauri migrate.rs とミラー。

/** 出来事の時刻 precision の正準 enum。 */
export const EVENT_PRECISIONS = ["exact", "approx", "unknown"] as const;
export type EventPrecision = (typeof EVENT_PRECISIONS)[number];

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    note: text("note"),
    // 年表 x 軸順の fractional-index（base62・辞書順比較・storyTimeOrder と同 idiom）。
    ordinal: text("ordinal").notNull().default("a0"),
    // ホームレーン（人物 codex）。null=未割当。codex 削除で set null（出来事は残す）。
    primaryCodexId: text("primary_codex_id").references(() => codexEntries.id, {
      onDelete: "set null",
    }),
    // 暦ライト数値時刻（紀元からの日数）。null=ordinal のみ（連続間隔/季節は出ない）。
    startTime: integer("start_time"),
    // interval 終端（紀元からの日数）。null=point。
    endTime: integer("end_time"),
    // 'exact' | 'approx' | 'unknown'（CHECK は SQL 側）。
    precision: text("precision").notNull().default("exact"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_events_project").on(table.projectId),
    index("idx_events_ordinal").on(table.projectId, table.ordinal),
  ],
);

/** 出来事に参加する codex エンティティ（多対多）。主参加は events.primaryCodexId。 */
export const eventParticipants = sqliteTable(
  "event_participants",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    codexEntryId: text("codex_entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    role: text("role"),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.codexEntryId] }),
    index("idx_event_participants_codex").on(table.codexEntryId),
  ],
);

/** scene↔event 0..N 橋（0=オフページ）。シーン/出来事いずれ削除でも CASCADE。 */
export const sceneEvents = sqliteTable(
  "scene_events",
  {
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.sceneId, table.eventId] }),
    index("idx_scene_events_event").on(table.eventId),
  ],
);

/** 1プロジェクト1暦（暦ライト・任意）。未設定=季節チェック無効。 */
export const projectCalendar = sqliteTable("project_calendar", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  daysPerYear: integer("days_per_year").notNull().default(360),
  // JSON: SeasonBoundary[] = [{name, startDayOfYear}]（4季想定）。
  seasonBoundaries: text("season_boundaries").notNull().default("[]"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type ChronicleEvent = typeof events.$inferSelect;
export type NewChronicleEvent = typeof events.$inferInsert;
export type EventParticipant = typeof eventParticipants.$inferSelect;
export type SceneEvent = typeof sceneEvents.$inferSelect;
export type ProjectCalendar = typeof projectCalendar.$inferSelect;
```

- [x] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: PASS（新テーブル/型がエラー無く解決。`codexEntries`/`treeNodes`/`projects` は同ファイル既定義で参照可能）

- [x] **Step 3: コミット**

```bash
git add src/db/schema.ts
git commit -m "feat(chronicle): events/event_participants/scene_events/project_calendar スキーマ(TS)"
```

---

### Task 3: Rust マイグレーション・ミラー（migrate.rs）

**Files:**
- Modify: `src-tauri/src/database/migrate.rs`（plot_thread_branches の `conn.execute_batch(...)` ブロック直後＝既存 1718 行付近）

**Interfaces:**
- Consumes: `conn`（migrate() 内の既存接続）。
- Produces: SQLite テーブル `events` / `event_participants` / `scene_events` / `project_calendar`（schema.ts と完全ミラー）。

- [x] **Step 1: 実装を書く（plot_thread_branches の CREATE 直後に追記）**

`migrate.rs` の plot_thread_branches を作る `conn.execute_batch(...)?;` の直後に以下を追加:

```rust
        // 作中年表(Chronicle)の出来事。Scene-anchored ではない独立エンティティ。
        // point(end_time=NULL)/interval 両対応。precision は CHECK enum。
        // primary_codex_id=ホームレーン(人物)。codex 削除で SET NULL（出来事は残す）。
        // src/db/schema.ts の events とミラー。project 削除で CASCADE。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id               TEXT PRIMARY KEY,
                project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title            TEXT NOT NULL DEFAULT '',
                note             TEXT,
                ordinal          TEXT NOT NULL DEFAULT 'a0',
                primary_codex_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                start_time       INTEGER,
                end_time         INTEGER,
                precision        TEXT NOT NULL DEFAULT 'exact'
                                   CHECK(precision IN ('exact','approx','unknown')),
                created_at       TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_events_project
                ON events(project_id);
            CREATE INDEX IF NOT EXISTS idx_events_ordinal
                ON events(project_id, ordinal);",
        )?;

        // 出来事への参加 codex（多対多）。主参加は events.primary_codex_id。
        // src/db/schema.ts の eventParticipants とミラー。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS event_participants (
                event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                role            TEXT,
                PRIMARY KEY (event_id, codex_entry_id)
            );
            CREATE INDEX IF NOT EXISTS idx_event_participants_codex
                ON event_participants(codex_entry_id);",
        )?;

        // scene↔event 0..N 橋（0=オフページ）。scene/event いずれ削除でも CASCADE。
        // src/db/schema.ts の sceneEvents とミラー。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS scene_events (
                scene_id  TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
                event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                PRIMARY KEY (scene_id, event_id)
            );
            CREATE INDEX IF NOT EXISTS idx_scene_events_event
                ON scene_events(event_id);",
        )?;

        // 1プロジェクト1暦（暦ライト・任意）。season_boundaries は JSON。
        // src/db/schema.ts の projectCalendar とミラー。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS project_calendar (
                project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                days_per_year     INTEGER NOT NULL DEFAULT 360,
                season_boundaries TEXT NOT NULL DEFAULT '[]',
                created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )?;
```

- [x] **Step 2: Rust チェック**

Run: `cd src-tauri && cargo check`
Expected: PASS（構文/借用エラー無し。`conn` は既存スコープ）

- [x] **Step 3: コミット**

```bash
git add src-tauri/src/database/migrate.rs
git commit -m "feat(chronicle): 4テーブルのマイグレーション(Rust migrate.rs ミラー)"
```

---

### Task 4: CRUD API（`api.ts`）

**Files:**
- Create: `src/features/chronicle/api.ts`

**Interfaces:**
- Consumes: `db`(`@/db/client`), `events/eventParticipants/sceneEvents/projectCalendar`(`@/db/schema`), `EventPrecision`, `eq`/`inArray`(`drizzle-orm`), `nextEventOrdinal`(`./chronicleTime`)。
- Produces: `EventRow`/`SceneEventRow`/`ParticipantRow`/`CalendarRow` 型、`createEvent`/`updateEvent`/`deleteEvent`/`listEvents`、`setEventParticipants`/`listEventParticipants`、`linkSceneToEvent`/`unlinkSceneFromEvent`/`listSceneEvents`、`getProjectCalendar`/`upsertProjectCalendar`。

- [x] **Step 1: 実装を書く**

```typescript
// src/features/chronicle/api.ts
import { db } from "@/db/client";
import {
  events,
  eventParticipants,
  sceneEvents,
  projectCalendar,
} from "@/db/schema";
import type { EventPrecision } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { nextEventOrdinal } from "./chronicleTime";

export interface EventRow {
  id: string;
  projectId: string;
  title: string;
  note: string | null;
  ordinal: string;
  primaryCodexId: string | null;
  startTime: number | null;
  endTime: number | null;
  precision: EventPrecision;
  createdAt: string;
  updatedAt: string;
}

function s(v: unknown, fallback = ""): string {
  return v == null ? fallback : String(v);
}
function nullableStr(v: unknown): string | null {
  return v == null ? null : String(v);
}
function nullableNum(v: unknown): number | null {
  return v == null ? null : Number(v);
}

export function normalizeEvent(raw: unknown): EventRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    projectId: s(r.projectId ?? r.project_id),
    title: s(r.title),
    note: nullableStr(r.note),
    ordinal: s(r.ordinal ?? r.ordinal, "a0"),
    primaryCodexId: nullableStr(r.primaryCodexId ?? r.primary_codex_id),
    startTime: nullableNum(r.startTime ?? r.start_time),
    endTime: nullableNum(r.endTime ?? r.end_time),
    precision: s(r.precision, "exact") as EventPrecision,
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

export async function listEvents(projectId: string): Promise<EventRow[]> {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.projectId, projectId));
  return rows.map(normalizeEvent);
}

export async function createEvent(data: {
  projectId: string;
  title?: string;
  note?: string | null;
  ordinal?: string;
  primaryCodexId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  precision?: EventPrecision;
}): Promise<EventRow> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let ordinal = data.ordinal;
  if (ordinal === undefined) {
    const existing = await listEvents(data.projectId);
    ordinal = nextEventOrdinal(existing.map((e) => e.ordinal));
  }
  await db.insert(events).values({
    id,
    projectId: data.projectId,
    title: data.title ?? "",
    note: data.note ?? null,
    ordinal,
    primaryCodexId: data.primaryCodexId ?? null,
    startTime: data.startTime ?? null,
    endTime: data.endTime ?? null,
    precision: data.precision ?? "exact",
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(events).where(eq(events.id, id));
  return normalizeEvent(row);
}

export async function updateEvent(
  id: string,
  patch: Partial<
    Pick<
      EventRow,
      | "title"
      | "note"
      | "ordinal"
      | "primaryCodexId"
      | "startTime"
      | "endTime"
      | "precision"
    >
  >,
): Promise<void> {
  await db
    .update(events)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(events.id, id));
}

export async function deleteEvent(id: string): Promise<void> {
  await db.delete(events).where(eq(events.id, id));
}

// ───────── participants ─────────
export interface ParticipantRow {
  eventId: string;
  codexEntryId: string;
  role: string | null;
}

export async function listEventParticipants(
  eventId: string,
): Promise<ParticipantRow[]> {
  const rows = await db
    .select()
    .from(eventParticipants)
    .where(eq(eventParticipants.eventId, eventId));
  return rows.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      eventId: s(r.eventId ?? r.event_id),
      codexEntryId: s(r.codexEntryId ?? r.codex_entry_id),
      role: nullableStr(r.role),
    };
  });
}

/** 参加者集合を置き換える（全削除→再挿入）。role は当面 null 固定で良い。 */
export async function setEventParticipants(
  eventId: string,
  codexEntryIds: string[],
): Promise<void> {
  await db
    .delete(eventParticipants)
    .where(eq(eventParticipants.eventId, eventId));
  if (codexEntryIds.length === 0) return;
  await db
    .insert(eventParticipants)
    .values(codexEntryIds.map((codexEntryId) => ({ eventId, codexEntryId })));
}

// ───────── scene_events 橋 ─────────
export interface SceneEventRow {
  sceneId: string;
  eventId: string;
}

export async function listSceneEvents(
  eventIds: string[],
): Promise<SceneEventRow[]> {
  if (eventIds.length === 0) return [];
  const rows = await db
    .select()
    .from(sceneEvents)
    .where(inArray(sceneEvents.eventId, eventIds));
  return rows.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      sceneId: s(r.sceneId ?? r.scene_id),
      eventId: s(r.eventId ?? r.event_id),
    };
  });
}

export async function linkSceneToEvent(
  sceneId: string,
  eventId: string,
): Promise<void> {
  await db
    .insert(sceneEvents)
    .values({ sceneId, eventId })
    .onConflictDoNothing();
}

export async function unlinkSceneFromEvent(
  sceneId: string,
  eventId: string,
): Promise<void> {
  await db
    .delete(sceneEvents)
    .where(eq(sceneEvents.sceneId, sceneId))
    .then(() => undefined);
}

// ───────── project_calendar ─────────
export interface CalendarRow {
  projectId: string;
  daysPerYear: number;
  /** 生 JSON 文字列（SeasonBoundary[]）。パースは chronicleTime 利用側で。 */
  seasonBoundaries: string;
  createdAt: string;
  updatedAt: string;
}

export async function getProjectCalendar(
  projectId: string,
): Promise<CalendarRow | null> {
  const [raw] = await db
    .select()
    .from(projectCalendar)
    .where(eq(projectCalendar.projectId, projectId));
  if (!raw) return null;
  const r = raw as Record<string, unknown>;
  return {
    projectId: s(r.projectId ?? r.project_id),
    daysPerYear: Number(r.daysPerYear ?? r.days_per_year ?? 360),
    seasonBoundaries: s(r.seasonBoundaries ?? r.season_boundaries, "[]"),
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

export async function upsertProjectCalendar(data: {
  projectId: string;
  daysPerYear: number;
  seasonBoundaries: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(projectCalendar)
    .values({
      projectId: data.projectId,
      daysPerYear: data.daysPerYear,
      seasonBoundaries: data.seasonBoundaries,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectCalendar.projectId,
      set: {
        daysPerYear: data.daysPerYear,
        seasonBoundaries: data.seasonBoundaries,
        updatedAt: now,
      },
    });
}
```

- [x] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: PASS

- [x] **Step 3: Lint**

Run: `pnpm lint:fix`
Expected: エラー無し（未使用 import 等あれば自動修正）

- [x] **Step 4: コミット**

```bash
git add src/features/chronicle/api.ts
git commit -m "feat(chronicle): events/participants/scene_events/calendar の CRUD API"
```

---

### Task 5: 全体検証

- [x] **Step 1: 型・lint・該当テスト・Rust を通す**

```bash
npx tsc --noEmit
pnpm lint:fix
pnpm test --run src/features/chronicle/chronicleTime.test.ts
cd src-tauri && cargo check && cd ..
```
Expected: 全て PASS。

- [x] **Step 2: スモーク（既存テスト退行が無いこと）**

Run: `pnpm test --run src/db` （schema を import する周辺が壊れていないこと）
Expected: PASS（または該当無しで skip）

---

## 後続（本計画外・次の増分）

- P1: `chronicleStore.ts`（Zustand+永続化）／`chronicle` パネル登録（6点＋5プリセット＋自動注入移行）／`ChroniclePanel`＋`ChronicleViewport`（人物レーン・連続ordinal軸・point/interval・オフページ中空）。browser test gate を伴うため別 PR。
- P2: 季節整合チェック（`seasonOf` × シーン記述）。P3: Timeline 連動。P4: 場所/勢力・年齢・2か所同時・因果・AI 抽出。

## Self-Review

- **Spec coverage**: P0 はデータモデル(§4)＋季節判定の純関数核(§8 の基盤)をカバー。UI(§5–7)は明示的に後続。
- **Placeholder scan**: 各ステップに実コード・実コマンド・期待結果あり。TBD 無し。
- **Type consistency**: schema の `ChronicleEvent`/`EVENT_PRECISIONS` と api の `EventRow`/`EventPrecision` は別名で衝突なし。`nextEventOrdinal`/`seasonOf` の署名は Task1 定義と Task4 利用で一致。`onConflictDoNothing`/`onConflictDoUpdate` は既存 sceneCodexPinsApi の実在パターン。
