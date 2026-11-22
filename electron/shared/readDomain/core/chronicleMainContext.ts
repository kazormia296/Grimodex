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
 * every batch, so a change made in the middle of a turn (an event's `secret` or
 * reveal scene) reaches the renderer's next batch and not this context: a
 * difference that is not decided here and is held for Q5 (DR-MP4-37). It is not
 * claimed equal and the equivalence tests leave it out.
 *
 * The events are read with every column and with `secret` and `revealSceneId`
 * checked (a row that lost either is an error, never a public event).
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

/**
 * The ports of `search_events` for Electron main (PR-7b, DR-MP4-38). Nothing
 * calls this yet (flag L is closed).
 *
 * Unlike the cached context above, **this one reads the events and the
 * scene-event bridges again for every call**: no `SharedLoader`, no cache of
 * the turn. The tool drops a hit by the events it knows; a hit whose id is not
 * among them passes (moved as the renderer has it). A cached list that is older
 * than the index (an event created or made secret since the turn began) would
 * turn that into a leak of a secret event's title, which the renderer's batch
 * cache and its write tools' invalidation never allow. Reading again for each
 * call keeps the window closed without a wiring of `clear()` (4c-1's). The
 * dense read, the tree state (one fixed state of the turn, as above) and the
 * reading order are the turn's. The events are read fail closed
 * (`readEventsFailClosed`).
 *
 * No state outside the arguments: two turns that run at once share nothing.
 */
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
      getSceneEvents: (projectId) => readSceneEventsForProject(db, projectId),
      // The turn's reading order, whatever nodes are passed (they are the turn's).
      getReadingOrder: () => turn.inputs.readingOrder,
    },
  };
}
