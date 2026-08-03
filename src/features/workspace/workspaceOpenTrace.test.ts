// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_INPUT_READY_EVENT } from "@/features/editor/editorInputReady";
import {
  WORKSPACE_OPEN_TRACE_EVENT,
  WORKSPACE_OPEN_TRACE_TIMEOUT_MS,
  beginWorkspaceOpenTrace,
  getActiveWorkspaceOpenTrace,
  recordActiveWorkspaceLauncherPaint,
  resetWorkspaceOpenTraceForTests,
  type WorkspaceOpenTraceSummary,
} from "./workspaceOpenTrace";

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function dispatchEditorReady(scopeKey: string): void {
  window.dispatchEvent(
    new CustomEvent(EDITOR_INPUT_READY_EVENT, {
      detail: {
        foreground: true,
        scopeKey,
        documentId: "not-observed",
        documentKey: "not-observed",
      },
    }),
  );
}

afterEach(() => {
  resetWorkspaceOpenTraceForTests();
});

describe("workspaceOpenTrace", () => {
  it("records monotonic span offsets and durations", () => {
    const log = vi.fn();
    const trace = beginWorkspaceOpenTrace("startup-auto", {
      dev: true,
      now: sequenceClock(100, 105, 112, 120),
      createRunId: () => "run-1",
      eventTarget: window,
      log,
    });
    const span = trace.startSpan("path-validation");
    span.finish();
    trace.setTargetScopeKey("scope-1");

    dispatchEditorReady("scope-1");

    expect(trace.getSummary()).toEqual({
      version: 1,
      runId: "run-1",
      source: "startup-auto",
      result: "ready",
      totalDurationMs: 20,
      requestToInputReadyMs: 20,
      launcherFirstPaintOffsetMs: null,
      launcherIdleMs: null,
      launcherToInputReadyMs: null,
      transientLauncherVisible: false,
      spans: [
        {
          name: "path-validation",
          status: "finished",
          startOffsetMs: 5,
          durationMs: 7,
        },
      ],
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("emits only one terminal summary, event, and log", () => {
    const log = vi.fn();
    const summaries: WorkspaceOpenTraceSummary[] = [];
    window.addEventListener(
      WORKSPACE_OPEN_TRACE_EVENT,
      (event) => {
        summaries.push(
          (event as CustomEvent<WorkspaceOpenTraceSummary>).detail,
        );
      },
      { once: false },
    );
    const trace = beginWorkspaceOpenTrace("direct", {
      dev: true,
      now: sequenceClock(0, 10, 20, 30),
      createRunId: () => "run-once",
      eventTarget: window,
      log,
    });
    trace.setTargetScopeKey("scope-once");

    dispatchEditorReady("scope-once");
    dispatchEditorReady("scope-once");
    trace.fail();

    expect(summaries).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(getActiveWorkspaceOpenTrace()).toBeNull();
  });

  it("terminally closes a run superseded by a new Workspace request", () => {
    const firstLog = vi.fn();
    const first = beginWorkspaceOpenTrace("direct", {
      dev: true,
      now: sequenceClock(0, 5, 10),
      createRunId: () => "run-superseded",
      eventTarget: window,
      log: firstLog,
    });
    first.startSpan("native-ipc");

    const second = beginWorkspaceOpenTrace("folder-picker", {
      dev: true,
      now: sequenceClock(20),
      createRunId: () => "run-replacement",
      eventTarget: window,
      log: vi.fn(),
    });

    expect(first.getSummary()).toMatchObject({
      result: "failed",
      spans: [{ name: "native-ipc", status: "failed" }],
    });
    expect(firstLog).toHaveBeenCalledOnce();
    expect(getActiveWorkspaceOpenTrace()).toBe(second);
  });

  it("emits a failed terminal summary when editor readiness never arrives", () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const trace = beginWorkspaceOpenTrace("startup-auto", {
        dev: true,
        now: sequenceClock(0, 50),
        createRunId: () => "run-timeout",
        eventTarget: window,
        log,
      });
      trace.startSpan("authority-publish");

      vi.advanceTimersByTime(WORKSPACE_OPEN_TRACE_TIMEOUT_MS);

      expect(trace.getSummary()).toMatchObject({
        result: "failed",
        totalDurationMs: 50,
        spans: [{ name: "authority-publish", status: "failed" }],
      });
      expect(log).toHaveBeenCalledOnce();
      expect(getActiveWorkspaceOpenTrace()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let terminal diagnostic consumers affect Workspace behavior", () => {
    const eventTarget = new EventTarget();
    vi.spyOn(eventTarget, "dispatchEvent").mockImplementation(() => {
      throw new Error("event consumer failed");
    });
    const trace = beginWorkspaceOpenTrace("direct", {
      dev: true,
      now: sequenceClock(0, 10),
      createRunId: () => "run-diagnostic-failure",
      eventTarget,
      log: () => {
        throw new Error("logger failed");
      },
    });

    expect(() => trace.fail()).not.toThrow();
    expect(trace.getSummary()).toMatchObject({
      runId: "run-diagnostic-failure",
      result: "failed",
    });
    expect(getActiveWorkspaceOpenTrace()).toBeNull();
  });

  it("ignores editor-ready events from a different scope", () => {
    const log = vi.fn();
    const trace = beginWorkspaceOpenTrace("workspace-menu-recent", {
      dev: true,
      now: sequenceClock(0, 5),
      createRunId: () => "run-scope",
      eventTarget: window,
      log,
    });
    trace.setTargetScopeKey("target-scope");

    dispatchEditorReady("stale-scope");
    expect(trace.getSummary()).toBeNull();
    expect(log).not.toHaveBeenCalled();

    dispatchEditorReady("target-scope");
    expect(trace.getSummary()?.result).toBe("ready");
  });

  it("closes every running span as failed when the request fails", () => {
    const trace = beginWorkspaceOpenTrace("folder-picker", {
      dev: true,
      now: sequenceClock(10, 12, 18),
      createRunId: () => "run-failed",
      eventTarget: window,
      log: vi.fn(),
    });
    trace.startSpan("native-ipc");

    const summary = trace.fail();

    expect(summary?.result).toBe("failed");
    expect(summary?.spans).toEqual([
      {
        name: "native-ipc",
        status: "failed",
        startOffsetMs: 2,
        durationMs: 6,
      },
    ]);
  });

  it("serializes only allowlisted timing fields", () => {
    const privateScope =
      "/Users/author/secret-workspace:project-123:document-456:SQL params";
    const trace = beginWorkspaceOpenTrace("trust-confirmed", {
      dev: true,
      now: sequenceClock(0, 1, 2, 3, 4, 5),
      createRunId: () => "safe-run-id",
      eventTarget: window,
      log: vi.fn(),
    });
    const safeParticipant = trace.startSpan("project-critical", "tree");
    safeParticipant.finish();
    const rejectedParticipant = trace.startSpan(
      "project-optional",
      privateScope,
    );
    rejectedParticipant.finish();
    const rejectedEntityId = trace.startSpan("project-optional", "project-123");
    rejectedEntityId.finish();
    trace.setTargetScopeKey(privateScope);

    dispatchEditorReady(privateScope);

    const summary = trace.getSummary();
    expect(Object.keys(summary ?? {})).toEqual([
      "version",
      "runId",
      "source",
      "result",
      "totalDurationMs",
      "requestToInputReadyMs",
      "launcherFirstPaintOffsetMs",
      "launcherIdleMs",
      "launcherToInputReadyMs",
      "transientLauncherVisible",
      "spans",
    ]);
    const serialized = JSON.stringify(summary);
    expect(summary?.spans[0]).toMatchObject({ participantId: "tree" });
    expect(summary?.spans[1]).not.toHaveProperty("participantId");
    expect(summary?.spans[2]).not.toHaveProperty("participantId");
    expect(serialized).not.toContain(privateScope);
    expect(serialized).not.toContain("project-123");
    expect(serialized).not.toMatch(
      /workspacePath|projectId|documentId|error|sql/i,
    );
  });

  it("is a no-op outside development", () => {
    const log = vi.fn();
    const trace = beginWorkspaceOpenTrace("startup-auto", {
      dev: false,
      now: vi.fn(() => 1),
      createRunId: vi.fn(() => "must-not-run"),
      eventTarget: window,
      log,
    });

    trace.startSpan("runtime-composition").finish();
    trace.setTargetScopeKey("scope");
    trace.recordLauncherFirstPaint();
    dispatchEditorReady("scope");

    expect(trace.enabled).toBe(false);
    expect(trace.getSummary()).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(getActiveWorkspaceOpenTrace()).toBeNull();
  });

  it("links a transient launcher paint to startup auto-open", () => {
    const trace = beginWorkspaceOpenTrace("startup-auto", {
      dev: true,
      now: sequenceClock(100, 115, 150),
      createRunId: () => "run-transient-launcher",
      eventTarget: window,
      log: vi.fn(),
    });
    trace.setTargetScopeKey("scope-transient");

    recordActiveWorkspaceLauncherPaint();
    dispatchEditorReady("scope-transient");

    expect(trace.getSummary()).toMatchObject({
      launcherFirstPaintOffsetMs: 15,
      launcherIdleMs: null,
      launcherToInputReadyMs: 35,
      transientLauncherVisible: true,
    });
  });

  it("keeps the previous launcher paint for launcher-card timing", () => {
    recordActiveWorkspaceLauncherPaint(() => 80);
    const trace = beginWorkspaceOpenTrace("launcher-card", {
      dev: true,
      now: sequenceClock(100, 140),
      createRunId: () => "run-launcher-card",
      eventTarget: window,
      log: vi.fn(),
    });
    trace.setTargetScopeKey("scope-launcher-card");

    dispatchEditorReady("scope-launcher-card");

    expect(trace.getSummary()).toMatchObject({
      requestToInputReadyMs: 40,
      launcherFirstPaintOffsetMs: -20,
      launcherIdleMs: 20,
      launcherToInputReadyMs: 60,
      transientLauncherVisible: false,
    });
  });
});
