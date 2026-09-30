import corpus from "../../evals/nir1-retrieval/corpus.json" with { type: "json" };

type Section = { contextId: string; inputRef: string; value: string };
type Seed = {
  summary: string;
  actuality: string;
  attribution: string;
  narrativeFrame: string;
};
type Scene = {
  id: string;
  title: string;
  body: string;
  interpretationSeed?: Seed | null;
};
const scenes: Scene[] = Object.values(corpus.languages).flatMap(
  (language) => language.scenes,
);

// This mapping is reachable only behind the existing deterministic Journey
// provider gate. It supplies response text before the production parser and
// Adapter, and never creates a persisted semantic artifact or authority.
export function productJourneyNir1Observation(
  sections: Section[],
): object | null {
  if (
    sections.length !== 1 ||
    !sections[0]!.contextId.startsWith("observation-citation-window:")
  )
    return null;
  const segments = sections[0]!.value
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (segments.some((segment) => typeof segment.text !== "string")) return null;
  const body = segments
    .map((segment) => segment.text)
    .join("")
    .trim();
  const matches = scenes.filter((scene) => scene.body === body);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("NIR-1 Journey ambiguous source");
  const scene = matches[0]!;
  if (!scene.interpretationSeed)
    throw new Error("NIR-1 Journey Raw-only source must not produce IR");
  const evidence = segments.filter((segment) => segment.kind === "span");
  if (
    evidence.length === 0 ||
    evidence.some((segment) => typeof segment.evidenceRef !== "string") ||
    segments.some(
      (segment) => segment.kind !== "span" && String(segment.text).trim(),
    ) ||
    new Set(evidence.map((segment) => segment.evidenceRef)).size !==
      evidence.length
  )
    throw new Error("NIR-1 Journey requires complete current source citations");
  const seed = scene.interpretationSeed;
  return {
    observations: [
      {
        localId: `nir1-${scene.id}`,
        evidenceRefs: evidence.map((segment) => segment.evidenceRef),
        assertion: {
          attribution: seed.attribution,
          narrativeFrame: seed.narrativeFrame,
        },
        payload: {
          predicate: seed.summary,
          actuality: seed.actuality,
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ],
  };
}

export function productJourneyNir1Synthesis(
  sections: Section[],
): object | null {
  const observations = sections.filter((row) =>
    row.contextId.startsWith("event-observation:"),
  );
  if (observations.length !== 1) return null;
  const observation = observations[0]!;
  const match =
    /^- localId=([^;]+); actuality=([^;]+); predicate=([^;]+); evidence=/u.exec(
      observation.value,
    );
  if (!match) return null;
  const matches = scenes.filter(
    (scene) => scene.interpretationSeed?.summary === match[3],
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1)
    throw new Error("NIR-1 Journey ambiguous semantic seed");
  const scene = matches[0]!;
  const seed = scene.interpretationSeed!;
  const clusters = sections.filter((row) =>
    row.contextId.startsWith("event-cluster:"),
  );
  if (
    sections.length !== 2 ||
    clusters.length !== 1 ||
    observation.contextId !== `event-observation:${match[1]}` ||
    observation.inputRef !== `observation:${match[1]}` ||
    seed.actuality !== match[2]
  )
    throw new Error(
      "NIR-1 Journey synthesis coordinates or actuality disagree",
    );
  const cluster = clusters[0]!;
  if (
    cluster.contextId !== `event-cluster:${cluster.value}` ||
    cluster.inputRef !== `cluster:${cluster.value}`
  )
    throw new Error("NIR-1 Journey cluster coordinates disagree");
  return {
    clusterRef: cluster.value,
    resolution: "single-event",
    events: [
      {
        observationRefs: [match[1]],
        titleSuggestion: scene.title,
        summary: seed.summary,
        actuality: seed.actuality,
        significance: "major",
      },
    ],
  };
}
