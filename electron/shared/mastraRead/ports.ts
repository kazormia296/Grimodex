/**
 * The ports of the read core that Electron main and the renderer share
 * (Mastra migration MP-4b, DR-MP4-3). Types and the project guard. The core
 * that takes them is `readDomain/core/` (PR-4); the renderer's executors call it
 * through live getters, and main does not call it yet.
 *
 * "Getter form" means a port is read through a function at the moment the core
 * needs it, not captured once. The renderer's implementation returns the live
 * store value each time; main's returns the value fixed at the start of the
 * turn (DR-MP4-8). The core cannot tell which, and a difference between them is
 * an accepted difference recorded in the decisions, not something the core
 * hides.
 *
 * The shapes are structural and minimal. `CoreTreeNode` carries only the fields
 * the read tools read, and `TreeNodeData` (moved to `readDomain` in PR-3b) is
 * assignable to it (`ports.test.ts` ties them). `CoreSceneTimeIndex` is the
 * moved `SceneTimeIndex` itself (PR-4).
 *
 * A closed chat-IR path has no port here: the core holds only the form without
 * it, and the renderer's thin layer keeps its own branch (DR-MP4-3, DR-MP4-21).
 */

import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import type * as schema from "../readDomain/db/schema.js";
import type {
  CalendarRow,
  EventRelationRow,
  EventRow,
  ParticipantRow,
  SceneEventRow,
} from "../readDomain/features/chronicle/eventRows.js";
import type { SceneTimeIndex } from "../readDomain/features/codex/context/sceneTimeIndex.js";

/**
 * The statement client under a Drizzle `sqlite-proxy` database: what the
 * renderer's `invoke("db_execute")` and main's checked adapter both are. It
 * returns one array per row, by position.
 */
export type CoreReadDbClient = (
  sql: string,
  params: unknown[],
  method: string,
) => Promise<{ rows: unknown[][] }>;

/**
 * The database the core's executors take: a Drizzle query builder over the
 * schema, not the raw client. The renderer passes its own `db` (so the seam its
 * tests mock stays the same); main passes `createCoreReadDb(checkedClient)`. The
 * core issues selects on it and nothing else (`core.static.test.ts`).
 */
export type CoreReadDb = SqliteRemoteDatabase<typeof schema>;

export type CoreUiLanguage = "ja" | "en";

export type CoreNodeType = "folder" | "scene" | "note";

export interface CoreTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly nodeType: CoreNodeType;
  readonly title: string;
  /** The fractional-index key; siblings are ordered by comparing it. */
  readonly sortOrder: string;
  readonly storyTimeOrder: string | null;
  /** A node with an archive time is not live. */
  readonly archivedAt?: string | null;
  /**
   * The scene's own chronicle date (the anchor source of `get_chronicle_state`;
   * PR-7a). The renderer's store nodes carry them (`TreeNodeData`); Main reads them
   * with the tree select. A node that does not carry them is a node with no date.
   */
  readonly chronicleStartTime?: number | null;
  readonly chronicleStartMinute?: number | null;
  readonly chronicleStartGranularity?: string;
  readonly chroniclePrecision?: string;
}

/**
 * `projectId` is required, and it is checked (`assertCoreProjectId`): an empty
 * one would drop the project condition of a read (an XPROJ read). The shared
 * helpers that already exist keep their own signature and behaviour; only the
 * core's new entries take this type.
 */
export interface CoreTreeState {
  readonly projectId: string;
  readonly nodes: readonly CoreTreeNode[];
  readonly activeSceneId: string | null;
}

export type CorePhaseResolutionMode = "reading" | "story" | "auto";

/** The moved `SceneTimeIndex` (`readDomain/features/codex/context/sceneTimeIndex.ts`): one definition, not a copy of its shape. */
export type CoreSceneTimeIndex = SceneTimeIndex;

/**
 * The resolution mode as a value or an explicit "could not be resolved" (PR-8a,
 * DR-MP4-39). No default: a caller that reads `unresolved` hides what it was
 * asked about (DR-MP4-6 item 3, DR-MP4-8). `ReadInputMode`
 * (`readDomain/core/readInputs.ts`) is assignable to it; the `reason` is for a
 * log and is not read.
 */
