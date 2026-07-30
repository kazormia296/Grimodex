// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIFECYCLE_TRACE_OPT_IN_KEY,
  LIFECYCLE_TRACE_EVENT_NAME,
  activateLifecycleTransition,
  advanceActiveLifecycleTransition,
  beginLifecycleTransition,
  subscribeLifecycleTrace,
  type LifecycleTraceEvent,
} from "./lifecycleTrace";

describe("lifecycleTrace", () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      [LIFECYCLE_TRACE_OPT_IN_KEY]: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, LIFECYCLE_TRACE_OPT_IN_KEY);
  });

  it("publishes one structured, ordered event stream per transition", () => {
    const subscribed: LifecycleTraceEvent[] = [];
    const dispatched: LifecycleTraceEvent[] = [];
    const unsubscribe = subscribeLifecycleTrace((event) => {
      subscribed.push(event);
    });
    const onWindowEvent = vi.fn((event: Event) => {
      dispatched.push((event as CustomEvent<LifecycleTraceEvent>).detail);
    });
    window.addEventListener(LIFECYCLE_TRACE_EVENT_NAME, onWindowEvent);

    try {
      const transition = beginLifecycleTransition({
        kind: "project",
        from: {
          workspacePath: "/novel",
          workspaceOpenRevision: 3,
          projectId: "project-a",
        },
        to: {
          workspacePath: "/novel",
          workspaceOpenRevision: 3,
          projectId: "project-b",
        },
      });

      expect(transition.advance("quiescence-started")).toBe(true);
      expect(transition.advance("old-stream-completed")).toBe(true);
      expect(transition.advance("old-scope-persisted")).toBe(true);
      expect(transition.advance("authority-commit")).toBe(true);
      expect(transition.advance("new-scope-hydrated")).toBe(true);

      expect(subscribed.map((event) => event.phase)).toEqual([
        "switch-requested",
        "quiescence-started",
        "old-stream-completed",
        "old-scope-persisted",
        "authority-commit",
        "new-scope-hydrated",
      ]);
      expect(subscribed.map((event) => event.sequence)).toEqual([
        0, 1, 2, 3, 4, 5,
      ]);
      expect(new Set(subscribed.map((event) => event.transitionId))).toEqual(
        new Set([transition.transitionId]),
      );
      expect(subscribed.every((event) => event.schemaVersion === 1)).toBe(true);
      expect(subscribed[0]).toMatchObject({
        kind: "project",
        from: { projectId: "project-a" },
        to: { projectId: "project-b" },
      });
      expect(dispatched).toEqual(subscribed);
      expect(Object.isFrozen(subscribed[0])).toBe(true);
      expect(Object.isFrozen(subscribed[0]?.from)).toBe(true);
      expect(Object.isFrozen(subscribed[0]?.to)).toBe(true);
    } finally {
      unsubscribe();
      window.removeEventListener(LIFECYCLE_TRACE_EVENT_NAME, onWindowEvent);
    }
  });

  it("suppresses duplicate milestones without hiding the observed order", () => {
    const events: LifecycleTraceEvent[] = [];
    const unsubscribe = subscribeLifecycleTrace((event) => events.push(event));

    try {
      const transition = beginLifecycleTransition({
        kind: "workspace",
        from: {
          workspacePath: "/old",
          workspaceOpenRevision: 7,
          projectId: "old-project",
        },
        to: {
          workspacePath: "/new",
          workspaceOpenRevision: null,
          projectId: null,
        },
      });

      expect(transition.advance("old-stream-completed")).toBe(true);
      expect(transition.advance("quiescence-started")).toBe(true);
      expect(transition.advance("old-stream-completed")).toBe(false);
      expect(events.map((event) => event.phase)).toEqual([
        "switch-requested",
        "old-stream-completed",
        "quiescence-started",
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("uses the target scope snapshot current at each milestone", () => {
    const events: LifecycleTraceEvent[] = [];
    const unsubscribe = subscribeLifecycleTrace((event) => events.push(event));

    try {
      const transition = beginLifecycleTransition({
        kind: "workspace",
        from: {
          workspacePath: "/old",
          workspaceOpenRevision: 2,
          projectId: "project-a",
        },
        to: {
          workspacePath: "/new",
          workspaceOpenRevision: null,
          projectId: null,
        },
      });
      transition.advance("quiescence-started");
      transition.advance("old-stream-completed");
      transition.advance("old-scope-persisted");
      transition.updateTarget({
        workspaceOpenRevision: 3,
        projectId: "project-b",
      });
      transition.advance("authority-commit");
      transition.advance("new-scope-hydrated");

      expect(events[3]?.to).toEqual({
        workspacePath: "/new",
        workspaceOpenRevision: null,
        projectId: null,
      });
      expect(events[4]?.to).toEqual({
        workspacePath: "/new",
        workspaceOpenRevision: 3,
        projectId: "project-b",
      });
      expect(events[5]?.to).toEqual(events[4]?.to);
    } finally {
      unsubscribe();
    }
  });

  it("routes asynchronous chat milestones to the active quiescence transition", () => {
    const events: LifecycleTraceEvent[] = [];
    const unsubscribe = subscribeLifecycleTrace((event) => events.push(event));
    const transition = beginLifecycleTransition({
      kind: "workspace",
      from: {
        workspacePath: "/old",
        workspaceOpenRevision: 2,
        projectId: "project-a",
      },
      to: {
        workspacePath: "/new",
        workspaceOpenRevision: null,
        projectId: null,
      },
    });
    const deactivate = activateLifecycleTransition(transition);

    try {
      transition.advance("quiescence-started");
      expect(advanceActiveLifecycleTransition("old-stream-completed")).toBe(
        true,
      );
      expect(advanceActiveLifecycleTransition("old-scope-persisted")).toBe(
        true,
      );
      deactivate();
      expect(advanceActiveLifecycleTransition("old-stream-completed")).toBe(
        false,
      );

      expect(events.map((event) => event.phase)).toEqual([
        "switch-requested",
        "quiescence-started",
        "old-stream-completed",
        "old-scope-persisted",
      ]);
      expect(new Set(events.map((event) => event.transitionId))).toEqual(
        new Set([transition.transitionId]),
      );
    } finally {
      deactivate();
      unsubscribe();
    }
  });

  it("does not let nested activation move an older lease above a newer transition", () => {
    const events: LifecycleTraceEvent[] = [];
    const unsubscribe = subscribeLifecycleTrace((event) => events.push(event));
    const older = beginLifecycleTransition({
      kind: "project",
      from: {
        workspacePath: "/novel",
        workspaceOpenRevision: 2,
        projectId: "project-a",
      },
      to: {
        workspacePath: "/novel",
        workspaceOpenRevision: 2,
        projectId: "project-b",
      },
    });
    const newer = beginLifecycleTransition({
      kind: "project",
      from: {
        workspacePath: "/novel",
        workspaceOpenRevision: 2,
        projectId: "project-a",
      },
      to: {
        workspacePath: "/novel",
        workspaceOpenRevision: 2,
        projectId: "project-c",
      },
    });
    const deactivateOlder = activateLifecycleTransition(older);
    const deactivateNewer = activateLifecycleTransition(newer);
    const deactivateNestedOlder = activateLifecycleTransition(older);

    try {
      expect(advanceActiveLifecycleTransition("old-stream-completed")).toBe(
        true,
      );
      expect(
        events.find((event) => event.phase === "old-stream-completed")
          ?.transitionId,
      ).toBe(newer.transitionId);

      deactivateNestedOlder();
      deactivateNewer();
      expect(advanceActiveLifecycleTransition("old-scope-persisted")).toBe(
        true,
      );
      expect(
        events.find((event) => event.phase === "old-scope-persisted")
          ?.transitionId,
      ).toBe(older.transitionId);
    } finally {
      deactivateNestedOlder();
      deactivateNewer();
      deactivateOlder();
      unsubscribe();
    }
  });

  it("does not publish unless a product journey explicitly opts in", () => {
    Reflect.deleteProperty(globalThis, LIFECYCLE_TRACE_OPT_IN_KEY);
    const listener = vi.fn();
    const unsubscribe = subscribeLifecycleTrace(listener);
    const windowListener = vi.fn();
    window.addEventListener(LIFECYCLE_TRACE_EVENT_NAME, windowListener);

    try {
      const transition = beginLifecycleTransition({
        kind: "project",
        from: {
          workspacePath: "/novel",
          workspaceOpenRevision: 1,
          projectId: "project-a",
        },
        to: {
          workspacePath: "/novel",
          workspaceOpenRevision: 1,
          projectId: "project-b",
        },
      });
      transition.advance("quiescence-started");

      expect(listener).not.toHaveBeenCalled();
      expect(windowListener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      window.removeEventListener(LIFECYCLE_TRACE_EVENT_NAME, windowListener);
    }
  });
});
