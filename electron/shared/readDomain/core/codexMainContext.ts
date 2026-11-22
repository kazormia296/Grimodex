import type {
  CoreCodexVisibilityPorts,
  CoreReadDb,
} from "../../mastraRead/ports.js";
import { readCodexPhases } from "./codexReaders.js";
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
): CoreCodexVisibilityPorts {
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
    codex: { listPhases: (entryIds) => readCodexPhases(db, entryIds) },
  };
}