export type CorePhaseResolutionState =
  | { readonly kind: "resolved"; readonly mode: CorePhaseResolutionMode }
  | { readonly kind: "unresolved"; readonly reason?: string };

export interface CorePhaseState {
  readonly resolutionMode: CorePhaseResolutionState;
  readonly sceneTimeIndex: CoreSceneTimeIndex;
  /**
   * The project the two values above belong to, when the implementation knows
   * it. Main's are built from one project's rows at the start of a turn and carry
   * it; the renderer's live store has no project and leaves it out. A reader that
   * is given a project and finds a different one here refuses (PR-8a): a scene
   * time index of another project would skip every phase, and a phase that hides a
   * public entry would not apply.
   */
  readonly projectId?: string;
}

export interface CoreBodyReader {
  /**
   * Whether a read waits for a body write that has not reached the store. The
   * renderer waits (`pending-writes-awaited`); main cannot, so a body it reads
   * may lack an unsaved edit (`none`; DR-MP4-9). A port states which it is
   * instead of hiding it.
   */
  readonly barrier: "pending-writes-awaited" | "none";
  /** The body as stored (the editor's JSON text), or `""` when there is none. */
  readSceneBody(sceneId: string): Promise<string>;
  /**
   * The bodies of several scenes: an id to its body. An id with no row is not in
   * the map. The batch is one port call (the renderer reads it in statements of
   * at most 500 ids), so a failure of the whole batch is one rejection.
   */
  readSceneBodies(sceneIds: readonly string[]): Promise<Map<string, string>>;
}

/**
 * `fts_search`'s scope. A union, not a string: `'all'` cannot be passed.
 * `scenes_live` is `scenes` without the archived scenes (Native drops them in
 * its own WHERE, before the limit): a subset of `scenes`, so it reaches no row
 * the other scope did not (DR-ARC-1, a value added to DR-MP4-6's union).
 */
export type FtsScope = "codex" | "scenes" | "scenes_live" | "snippets";

/**
 * The four typed reads and nothing else (DR-MP4-6). Each is a named method,
 * never a command name passed in: a port that took a command name would be a
 * way around the gates of the commands it was not meant to reach.
 * The results are Native's wire values, parsed and not yet narrowed.
 */
