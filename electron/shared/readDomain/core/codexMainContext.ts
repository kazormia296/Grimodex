import type {
  CoreCodexData,
  CoreCodexDetailData,
  CoreCodexEntryContext,
  CoreCodexReadContext,
  CoreCodexVisibilityPorts,
  CoreNativeReads,
  CoreReadDb,
} from "../../mastraRead/ports.js";
import {
  readCodexDetailValues,
  readCodexPhaseDetailOverrides,
  readCodexPhases,
} from "./codexReaders.js";
import type { ReadInputs } from "./readInputs.js";

/**
 * The ports of the Codex visibility decision for Electron main (Mastra migration
 * MP-4b PR-8a, DR-MP4-39). Nothing calls this yet (flag L is closed); it is the
 * Main-side counterpart of the renderer's live store and `listPhasesByEntryIds`,
 * the same position as `createMainChronicleReadContext`. `readCore.mainAdapter.test.ts`
 * and the real-addon spec run the decision over it.
 *
 * One call builds the ports of ONE turn: the reading order, the scene time index
 * and the resolution mode are the turn's inputs (`readReadInputs`, read when the
 * turn starts and then held), and the phases are read from the database on every
 * call. Nothing in this module is module-level state, so two turns that run at
 * once cannot see each other's inputs. The inputs carry their project, and the
 * phase state names it, so the decision refuses a request for another project.
 */
export interface MainCodexVisibilityPortsArgs {
  /** `createCoreReadDb(checkedClient)`. */
  readonly db: CoreReadDb;
  /** The turn's inputs, from `readReadInputs` at the start of the turn. */
  readonly inputs: ReadInputs;
}

export function createMainCodexVisibilityPorts(
  args: MainCodexVisibilityPortsArgs,
): CoreCodexVisibilityPorts & {
  readonly codex: CoreCodexData & CoreCodexDetailData;
} {
  const { db, inputs } = args;
  // One fixed state, the same object each time.
  const phaseState = {
    projectId: inputs.projectId,
    sceneTimeIndex: inputs.sceneTimeIndex,
    resolutionMode: inputs.resolutionMode,
  };
  return {
    getDb: () => db,
    getPhaseState: () => phaseState,
    codex: {
      listPhases: (entryIds) => readCodexPhases(db, entryIds),
      listPhaseDetailOverrides: (phaseIds) =>
        readCodexPhaseDetailOverrides(db, phaseIds),
      listRawDetailValues: (entryIds) => readCodexDetailValues(db, entryIds),
    },
  };
}

export interface MainCodexEntryContextArgs extends MainCodexVisibilityPortsArgs {
  readonly countTokens: (text: string) => number;
  readonly extractPlainText: (json: string) => string;
}

/** `get_codex_entry` の read path が使う、Main の turn 単位の context。 */
export function createMainCodexEntryContext(
  args: MainCodexEntryContextArgs,
): CoreCodexEntryContext {
  const treeState = {
    projectId: args.inputs.projectId,
    nodes: [],
    activeSceneId: args.inputs.currentSceneId,
  };
  return {
    ...createMainCodexVisibilityPorts(args),
    getTreeState: () => treeState,
    countTokens: args.countTokens,
    extractPlainText: args.extractPlainText,
  };
}

/**
 * The ports of the four Codex read tools for Electron main (PR-8b, DR-MP4-40): the visibility ports above,
 * plus the tree state and the two typed reads. Nothing calls this yet (flag L is closed);
 * `readCore.mainAdapter.test.ts` and the real-addon spec run the four tools over it.
 *
 * The project, the current scene and the phase state all come from ONE `ReadInputs`, so they cannot name
 * different projects or scenes: the tree state is `inputs.projectId` and `inputs.currentSceneId` (null when
 * the scene is not in the reading order, which the decision reads as a scene it cannot resolve), and the
 * phase state names the same project (a request for another project is refused). The tree state carries no
 * nodes: the four tools never read them. Nothing is module-level state, so two turns that run at once
 * cannot see each other.
 *
 * `native.codexSemantic` is Main's typed read and does not catch: a missing model, a timeout, a workspace
 * change or a cancelled turn is an error and not "no entry found" (DR-MP4-40). Main has no live store, so
 * the context sets no `getProjectEpoch`.
 */
export interface MainCodexReadContextArgs extends MainCodexVisibilityPortsArgs {
  readonly countTokens: (text: string) => number;
  /** `createMainTypedReads(...)`. */
  readonly native: Pick<CoreNativeReads, "fts" | "codexSemantic">;
}

export function createMainCodexReadContext(
  args: MainCodexReadContextArgs,
): CoreCodexReadContext {
  const treeState = {
    projectId: args.inputs.projectId,
    nodes: [],
    activeSceneId: args.inputs.currentSceneId,
  };
  return {
    ...createMainCodexVisibilityPorts({ db: args.db, inputs: args.inputs }),
    getTreeState: () => treeState,
    countTokens: args.countTokens,
    native: args.native,
  };
}
