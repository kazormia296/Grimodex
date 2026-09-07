import fixture from "../shared/productJourneyChronicleFixture.json" with { type: "json" };

type JsonObject = Record<string, unknown>;
type ContextSection = { contextId: string; inputRef: string; value: string };
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Chronicle Journey expected an object");
  }
  return value as JsonObject;
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value))
    throw new Error("Chronicle Journey expected text content");
  return value
    .map((block) => {
      const row = object(block);
      if (row.type !== "text" || typeof row.content !== "string") {
        throw new Error("Chronicle Journey only accepts text request blocks");
      }
      return row.content;
    })
    .join("\n");
}
function contextSections(args: JsonObject): ContextSection[] {
  if (!Array.isArray(args.messages))
    throw new Error("Chronicle Journey missing messages");
  const texts = args.messages.map((message) =>
    textContent(object(message).content),
  );
  const requests = texts.filter((text) =>
    text.includes("# Context Set (chronicle.prompt/1)\n"),
  );
  if (requests.length !== 1)
    throw new Error("Chronicle Journey needs one current Context Set");
  const prompt = requests[0]!;
  const start = prompt.indexOf("# Context Set (chronicle.prompt/1)\n");
  const end = prompt.indexOf("\n# Output (JSON only)", start);
  if (end < start)
    throw new Error("Chronicle Journey missing context terminator");
  const context = prompt.slice(
    start + "# Context Set (chronicle.prompt/1)\n".length,
    end,
  );
  const headers = [
    ...context.matchAll(/^--- contextId=(\S+) inputRef=(\S+) ---\n/gmu),
  ];
  const sections = headers.map((match, index) => ({
    contextId: match[1]!,
    inputRef: match[2]!,
    value: context
      .slice(
        match.index! + match[0].length,
        headers[index + 1]?.index ?? context.length,
      )
      .trim(),
  }));
  if (
    !sections.length ||
    new Set(sections.map((row) => row.contextId)).size !== sections.length
  ) {
    throw new Error("Chronicle Journey requires distinct context sections");
  }
  return sections;
}
function observationReply(sections: ContextSection[]): JsonObject {
  const windows = sections.filter((row) =>
    row.contextId.startsWith("observation-citation-window:"),
  );
  if (windows.length !== sections.length)
    throw new Error("Chronicle Journey requires citation-ID mode");
  const segments = windows.flatMap((window) =>
    window.value
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => object(JSON.parse(line))),
  );
  // Only request-scoped evidenceRef values are dynamic. Semantic values below are fixture constants.
  const observations = fixture.rows.map((row) => {
    const matches = segments.filter(
      (segment) =>
        typeof segment.text === "string" && segment.text.includes(row.text),
    );
    if (matches.length !== 1 || typeof matches[0]!.evidenceRef !== "string") {
      throw new Error(
        `Chronicle Journey evidence segment unavailable or ambiguous: ${row.key}`,
      );
    }
    return {
      localId: row.key,
      evidenceRefs: [matches[0]!.evidenceRef],
      assertion: {
        attribution: "narrator",
        narrativeFrame: row.narrativeFrame,
      },
      payload: {
        predicate: row.predicate,
        actuality: row.actuality,
        participants: [],
        temporalExpressions: [],
        durationKind: "instant",
      },
    };
  });
  return { observations };
}
function synthesisReply(sections: ContextSection[]): JsonObject {
  const clusters = sections.filter((row) =>
    row.contextId.startsWith("event-cluster:"),
  );
  const observations = sections.filter((row) =>
    row.contextId.startsWith("event-observation:"),
  );
  if (
    clusters.length !== 1 ||
    clusters.length + observations.length !== sections.length
  ) {
    throw new Error("Chronicle Journey requires one exact synthesis cluster");
  }
  const cluster = clusters[0]!;
  if (
    cluster.inputRef !== `cluster:${cluster.value}` ||
    cluster.contextId !== `event-cluster:${cluster.value}`
  ) {
    throw new Error("Chronicle Journey cluster coordinates disagree");
  }
  const seenKeys = new Set<string>();
  const events = observations.map((section) => {
    const match =
      /^- localId=([^;]+); actuality=([^;]+); predicate=([^;]+); evidence=/u.exec(
        section.value,
      );
    if (
      !match ||
      section.contextId !== `event-observation:${match[1]}` ||
      section.inputRef !== `observation:${match[1]}`
    ) {
      throw new Error("Chronicle Journey Observation coordinates disagree");
    }
    const rows = fixture.rows.filter(
      (row) => row.actuality === match[2] && row.predicate === match[3],
    );
    if (rows.length !== 1 || seenKeys.has(rows[0]!.key))
      throw new Error("Chronicle Journey unexpected synthesis roster");
    const row = rows[0]!;
    seenKeys.add(row.key);
    return {
      observationRefs: [match[1]],
      titleSuggestion: row.title,
      summary: row.summary,
      actuality: "actual",
      significance: "major",
    };
  });
  const mixed = seenKeys.has("mixed-actual");
  const expected = fixture.rows.filter((row) =>
    mixed ? row.key.startsWith("mixed-") : row.key === "independent-actual",
  );
  if (
    events.length !== expected.length ||
    expected.some((row) => !seenKeys.has(row.key))
  ) {
    throw new Error("Chronicle Journey synthesis cluster membership changed");
  }
  return {
    clusterRef: cluster.value,
    resolution: mixed ? "multiple-events" : "single-event",
    events,
  };
}
export function productJourneyChronicleResponse(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const args = value as JsonObject;
  const audit = args.auditContext;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return null;
  const pathId = (audit as JsonObject).pathId;
  if (
    pathId !== "narrative_observation_extract" &&
    pathId !== "narrative_event_synthesize"
  ) {
    if (pathId === "narrative_structured_repair")
      throw new Error("Chronicle Journey unexpectedly entered repair");
    return null;
  }
  const sections = contextSections(args);
  return JSON.stringify(
    pathId === "narrative_observation_extract"
      ? observationReply(sections)
      : synthesisReply(sections),
  );
}
