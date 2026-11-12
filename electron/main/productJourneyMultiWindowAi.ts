import fixture from "../shared/productJourneyMultiWindowFixture.json" with { type: "json" };

type Section = { contextId: string; inputRef: string; value: string };
type Row = (typeof fixture.rows)[number];
type ClusterKey = keyof typeof fixture.clusters;

// Reachable only behind the existing deterministic Journey provider gate, like
// the other Journey responses. It supplies response text before the production
// parser and Adapter and never creates a persisted artifact or authority. It
// answers a request only when one of this fixture's marker sentences is in it;
// every other request returns null and is left to the other responses.
function isClusterKey(value: string): value is ClusterKey {
  return Object.hasOwn(fixture.clusters, value);
}

export function productJourneyMultiWindowObservation(
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
  const marked = (row: Row) =>
    segments.some((segment) => String(segment.text).includes(row.marker));
  if (!fixture.rows.some(marked)) return null;
  const observations = fixture.rows.flatMap((row) => {
    // Only a fully visible span carries a citation alias; a marker that is
    // only context in this window belongs to another window's request.
    const spans = segments.filter(
      (segment) =>
        segment.kind === "span" &&
        String(segment.text).includes(row.marker) &&
        typeof segment.evidenceRef === "string",
    );
    if (spans.length === 0) return [];
    if (spans.length !== 1)
      throw new Error(`Multi-window Journey marker is ambiguous: ${row.key}`);
    return [
      {
        localId: row.key,
        evidenceRefs: [spans[0]!.evidenceRef],
        assertion: { attribution: "narrator", narrativeFrame: "story-world" },
        payload: {
          predicate: row.predicate,
          actuality: "actual",
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ];
  });
  return { observations };
}

export function productJourneyMultiWindowSynthesis(
  sections: Section[],
): object | null {
  const clusters = sections.filter((row) =>
    row.contextId.startsWith("event-cluster:"),
  );
  const observations = sections.filter((row) =>
    row.contextId.startsWith("event-observation:"),
  );
  if (clusters.length !== 1 || observations.length === 0) return null;
  const parsed = observations.map((section) => {
    const match =
      /^- localId=([^;]+); actuality=([^;]+); predicate=([^;]+); evidence=/u.exec(
        section.value,
      );
    if (
      !match ||
      section.contextId !== `event-observation:${match[1]}` ||
      section.inputRef !== `observation:${match[1]}`
    )
      return null;
    const rows = fixture.rows.filter((row) => row.predicate === match[3]);
    return rows.length === 0 ? null : { localId: match[1]!, rows };
  });
  if (parsed.some((entry) => entry === null)) return null;
  const names = new Set(
    parsed.flatMap((entry) => entry!.rows.map((row) => row.cluster)),
  );
  const [name] = names;
  if (names.size !== 1 || name === undefined || !isClusterKey(name))
    throw new Error("Multi-window Journey cluster membership is ambiguous");
  const cluster = clusters[0]!;
  if (
    cluster.contextId !== `event-cluster:${cluster.value}` ||
    cluster.inputRef !== `cluster:${cluster.value}`
  )
    throw new Error("Multi-window Journey cluster coordinates disagree");
  const expected = fixture.clusters[name];
  return {
    clusterRef: cluster.value,
    resolution: "single-event",
    events: [
      {
        observationRefs: parsed.map((entry) => entry!.localId),
        titleSuggestion: expected.title,
        summary: expected.summary,
        actuality: "actual",
        significance: "major",
      },
    ],
  };
}
