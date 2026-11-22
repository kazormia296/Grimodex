/**
 * The ports of the read core that Electron main and the renderer share
 * (Mastra migration MP-4b, DR-MP4-3). Types and one guard only: the core that
 * takes them arrives in PR-4, and nothing calls this module yet.
 *
 * "Getter form" means a port is read through a function at the moment the core
 * needs it, not captured once. The renderer's implementation returns the live
 * store value each time; main's returns the value fixed at the start of the
 * turn (DR-MP4-8). The core cannot tell which, and a difference between them is
 * an accepted difference recorded in the decisions, not something the core
 * hides.
 *
 * The shapes are structural and minimal. `TreeNodeData` and `SceneTimeIndex`
 * live in `src/` and cannot be imported from here (electron's type check does
 * not resolve `@/`); PR-3b moves the pure modules and replaces these
 * structures with the moved types, and the mutual-assignability test that ties
 * them is part of that change. Until then these structures carry only the
 * fields the read tools read.
 *
 * A closed chat-IR path has no port here: the core holds only the form without
 * it, and the renderer's thin layer keeps its own branch (DR-MP4-3, DR-MP4-21).
 */

/** What a Drizzle `sqlite-proxy` client returns: one array per row, by position. */
export type CoreReadDbClient = (
  sql: string,
  params: unknown[],
  method: string,
) => Promise<{ rows: unknown[][] }>;

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

/** The same shape as `SceneTimeIndex` in `readDomain/features/codex/context/sceneTimeIndex.ts` (moved from `src/`, MP-4b PR-3b-2). */
export interface CoreSceneTimeIndex {
  readonly readingOrder: ReadonlyMap<string, number>;
  readonly explicitStoryOrder: ReadonlyMap<string, string>;
  readonly inheritedStoryOrder: ReadonlyMap<string, string>;
  readonly liveSceneCount: number;
  readonly scheduledSceneCount: number;
  readonly revision: number;
}

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
  getDb(): CoreReadDbClient;
  getTreeState(): CoreTreeState;
  getPhaseState(): CorePhaseState;
  readonly body: CoreBodyReader;
  readonly native: CoreNativeReads;
  countTokens(text: string): number;
  readonly logger: CoreLogger;
  getUiLanguage(): CoreUiLanguage;
  readonly cache: CoreToolCache;
}

/** Refuses an empty or non-string project id (fail closed; never widens a read). */
export function assertCoreProjectId(
  projectId: unknown,
): asserts projectId is string {
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error("read core: projectId is required");
  }
}