export interface CoreNativeReads {
  fts(args: {
    readonly projectId: string;
    readonly query: string;
    readonly scope: FtsScope;
    readonly limit: number;
  }): Promise<unknown>;
  codexSemantic(args: {
    readonly projectId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<unknown>;
  eventsSemantic(args: {
    readonly projectId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<unknown>;
  foreshadowOpen(args: { readonly projectId: string }): Promise<unknown>;
}

export interface CoreLogger {
  debug(tag: string, message: string): void;
  info(tag: string, message: string): void;
  warn(tag: string, message: string): void;
  error(tag: string, message: string): void;
}

export interface CoreReadPorts {
  getDb(): CoreReadDb;
  getTreeState(): CoreTreeState;
  getPhaseState(): CorePhaseState;
  readonly body: CoreBodyReader;
  readonly native: CoreNativeReads;
  countTokens(text: string): number;
  readonly logger: CoreLogger;
  getUiLanguage(): CoreUiLanguage;
}

/**
 * The ports the read executors use: the database, the tree state (for the
 * project), the body reader, the token counter and `native`, the typed reads
 * (PR-5a: the full-text read `fts`; PR-5b: the open-foreshadow read
 * `foreshadowOpen`). A later PR widens this as its tools need more of
 * `CoreReadPorts`; a port no tool reads yet is not asked of the caller.
 *
 * `native` is its own member and not a `Pick` key of `CoreReadPorts`: that
 * would ask for all four typed reads, and the two semantic reads have no reader
 * in the core yet (PR-7 and PR-8 add theirs).
 */
export type CoreReadContext = Pick<
  CoreReadPorts,
  "getDb" | "getTreeState" | "body" | "countTokens"
> & {
  readonly native: Pick<CoreNativeReads, "fts" | "foreshadowOpen">;
};

/**
 * What the Codex visibility decision loads besides the entries (PR-8a,
 * DR-MP4-39). A loader port and not a database read: the renderer's
 * implementation calls its own `listPhasesByEntryIds` (so the seam its tests mock
 * stays the same), Main's reads `codex_entry_phases` with a Drizzle select
 * (`readDomain/core/codexReaders.ts`).
 */
export interface CoreCodexData {
  /**
   * The phases of the given entries, in any order (the resolver orders them).
   * The caller passes only ids of entries it read under a project condition:
   * `codex_entry_phases` has no `project_id` column, so a reader cannot enforce
   * the project, and an id of another project's entry would return that entry's
   * phases.
   */
  listPhases(entryIds: readonly string[]): Promise<schema.CodexEntryPhase[]>;
}

/** 共有の可視性判定で公開された項目に限って読む詳細行。 */
export interface CoreCodexDetailData {
  listPhaseDetailOverrides(
    phaseIds: readonly string[],
  ): Promise<schema.CodexPhaseDetailOverride[]>;
  listRawDetailValues(
    entryIds: readonly string[],
  ): Promise<Array<{ entryId: string; definitionId: string; value: string | null }>>;
}

/**
 * The ports of the Codex visibility decision (`readDomain/core/codexVisibility.ts`).
 * Its own type and not a widening of `CoreReadContext`: no tool takes it yet, and
 * a literal of `CoreReadContext` in a test must not have to grow.
 */
export type CoreCodexVisibilityPorts = Pick<
  CoreReadPorts,
  "getDb" | "getPhaseState"
> & {
  readonly codex: CoreCodexData;
  /**
   * The project epoch of a live store that can be reset in the middle of a decision
   * (PR-8b, DR-MP4-40). Optional, and the renderer's only: its `resolveCodexForAi` notes the epoch
   * before it reads and refuses (every id hidden) when the epoch differs after the reads, because a
   * project switch in between leaves the scene time index empty and the mode of the previous project
   * (DR-MP4-41 (b)). The renderer's four Codex tools now go through the core, and this carries the check
   * with them. Main leaves it out: its phase state is the turn's inputs, bound to the project, and there
   * is no live store to switch.
   */
  readonly getProjectEpoch?: () => number;
};

/**
 * `get_codex_entry` の read path が使う context。renderer は読込中に live phase store が
 * 切り替わりうるため `getProjectEpoch` を渡す。Main は turn の入力から組み立て、epoch を持たない。
 */
export type CoreCodexEntryContext = Omit<
  CoreCodexVisibilityPorts,
  "codex"
> &
  Pick<CoreReadPorts, "getTreeState" | "countTokens"> & {
    readonly codex: CoreCodexData & CoreCodexDetailData;
    readonly extractPlainText: (json: string) => string;
  };

/**
 * The ports of the four Codex read tools (`search_codex`, `list_codex_by_type`, `search_codex_by_tags`,
 * `find_related_entries`; PR-8b, DR-MP4-40): the visibility decision's ports (the database for the entries
 * and the phase loader), the tree state (the project and the current scene), the token counter, and the two
 * typed reads the search needs (`fts`, and the dense read of the Codex index). Its own type and not a
 * widening of `CoreReadContext`, for the reason the chronicle tools have theirs: a literal of
 * `CoreReadContext` in a test must not have to grow.
 *
 * `native.codexSemantic` answers the wire as it is, not narrowed. A failure of it is not turned into an
 * empty answer by the core: the renderer's port answers an empty list (a missing model reads as "sparse
 * only"), Main lets the error out, so a cancel or a timeout never reads as "no entry found" (DR-MP4-40).
 */
export type CoreCodexReadContext = CoreCodexVisibilityPorts &
  Pick<CoreReadPorts, "getTreeState" | "countTokens"> & {
    readonly native: Pick<CoreNativeReads, "fts" | "codexSemantic">;
  };

/**
 * What the chronicle read tools (`list_events`, `get_event_detail`,
 * `get_character_timeline`, `get_chronicle_state`; PR-7a, DR-MP4-37) load. A
 * loader port, not a database: the renderer's implementation calls its own
 * cached loaders and `chronicle/api` (so the seams its tests mock stay the same),
 * Main's is built from Drizzle selects over one turn's inputs
 * (`readDomain/core/chronicleMainContext.ts`). The core never sees which.
 *
 * Which of them are cached is the implementation's business (the renderer
 * shares `getEvents`, `getSceneEvents`, `getCodexNames` and the reading order inside
 * a batch; `listParticipants`, `listRelations` and `getCalendar` read every call). The
 * arrays and maps are shared instances: the core reads them and never writes.
 */
export interface CoreChronicleData {
  getEvents(projectId: string): Promise<EventRow[]>;
  getSceneEvents(projectId: string): Promise<SceneEventRow[]>;
  /** The codex id to name. Hidden entries are in it (DR-MP4-37: moved as it is). */
  getCodexNames(projectId: string): Promise<Map<string, string>>;
  /**
   * The reading order of the nodes the core was just given. The core passes the
   * array it got from `getTreeState().nodes` as it is (the renderer memoizes by
   * that reference) and copies the answer before it hands it to a function that
   * takes a `Map`.
   */
  getReadingOrder(nodes: readonly CoreTreeNode[]): ReadonlyMap<string, number>;
  listParticipants(
    projectId: string,
    eventIds?: string[],
  ): Promise<ParticipantRow[]>;
  listRelations(projectId: string): Promise<EventRelationRow[]>;
  getCalendar(projectId: string): Promise<CalendarRow | null>;
}

/**
 * The ports of the chronicle read tools. Its own type and not a widening of
 * `CoreReadContext`: those tools need no database and no body reader, and a
 * renderer module that builds this context must not have to import the
 * renderer's `db` client.
 */
export type CoreChronicleReadContext = Pick<
  CoreReadPorts,
  "getTreeState" | "countTokens" | "getUiLanguage"
> & {
  readonly chronicle: CoreChronicleData;
};

/**
 * The ports of `search_events` (PR-7b, DR-MP4-38): the tree state (the project,
 * the nodes and the active scene), the token counter, the three chronicle
 * loaders the secrecy check needs, and the dense read of the events index. Its
 * own type, not a widening of `CoreChronicleReadContext` (which stays as it is:
 * the four chronicle tools need no dense read) and not of `CoreReadContext`
 * (`native` there lacks `eventsSemantic`). A `CoreChronicleReadContext` that has
 * a `native` satisfies this type structurally, but Main does not pass its cached
 * context: a hit that the cached events do not know would pass the secrecy check
 * (DR-MP4-38), so Main's context loads the events and the scene-event bridges
 * again for each call (`createMainChronicleSearchContext`).
 *
 * `native.eventsSemantic` answers the wire as it is, not narrowed. A failure of
 * it is not turned into an empty answer by the core: what a caller does with it
 * is the caller's (the renderer's port answers an empty list, Main lets the
 * error out, so a cancel or a timeout never reads as "no event found").
 */
export type CoreChronicleSearchContext = Pick<
  CoreReadPorts,
  "getTreeState" | "countTokens"
> & {
  readonly chronicle: Pick<
    CoreChronicleData,
    "getEvents" | "getSceneEvents" | "getReadingOrder"
  >;
  readonly native: Pick<CoreNativeReads, "eventsSemantic">;
};

/**
 * The project a read needs is missing. A distinct class, so a caller that
 * answers an empty project with a result of its own (the renderer's
 * `No active project`) can tell it from any other failure without reading the
 * message.
 */
export class CoreProjectRequiredError extends Error {
  constructor() {
    super("read core: projectId is required");
    this.name = "CoreProjectRequiredError";
  }
}

/** Refuses an empty or non-string project id (fail closed; never widens a read). */
export function assertCoreProjectId(
  projectId: unknown,
): asserts projectId is string {
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new CoreProjectRequiredError();
  }
}
