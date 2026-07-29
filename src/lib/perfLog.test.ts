import { afterEach, describe, expect, it, vi } from "vitest";

type ObserverRecord = {
  entryType: string;
  startTime: number;
  duration: number;
};

class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];

  records: ObserverRecord[] = [];
  observedType = "";

  constructor(
    readonly callback: (
      list: Pick<PerformanceObserverEntryList, "getEntries">,
    ) => void,
  ) {
    FakePerformanceObserver.instances.push(this);
  }

  observe(options: PerformanceObserverInit): void {
    this.observedType =
      "type" in options && typeof options.type === "string"
        ? options.type
        : (options.entryTypes?.[0] ?? "");
  }

  disconnect(): void {}

  deliver(): void {
    const records = this.records;
    this.records = [];
    this.callback({
      getEntries: () => records as unknown as PerformanceEntryList,
    });
  }

  takeRecords(): PerformanceEntryList {
    const records = this.records;
    this.records = [];
    return records as unknown as PerformanceEntryList;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  FakePerformanceObserver.instances = [];
});

describe("performance sessions", () => {
  it("flushes queued longtask and event records before disconnecting", async () => {
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const { startPerfSession, endPerfSession } = await import("./perfLog");

    startPerfSession();
    const longtask = FakePerformanceObserver.instances.find(
      (observer) => observer.observedType === "longtask",
    );
    const event = FakePerformanceObserver.instances.find(
      (observer) => observer.observedType === "event",
    );
    expect(longtask).toBeDefined();
    expect(event).toBeDefined();
    const inSessionStart = performance.now() + 1;
    longtask?.records.push({
      entryType: "longtask",
      startTime: inSessionStart,
      duration: 60,
    });
    event?.records.push({
      entryType: "event",
      startTime: inSessionStart,
      duration: 24,
    });

    const result = endPerfSession();

    expect(result?.longtask).toEqual({ count: 1, totalMs: 60, maxMs: 60 });
    expect(result?.slowEvent).toEqual({ count: 1, p95Ms: 24, maxMs: 24 });
  });

  it("does not attribute asynchronously delivered pre-session records to the active interaction", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const { startPerfSession, endPerfSession } = await import("./perfLog");

    startPerfSession();
    const longtask = FakePerformanceObserver.instances.find(
      (observer) => observer.observedType === "longtask",
    );
    const event = FakePerformanceObserver.instances.find(
      (observer) => observer.observedType === "event",
    );
    longtask?.records.push(
      {
        entryType: "longtask",
        startTime: 99,
        duration: 3_478,
      },
      {
        entryType: "longtask",
        startTime: 101,
        duration: 60,
      },
    );
    event?.records.push(
      {
        entryType: "event",
        startTime: 99,
        duration: 3_496,
      },
      {
        entryType: "event",
        startTime: 101,
        duration: 24,
      },
    );
    longtask?.deliver();
    event?.deliver();
    now = 200;

    const result = endPerfSession();

    expect(result?.longtask).toEqual({ count: 1, totalMs: 60, maxMs: 60 });
    expect(result?.slowEvent).toEqual({ count: 1, p95Ms: 24, maxMs: 24 });
  });

  it("records discrete counters without manufacturing marks", async () => {
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const { startPerfSession, endPerfSession, recordCounter } =
      await import("./perfLog");

    startPerfSession();
    recordCounter("ipc.save_scene_body_bundle");
    recordCounter("db.transaction", 2);

    expect(endPerfSession()?.counters).toEqual({
      "ipc.save_scene_body_bundle": 1,
      "db.transaction": 2,
    });
  });

  it("snapshots marks without ending the active session", async () => {
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const {
      startPerfSession,
      snapshotPerfSession,
      endPerfSession,
      recordCounter,
    } = await import("./perfLog");

    startPerfSession();
    recordCounter("before");
    expect(snapshotPerfSession()?.counters).toEqual({ before: 1 });

    recordCounter("after");
    expect(endPerfSession()?.counters).toEqual({ before: 1, after: 1 });
    expect(snapshotPerfSession()).toBeNull();
  });

  it("records maxima and synchronous frame work without timing when idle", async () => {
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const encode = vi.fn((value: string) => new Uint8Array(value.length));
    vi.stubGlobal(
      "TextEncoder",
      class {
        encode(value: string): Uint8Array {
          return encode(value);
        }
      },
    );
    const {
      startPerfSession,
      endPerfSession,
      recordMaxCounter,
      recordSerializedByteCounter,
      measurePerfSync,
      recordAnimationFrameInterval,
    } = await import("./perfLog");

    const idleWork = vi.fn(() => "idle");
    expect(measurePerfSync("timeline.pointerFrame", idleWork)).toBe("idle");
    recordAnimationFrameInterval("timeline.pointerFrame.interval", 0);
    recordSerializedByteCounter("editor.coreSave.serializedBytes", "idle");
    expect(encode).not.toHaveBeenCalled();

    startPerfSession();
    recordMaxCounter("linear.activeDetection.maxVisibleRects", 4);
    recordMaxCounter("linear.activeDetection.maxVisibleRects", 2);
    recordMaxCounter("linear.activeDetection.maxVisibleRects", 7);
    const measuredWork = vi.fn(() => "measured");
    expect(measurePerfSync("timeline.pointerFrame", measuredWork)).toBe(
      "measured",
    );
    recordAnimationFrameInterval("timeline.pointerFrame.interval", 0);
    recordAnimationFrameInterval("timeline.pointerFrame.interval", 16);
    recordAnimationFrameInterval("timeline.pointerFrame.interval", 36);
    recordSerializedByteCounter("editor.coreSave.serializedBytes", "measured");
    const result = endPerfSession();

    expect(result?.counters).toMatchObject({
      "linear.activeDetection.maxVisibleRects": 7,
      "timeline.pointerFrame.count": 1,
      "timeline.pointerFrame.interval.count": 2,
      "editor.coreSave.serializedBytes": 8,
    });
    expect(
      result?.markStats.find((entry) => entry.label === "timeline.pointerFrame")
        ?.count,
    ).toBe(1);
    expect(
      result?.markStats.find(
        (entry) => entry.label === "timeline.pointerFrame.interval",
      ),
    ).toMatchObject({ count: 2, maxMs: 20 });
    expect(idleWork).toHaveBeenCalledOnce();
    expect(measuredWork).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledOnce();
  });

  it("counts serialized payloads as UTF-8 bytes", async () => {
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const { startPerfSession, endPerfSession, recordSerializedByteCounter } =
      await import("./perfLog");

    startPerfSession();
    recordSerializedByteCounter("editor.coreSave.serializedBytes", "日本語");

    expect(endPerfSession()?.counters["editor.coreSave.serializedBytes"]).toBe(
      9,
    );
  });

  it("runtime controls stay unavailable without a preload benchmark capability", async () => {
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const {
      startPerfSession,
      endPerfSession,
      registerRuntimePerformanceControl,
      invokeRuntimePerformanceControl,
      hasRuntimePerformanceCapability,
    } = await import("./perfLog");
    const control = vi.fn((payload: unknown) => ({ payload }));
    const unregister = registerRuntimePerformanceControl(
      "chat.streamingDraft",
      control,
    );

    expect(hasRuntimePerformanceCapability()).toBe(false);
    startPerfSession();
    expect(() =>
      invokeRuntimePerformanceControl(
        "benchmark-owner-token",
        "chat.streamingDraft",
        {
          action: "delta",
        },
      ),
    ).toThrow(/unavailable/);
    expect(control).not.toHaveBeenCalled();
    expect(endPerfSession()).not.toBeNull();
    unregister();
  });

  it("runtime controls are owner-token guarded, allowlisted, session-only, and unregisterable", async () => {
    const ownerToken = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal("window", {
      grimodex: {
        runtimePerformance: { ownerToken },
      },
    });
    vi.stubGlobal(
      "PerformanceObserver",
      FakePerformanceObserver as unknown as typeof PerformanceObserver,
    );
    const {
      startPerfSession,
      endPerfSession,
      registerRuntimePerformanceControl,
      invokeRuntimePerformanceControl,
      hasRuntimePerformanceCapability,
    } = await import("./perfLog");
    const control = vi.fn((payload: unknown) => ({ payload }));
    const unregister = registerRuntimePerformanceControl(
      "chat.streamingDraft",
      control,
    );

    expect(hasRuntimePerformanceCapability()).toBe(true);
    expect(() =>
      invokeRuntimePerformanceControl(ownerToken, "chat.streamingDraft", {
        action: "delta",
      }),
    ).toThrow(/requires an active session/);
    startPerfSession();
    expect(() =>
      invokeRuntimePerformanceControl(
        "22222222-2222-4222-8222-222222222222",
        "chat.streamingDraft",
        { action: "delta" },
      ),
    ).toThrow(/owner token/);
    endPerfSession();
    expect(() =>
      registerRuntimePerformanceControl(
        "not-allowlisted" as "chat.streamingDraft",
        control,
      ),
    ).toThrow(/not allowed/);

    startPerfSession();
    expect(
      invokeRuntimePerformanceControl(ownerToken, "chat.streamingDraft", {
        action: "delta",
      }),
    ).toEqual({ payload: { action: "delta" } });
    expect(control).toHaveBeenCalledOnce();
    endPerfSession();

    const replacement = vi.fn(() => "replacement");
    const unregisterReplacement = registerRuntimePerformanceControl(
      "chat.streamingDraft",
      replacement,
    );
    unregister();
    startPerfSession();
    expect(
      invokeRuntimePerformanceControl(ownerToken, "chat.streamingDraft", {
        action: "delta",
      }),
    ).toBe("replacement");
    expect(replacement).toHaveBeenCalledOnce();
    endPerfSession();

    unregisterReplacement();
    startPerfSession();
    expect(() =>
      invokeRuntimePerformanceControl(ownerToken, "chat.streamingDraft", {
        action: "delta",
      }),
    ).toThrow(/not registered/);
    endPerfSession();
  });
});
