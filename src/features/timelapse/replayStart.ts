import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { ReplayEvent } from "./replayEngine";
import type { DecodedSnapshot } from "./snapshots";

export interface ReplayStart<E extends ReplayEvent = ReplayEvent> {
  initialDoc: ProseMirrorNode;
  replayEvents: E[];
}

/**
 * Decide the replay starting point (P7.7 / §4.5).
 */
export function buildReplayStart<E extends ReplayEvent>(
  schema: Schema,
  events: E[],
  snapshot: Pick<DecodedSnapshot, "payload" | "anchorSequence"> | null,
): ReplayStart<E> {
  if (snapshot) {
    const initialDoc = ProseMirrorNode.fromJSON(
      schema,
      snapshot.payload as never,
    );
    const replayEvents = events.filter(
      (e) => e.sequence > snapshot.anchorSequence,
    );
    return { initialDoc, replayEvents };
  }
  const empty = schema.topNodeType.createAndFill();
  if (!empty) {
    throw new Error("timelapse: could not build an initial document");
  }
  return { initialDoc: empty, replayEvents: events };
}
