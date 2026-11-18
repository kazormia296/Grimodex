/**
 * The two layers of what one chat turn hands to its tools (S1-B design 2.7).
 * Types only: the code that builds them is PR-B2's, and while
 * `CHAT_AGENT_IR_ENABLED` is `false` nothing builds them.
 *
 * Both are created once at the start of a turn and are immutable; the current
 * Scene is the one of the turn's start, never read again from a store inside a
 * tool (T2・T3). This file imports nothing of the wrapper, so that the closure
 * test (B-T6) can hold that no product source imports the wrapper statically.
 *
 * The shape of `ChatIrCapability` is provisional until PR-B2 uses it.
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
  /** Records the revision IDs of the items given to the model (`usedIds`). */
  readonly noteUsedIds: (revisionIds: readonly string[]) => void;
}
