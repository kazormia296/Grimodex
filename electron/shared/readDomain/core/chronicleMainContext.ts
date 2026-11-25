import type {
  CoreChronicleReadContext,
  CoreChronicleSearchContext,
  CoreNativeReads,
  CoreReadDb,
  CoreTreeState,
  CoreUiLanguage,
} from "../../mastraRead/ports.js";
import {
  readCodexNames,
  readEventParticipantsForProject,
  readEventRelations,
  readEventsFailClosed,
  readProjectCalendar,
  readSceneEventsForProject,
} from "./chronicleReaders.js";
import { createMainCodexVisibilityPorts } from "./codexMainContext.js";
import { listHiddenCodexIds as listHiddenCodexIdsFromPorts } from "./codexVisibility.js";
import type { ChronicleReadInputs } from "./readInputsReader.js";
import { SharedLoader } from "./sharedLoader.js";

/**
 * The ports of the chronicle read tools for Electron main (Mastra migration
 * MP-4b PR-7a, DR-MP4-37). Nothing calls this yet (flag L is closed); it is the
 * Main-side counterpart of the renderer's `chronicleReadContext.ts`, and
 * `readCore.mainAdapter.test.ts` and the real-addon spec run the core over it.
 *
 * One call builds the context of ONE turn: the tree state and the reading order
 * are the turn's inputs (`readChronicleReadInputs`, one tree select, read when
 * the turn starts and then held), and the events, the scene-event bridges and the
 * Codex names are loaded on first use and kept by a cache instance made here.
 * Nothing in this module is module-level state (no registry, no module
 * singleton): two turns that run at once cannot see each other's cache, reading
 * order or project (`chronicleMainContext.test.ts` runs them against each other).
 *
 * The cache lives as long as the context, i.e. the turn, unless `clear()` is
 * called (wiring it to each send is 4c-1's). The renderer's cache is dropped for
 * every batch, so a change made in the middle of a turn (an event's title, say)
 * reaches the renderer's next batch and not this context: a difference that is
 * not decided here and is held for Q5 (DR-MP4-37). It is not claimed equal and
 * the equivalence tests leave it out. (The event's `secret` no longer decides
 * what the AI may read, CSR/1; a hidden Codex entry is judged per call by the
 * port `listHiddenCodexIds`, which is not cached.)
 *
 * The events are read with every column and with `revealSceneId` checked (a row
 * that lost it is an error, never an event with no disclosure scene).
 * `listParticipants`, `listRelations` and `getCalendar` read every call, as the
 * renderer's do.
 *
 * The UI language has no default here: where Main takes it from is open (Q4),
 * so the caller has to pass it.
 */
export interface MainChronicleReadContextArgs {
  /** `createCoreReadDb(checkedClient)`. */
  readonly db: CoreReadDb;
  /** The turn's inputs: from `readChronicleReadInputs`, at the start of the turn. */
  readonly turn: ChronicleReadInputs;
  readonly countTokens: (text: string) => number;
  readonly getUiLanguage: () => CoreUiLanguage;
}

export interface MainChronicleReadContext {
  readonly ctx: CoreChronicleReadContext;
  /** Drops the loaded events, bridges and names (a load in flight does not come back into the slots). */
  clear(): void;
}

export function createMainChronicleReadContext(
  args: MainChronicleReadContextArgs,
): MainChronicleReadContext {
  const { db, turn } = args;
  const events = new SharedLoader((projectId) =>
    readEventsFailClosed(db, projectId),
  );
  const sceneEvents = new SharedLoader((projectId) =>
    readSceneEventsForProject(db, projectId),
  );
  const codexNames = new SharedLoader((projectId) =>
    readCodexNames(db, projectId),
  );
  const treeState = turnTreeState(turn);
  const ctx: CoreChronicleReadContext = {
    getTreeState: () => treeState,
    countTokens: args.countTokens,
    getUiLanguage: args.getUiLanguage,
    chronicle: {
      getEvents: (projectId) => events.get(projectId),
      getSceneEvents: (projectId) => sceneEvents.get(projectId),
      getCodexNames: (projectId) => codexNames.get(projectId),
      listHiddenCodexIds: (projectId, ids) =>
        listHiddenCodexIdsFromPorts(
          createMainCodexVisibilityPorts({ db, inputs: turn.inputs }),
          {
            projectId,
            entryIds: ids,
            sceneId: turn.inputs.currentSceneId,
          },
        ),
      // The turn's reading order, whatever nodes are passed (they are the turn's).
      getReadingOrder: () => turn.inputs.readingOrder,
      listParticipants: (projectId, eventIds) =>
        readEventParticipantsForProject(db, projectId, eventIds),
      listRelations: (projectId) => readEventRelations(db, projectId),
      getCalendar: (projectId) => readProjectCalendar(db, projectId),
    },
  };
  return {
    ctx,
    clear: () => {
      events.clear();
      sceneEvents.clear();
      codexNames.clear();
    },
  };
}

/**
 * One fixed state, the same object each time: the nodes array keeps its
 * reference. `activeSceneId` is the turn's current scene, already null when it
 * is not a live scene of the project (`ReadInputs.currentSceneId`).
 */
function turnTreeState(turn: ChronicleReadInputs): CoreTreeState {
  return {
    projectId: turn.inputs.projectId,
    nodes: turn.nodes,
    activeSceneId: turn.inputs.currentSceneId,
  };
}

/** Main の検索 context。dense hit があるときだけ年表の出来事を読む。 */
export interface MainChronicleSearchContextArgs {
  /** `createCoreReadDb(checkedClient)`. */
  readonly db: CoreReadDb;
  /** The turn's inputs: from `readChronicleReadInputs`, at the start of the turn. */
  readonly turn: ChronicleReadInputs;
  readonly countTokens: (text: string) => number;
  /** Main's typed read (`createMainTypedReads(...)`): only the dense read of the events index is used. */
  readonly native: Pick<CoreNativeReads, "eventsSemantic">;
}

export function createMainChronicleSearchContext(
  args: MainChronicleSearchContextArgs,
): CoreChronicleSearchContext {
  const { db, turn } = args;
  const treeState = turnTreeState(turn);
  return {
    getTreeState: () => treeState,
    countTokens: args.countTokens,
    native: args.native,
    chronicle: {
      getEvents: (projectId) => readEventsFailClosed(db, projectId),
      getReadingOrder: () => turn.inputs.readingOrder,
    },
  };
}
