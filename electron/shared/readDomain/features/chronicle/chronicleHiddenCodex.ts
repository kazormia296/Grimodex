import type { EventRow, ParticipantRow } from "./eventRows.js";

type ChronicleCodexIdsInput = {
  events: readonly Pick<EventRow, "primaryCodexId" | "locationCodexId">[];
  participants: readonly Pick<ParticipantRow, "codexEntryId">[];
  codexNames: ReadonlyMap<string, unknown>;
  sceneCodexIds?: readonly (string | null | undefined)[];
  mentionedCodexIds?: readonly (string | null | undefined)[];
};

type ChronicleHiddenCodexInput = {
  events: EventRow[];
  participants: ParticipantRow[];
  codexNames: Map<string, string>;
  sceneCodexIds?: string[];
  mentionedCodexIds?: string[];
};

export function collectChronicleCandidateCodexIds(
  args: ChronicleCodexIdsInput,
): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id) ids.add(id);
  };

  for (const event of args.events) {
    add(event.primaryCodexId);
    add(event.locationCodexId);
  }
  for (const participant of args.participants) add(participant.codexEntryId);
  for (const id of args.codexNames.keys()) add(id);
  for (const id of args.sceneCodexIds ?? []) add(id);
  for (const id of args.mentionedCodexIds ?? []) add(id);

  return [...ids].sort();
}

export function dropHiddenCodexFromChronicleInput<
  T extends ChronicleHiddenCodexInput,
>(args: T, hidden: ReadonlySet<string>): T {
  return {
    ...args,
    events: args.events.map((event) =>
      event.primaryCodexId && hidden.has(event.primaryCodexId)
        ? { ...event, primaryCodexId: null }
        : event,
    ),
    participants: args.participants.filter(
      (participant) => !hidden.has(participant.codexEntryId),
    ),
    codexNames: new Map([...args.codexNames].filter(([id]) => !hidden.has(id))),
    sceneCodexIds: args.sceneCodexIds?.filter((id) => !hidden.has(id)),
    mentionedCodexIds: args.mentionedCodexIds?.filter((id) => !hidden.has(id)),
  };
}
