import { describe, expect, it } from "vitest";

import { mapCodexNotification } from "./eventMapper.js";

const context = {
  projectId: "project-1",
  sessionId: "session-1",
  grimodexTurnId: "grimodex-turn-1",
};

describe("mapCodexNotification", () => {
  it("maps an authoritative failed completion to a terminal turn error", () => {
    expect(
      mapCodexNotification(
        "turn/completed",
        {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "model execution failed", code: "turn_failed" },
            items: [],
          },
        },
        context,
      ),
    ).toEqual({
      ...context,
      codexTurnId: "turn-1",
      event: {
        type: "turn-error",
        message: "model execution failed",
        code: "turn_failed",
        retryable: false,
      },
    });
  });

  it("keeps a successful completion as a completion event", () => {
    expect(
      mapCodexNotification(
        "turn/completed",
        {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
        context,
      ),
    ).toMatchObject({
      codexTurnId: "turn-1",
      event: { type: "turn-completed", stopReason: "completed" },
    });
  });
});
