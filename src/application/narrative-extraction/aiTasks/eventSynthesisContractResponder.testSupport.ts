import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";

/** 合成の schema が event に許す actuality（`schemas.ts` の HYPOTHESIS_ACTUALITIES と同じ 4 種類）。 */
const CHRONICLE_EVENT_ACTUALITIES: ReadonlySet<string> = new Set([
  "actual",
  "attempted",
  "prevented",
  "rumored",
]);

const UNRESOLVED_EXIT = '"resolution":"unresolved","events":[]';

/**
 * 試験用の固定応答の model（LLM は呼ばない）。
 *
 * 渡された prompt（合成の root prompt または修復の prompt）が 4 種類の列挙と
 * `unresolved`／`[]` の出口を示すときだけ、それに従う：4 種類の Observation だけを
 * actuality ごとの event にし、4 種類以外は書き換えずに省く。出口が示されないときは、
 * 2026-11-03 の実機（OpenRouter）で観測したとおり、Cluster の先頭の Observation の
 * actuality（例：hypothetical）をそのまま event に写す。
 */
export function contractFollowingSynthesisResponse(input: {
  readonly prompt: string;
  readonly clusterRef: string;
  readonly observations: readonly RawChronicleEventObservation[];
}): string {
  const offersExit =
    input.prompt.includes(UNRESOLVED_EXIT) &&
    input.prompt.includes('"attempted"') &&
    input.prompt.includes('"prevented"') &&
    input.prompt.includes('"rumored"');
  if (!offersExit) {
    const first = input.observations[0];
    return JSON.stringify({
      clusterRef: input.clusterRef,
      resolution: "single-event",
      events: [
        {
          observationRefs: input.observations.map((item) => item.localId),
          titleSuggestion: first?.payload.predicate ?? "出来事",
          summary: first?.payload.predicate ?? "出来事",
          actuality: first?.payload.actuality ?? "unknown",
          significance: "major",
        },
      ],
    });
  }
  const groups = new Map<string, RawChronicleEventObservation[]>();
  for (const observation of input.observations) {
    const actuality = observation.payload.actuality;
    if (!CHRONICLE_EVENT_ACTUALITIES.has(actuality)) continue;
    groups.set(actuality, [...(groups.get(actuality) ?? []), observation]);
  }
  const events = [...groups.entries()].map(([actuality, rows]) => ({
    observationRefs: rows.map((item) => item.localId),
    titleSuggestion: rows[0]!.payload.predicate,
    summary: rows[0]!.payload.predicate,
    actuality,
    significance: "major",
  }));
  return JSON.stringify({
    clusterRef: input.clusterRef,
    resolution:
      events.length === 0
        ? "unresolved"
        : events.length === 1
          ? "single-event"
          : "multiple-events",
    events,
  });
}

/** 送信された messages から prompt 本文を取り出す。 */
export function promptText(
  messages: readonly { readonly content?: unknown }[],
): string {
  const content = messages[0]?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}
