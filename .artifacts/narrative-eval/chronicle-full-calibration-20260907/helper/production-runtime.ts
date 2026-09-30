import * as adapter from "@/features/narrative-extraction/eval/productionChronicleAdapter";
import * as suite from "@/features/narrative-extraction/eval/narrativeEvalSuite";
import * as contract from "@/features/narrative-extraction/eval/chronicleV2Contract";
import * as offline from "@/features/narrative-extraction/eval/chronicleLlmJudgeOffline";
import * as storage from "@/features/narrative-extraction/eval/chronicleLlmJudgeStorage.node";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";

export const productionRuntime = {
  ...adapter,
  ...suite,
  ...contract,
  ...offline,
  ...storage,
  runObservationExtractionTask,
  runEventSynthesisTask,
};

