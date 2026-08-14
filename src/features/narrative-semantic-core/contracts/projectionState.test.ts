import { describe, expect, it } from "vitest";

import {
  groupProjectionStatesByRevision,
  isNarrativeProjectionState,
  type NarrativeProjectionState,
} from "./projectionState";

describe("narrative projection state", () => {
  it("allows independent projection state for one immutable revision", () => {
    const states: NarrativeProjectionState[] = [
      {
        revisionId: "revision-1",
        projectionRef: "codex-relation:1",
        projectionKind: "codex-relation",
        applicationId: "application-1",
        state: "applied",
      },
      {
        revisionId: "revision-1",
        projectionRef: "chronicle-event:1",
        projectionKind: "chronicle-event",
        applicationId: null,
        state: "unapplied",
      },
      {
        revisionId: "revision-1",
        projectionRef: "semantic-index:1",
        projectionKind: "semantic-index",
        applicationId: "application-2",
        state: "stale",
      },
      {
        revisionId: "revision-1",
        projectionRef: "chat-index:1",
        projectionKind: "chat-index",
        applicationId: "application-3",
        state: "compensated",
      },
    ];

    expect(states.every(isNarrativeProjectionState)).toBe(true);
    expect(groupProjectionStatesByRevision(states).get("revision-1")).toHaveLength(
      4,
    );
  });
});
