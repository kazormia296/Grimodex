import { describe, expect, it } from "vitest";

import {
  createTurnControl,
  createTurnCoordinator,
  createTurnRequest,
} from "./turnCoordinator";

function request(
  overrides: Partial<Parameters<typeof createTurnRequest>[0]> = {},
) {
  return createTurnRequest({
    requestId: "turn-1",
    workspace: { path: "/workspace-a", openRevision: 3 },
    projectId: "project-a",
    sceneId: "scene-a",
    sessionId: "session-a",
    scope: "scene",
    scopeAnchorId: null,
    routeAuthorityKey: "route-a",
    ...overrides,
  });
}

function control(turnRequest = request()) {
  return createTurnControl({
    request: turnRequest,
    surface: "chat",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    transport: "http",
  });
}

describe("turn coordinator", () => {
  it("freezes the captured workspace and turn identity", () => {
    const source = { path: "/workspace-a", openRevision: 3 };
    const turnRequest = request({ workspace: source });

    source.path = "/workspace-b";
    source.openRevision = 4;

    expect(turnRequest.workspace).toEqual({
      path: "/workspace-a",
      openRevision: 3,
    });
    expect(Object.isFrozen(turnRequest)).toBe(true);
    expect(Object.isFrozen(turnRequest.workspace)).toBe(true);
  });

  it("enforces the preparing -> transport -> persistence lifecycle", () => {
    const coordinator = createTurnCoordinator();
    const turn = control();

    expect(coordinator.claim(turn)).toBe(true);
    expect(turn.phase).toBe("preparing");
    expect(coordinator.transition(turn, "streaming")).toBe(true);
    expect(coordinator.transition(turn, "persisting")).toBe(true);
    expect(coordinator.transition(turn, "completed")).toBe(true);
    expect(coordinator.release(turn)).toBe(true);
    expect(coordinator.current()).toBeNull();
  });

  it("does not let a stale turn replace or mutate the active turn", () => {
    const coordinator = createTurnCoordinator();
    const first = control();
    const second = control(request({ requestId: "turn-2" }));

    expect(coordinator.claim(first)).toBe(true);
    expect(coordinator.claim(second)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(false);
    expect(coordinator.transition(second, "streaming")).toBe(false);
    expect(coordinator.current()).toBe(first);
  });

  it("marks an active turn aborted before releasing its slot", () => {
    const coordinator = createTurnCoordinator();
    const turn = control();

    coordinator.claim(turn);
    coordinator.transition(turn, "streaming");
    expect(coordinator.abort(turn)).toBe(true);
    expect(turn.aborted).toBe(true);
    expect(turn.phase).toBe("aborted");
    expect(coordinator.isCurrent(turn)).toBe(true);
    expect(coordinator.release(turn)).toBe(true);
    expect(coordinator.current()).toBeNull();
  });
});
