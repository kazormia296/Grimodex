import { and, asc, eq, inArray } from "drizzle-orm";

import type { CoreReadDb } from "../../mastraRead/ports.js";
import {
  codexEntries,
  eventParticipants,
  eventRelations,
  events,
  projectCalendar,
  sceneEvents,
} from "../db/schema.js";
import type {
  CalendarRow,
  EventRelationRow,
  EventRow,
  ParticipantRow,
  SceneEventRow,
} from "../features/chronicle/eventRows.js";
import {
  normalizeCalendarRow,
  normalizeEvent,
  normalizeEventFailClosed,
  normalizeEventRelationRow,
  normalizeParticipantRow,
  normalizeSceneEventRow,
} from "../features/chronicle/readRows.js";

/**
 * The Drizzle selects of the chronicle reads (Mastra migration MP-4b PR-7a,
 * DR-MP4-37), moved out of the renderer's `chronicle/api.ts` with the SQL, the
 * order and the key of every statement unchanged. `api.ts` calls them with its
 * own `db` (its read functions are thin delegations, so the golden of the
 * renderer's tools runs this SQL on sql.js); Main's loaders
 * (`chronicleMainContext.ts`) call them with `createCoreReadDb(checkedClient)`.
 *
 * The readers take the `projectId` they are given and do not check it: an
 * empty one reads `project_id = ''` (no rows), as the renderer's functions did,
 * and a UI caller must not get a new throw. The tools check the project before
 * they call a reader (`requireCoreProjectId`).
 *
 * Statements with no total ORDER BY (participants, scene-event bridges,
 * relations) return in the database's order, as they did. Nothing here adds one
 * (it would change the SQL; DR-MP4-33e).
 */

/** The rows of the project's events, as Drizzle returns them (`ordinal`, `id` order). */
async function selectEventRows(
  db: CoreReadDb,
  projectId: string,
): Promise<unknown[]> {
  // ordinal,id の二段ソートで決定論的な並び（ordinal 重複でもリロード間で順序が
  // 揺れない）を保証する。年表 x 軸順の安定性が下流の座標算出に効く。
  return db
    .select()
    .from(events)
    .where(eq(events.projectId, projectId))
    .orderBy(asc(events.ordinal), asc(events.id));
}

/** The renderer's read: a row is normalized as it always was. */
export async function readEvents(
  db: CoreReadDb,
  projectId: string,
): Promise<EventRow[]> {
  return (await selectEventRows(db, projectId)).map(normalizeEvent);
}

/**
 * Main's read: every column (no projection), and a row that lost `secret` or
 * `revealSceneId` is an error (`normalizeEventFailClosed`, DR-MP4-37).
 */
export async function readEventsFailClosed(
  db: CoreReadDb,
  projectId: string,
): Promise<EventRow[]> {
  return (await selectEventRows(db, projectId)).map(normalizeEventFailClosed);
}

/**
 * project スコープで参加者を一括取得（XPROJ 安全）。
 * event_participants は project_id 列を持たないため events へ INNER JOIN し
 * events.project_id でスコープする。AI / MCP / write 経路はこの API のみ使う
 * （素の listEventParticipants(eventId) は project gate が無いため AI 経路では禁止）。
 * @param eventIds undefined=project 全件 / [] = 0 件（フィルタ対象なし）。
 */
export async function readEventParticipantsForProject(
  db: CoreReadDb,
  projectId: string,
  eventIds?: string[],
): Promise<ParticipantRow[]> {
  if (eventIds && eventIds.length === 0) return [];
  const conds = [eq(events.projectId, projectId)];
  if (eventIds) conds.push(inArray(eventParticipants.eventId, eventIds));
  const rows = await db
    .select({
      eventId: eventParticipants.eventId,
      codexEntryId: eventParticipants.codexEntryId,
      role: eventParticipants.role,
    })
    .from(eventParticipants)
    .innerJoin(events, eq(eventParticipants.eventId, events.id))
    .where(and(...conds));
  return rows.map(normalizeParticipantRow);
}

/**
 * project スコープで scene↔event 橋を一括取得（XPROJ 安全）。
 * scene_events は project_id 列を持たないため events へ INNER JOIN し
 * events.project_id でスコープする。AI / MCP 経路はこの API のみ使う。
 * @param opts.eventIds / opts.sceneIds いずれも [] は 0 件（フィルタ対象なし）。
 */
export async function readSceneEventsForProject(
  db: CoreReadDb,
  projectId: string,
  opts?: { eventIds?: string[]; sceneIds?: string[] },
): Promise<SceneEventRow[]> {
  if (opts?.eventIds && opts.eventIds.length === 0) return [];
  if (opts?.sceneIds && opts.sceneIds.length === 0) return [];
  const conds = [eq(events.projectId, projectId)];
  if (opts?.eventIds) conds.push(inArray(sceneEvents.eventId, opts.eventIds));
  if (opts?.sceneIds) conds.push(inArray(sceneEvents.sceneId, opts.sceneIds));
  const rows = await db
    .select({ sceneId: sceneEvents.sceneId, eventId: sceneEvents.eventId })
    .from(sceneEvents)
    .innerJoin(events, eq(sceneEvents.eventId, events.id))
    .where(and(...conds));
  return rows.map(normalizeSceneEventRow);
}

export async function readProjectCalendar(
  db: CoreReadDb,
  projectId: string,
): Promise<CalendarRow | null> {
  const [raw] = await db
    .select()
    .from(projectCalendar)
    .where(eq(projectCalendar.projectId, projectId));
  if (!raw) return null;
  return normalizeCalendarRow(raw);
}

export async function readEventRelations(
  db: CoreReadDb,
  projectId: string,
): Promise<EventRelationRow[]> {
  const rows = await db
    .select()
    .from(eventRelations)
    .where(eq(eventRelations.projectId, projectId));
  return rows.map(normalizeEventRelationRow);
}

/**
 * The id to name of the project's codex entries, for Main (two columns). The
 * renderer reads the same map through `listCodexMatchTargets` (six columns; the
 * name and the project condition are the same, and the last test of
 * `src/features/chat/agent/readCore.mainAdapter.test.ts` keeps the two maps
 * equal). Every entry of the project is in it, hidden ones
 * included: the four chronicle tools return a Codex name as it is (DR-MP4-37).
 */
export async function readCodexNames(
  db: CoreReadDb,
  projectId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: codexEntries.id, name: codexEntries.name })
    .from(codexEntries)
    .where(eq(codexEntries.projectId, projectId));
  return new Map(rows.map((e) => [e.id, e.name] as const));
}
