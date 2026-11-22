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

export interface CorePhaseState {
  readonly resolutionMode: CorePhaseResolutionMode;
  readonly sceneTimeIndex: CoreSceneTimeIndex;
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

/** `fts_search`'s scope. A union, not a string: `'all'` cannot be passed. */
export type FtsScope = "codex" | "scenes" | "snippets";

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

/**
 * A per-turn cache (DR-MP4-16): main builds one per turn, the renderer keeps
 * its module-level singletons behind this interface. A failed load is not
 * kept, so the next call retries.
 */
export interface CoreToolCache {
  getOrLoad<T>(
    name: string,
    key: string,
    load: (key: string) => Promise<T>,
  ): Promise<T>;
  clear(): void;
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
  readonly cache: CoreToolCache;
}

/**
 * The ports the read executors use: the database, the tree state (for the
 * project), the body reader, the token counter and, since PR-5a, the full-text
 * read of `native`. A later PR widens this as its tools need more of
 * `CoreReadPorts`; a port no tool reads yet is not asked of the caller.
 *
 * `native` is its own member and not a `Pick` key of `CoreReadPorts`: that
 * would ask for all four typed reads, and the two semantic reads and the
 * foreshadow read have no reader in the core yet (PR-5b, PR-7 and PR-8 add
 * theirs).
 */
export type CoreReadContext = Pick<
  CoreReadPorts,
  "getDb" | "getTreeState" | "body" | "countTokens"
> & {
  readonly native: Pick<CoreNativeReads, "fts">;
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
