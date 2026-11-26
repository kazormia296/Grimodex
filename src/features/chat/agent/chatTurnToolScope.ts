/**
 * The turn's scene pin and the optional IR layers passed to its tools.
 * Types only: the code that builds them is PR-B2's.
 *
 * The scene is captured once at turn start and never read again from a store
 * inside a tool (T2・T3). Scope and IR are only created when their gate allows
 * them. This file imports nothing of the wrapper, so the closure test (B-T6)
 * can hold that no product source imports the wrapper statically.
 *
 * PR-B2 builds them in `createChatTurnToolContext`
 * (`src/application/chat/chatAgentToolHandlers.ts`).
 */

/**
 * What the position filter of the Chronicle tool needs. Given to the main
 * agent and to the sub-agent (design 2.5, case T), and so it holds no IR.
 */
export interface ChatTurnToolScope {
  readonly projectId: string;
  /** `null` when no Scene is open: the position filter is not applied. */
  readonly currentSceneId: string | null;
}

/** The IR budget of one turn. A fresh object for every turn, never a module's. */
export interface ChatIrTurnCounter {
  /** UTF-16 `length` of the IR text added to the turn so far. */
  chars: number;
  /** How many times the turn asked Native (a call that was refused before the IPC is not counted). */
  calls: number;
}

/**
 * What the IR branch of the executor needs besides the scope. Given to the
 * main agent only: a sub-agent has none, which keeps IR out of it by
 * construction. Absent (`undefined`) means the executor does not call IR.
 */
export interface ChatIrCapability {
  /** `null` when the workspace has no path: the wrapper reports `no-workspace`. */
  readonly workspacePath: string | null;
  /** The IR share of the tool result, in tokens. */
  readonly tokenCap: number;
  readonly counter: ChatIrTurnCounter;
  /** Throws when the project or the workspace is no longer the turn's. */
  readonly assertCurrent: () => void;
  /**
   * Records the revision IDs of the items given to the model (`usedIds`), and
   * the event IDs of the items merged with the year table (S1-A2b: exactly the
   * ones the model saw in `chronicleIr.eventIds`).
   * `key` is the `params` object of the tool call (design PR-B2 3.2, case P):
   * the turn copies the note onto the tool call's record by that object.
   */
  readonly noteUsedIds: (
    key: object,
    revisionIds: readonly string[],
    eventIds: readonly string[],
  ) => void;
}

/**
 * Where the items given to the model came from. `eventIds` are the events of
 * the items that were merged with the year table (what the model was shown);
 * `generation` is `null` (the item has none).
 */
export interface ChatIrUsedIds {
  revisionIds: string[];
  eventIds: string[];
  generation: number | null;
}

/**
 * What one tool run gets beyond its parameters. The main agent's `executeTool`
 * takes the whole of it; the sub-agent's `executeReadOnlyTool` takes
 * `ChatReadOnlyToolRunContext`, which has no `ir`, so IR cannot reach it.
 */
export interface ChatToolRunContext {
  /** Turn-start scene, present even when the IR feature is disabled. */
  readonly currentSceneId?: string | null;
  readonly scope?: ChatTurnToolScope;
  readonly ir?: ChatIrCapability;
}

export interface ChatReadOnlyToolRunContext {
  /** Turn-start scene, present even when the IR feature is disabled. */
  readonly currentSceneId?: string | null;
  readonly scope?: ChatTurnToolScope;
}
