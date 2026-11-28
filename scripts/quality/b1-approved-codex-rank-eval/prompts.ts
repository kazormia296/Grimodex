import {
  buildSystemPrompt,
  PROMPT_DATA_TAGS,
  type BuildSystemPromptInput,
} from "@/features/chat/contextBuilder";
import { createApprovedCodexRanker } from "@/features/chat/context/approvedCodexRank";
import fixtures from "./fixture.v1.json";

export type EvalCase = (typeof fixtures)[number];
export const cases = fixtures as readonly EvalCase[];
export function buildPair(evalCase: EvalCase) {
  const base: BuildSystemPromptInput = {
    scene: evalCase.scene,
    codexEntries: evalCase.codexEntries,
    contextWindow: 32_768,
    outputReservationTokens: 4000,
  };
  const control = buildSystemPrompt(base);
  const ranked = buildSystemPrompt({
    ...base,
    approvedCodexRanker: createApprovedCodexRanker(
      new Set(evalCase.approvedCodexEntryIds),
    ),
  });
  const keys = (result: typeof control) =>
    result.contextPlan?.items.map((item) => item.key) ?? [];
  const l4 = (result: typeof control) =>
    result.layers.find((layer) => layer.layer === "L4")?.used;
  const nonL4 = (result: typeof control) =>
    result.layers.filter((layer) => layer.layer !== "L4");
  const sameSelection =
    keys(control).length === keys(ranked).length &&
    keys(control).every((key) => keys(ranked).includes(key));
  const l4Block = new RegExp(
    `<${PROMPT_DATA_TAGS.l4}>[\\s\\S]*?</${PROMPT_DATA_TAGS.l4}>`,
    "u",
  );
  const withoutL4 = (prompt: string) => prompt.replace(l4Block, "<L4>");
  const sameOuterLayers =
    JSON.stringify(nonL4(control)) === JSON.stringify(nonL4(ranked)) &&
    withoutL4(control.prompt) === withoutL4(ranked.prompt);
  return {
    control,
    ranked,
    controlKeys: keys(control),
    rankedKeys: keys(ranked),
    sameSelection,
    sameOuterLayers,
    sameTotal: control.totalTokens === ranked.totalTokens,
    l4Changed: JSON.stringify(keys(control)) !== JSON.stringify(keys(ranked)),
    l4TokenCount: l4(control),
  };
}
