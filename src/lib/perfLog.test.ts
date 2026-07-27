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

  takeRecords(): PerformanceEntryList {
    const records = this.records;
    this.records = [];
    return records as unknown as PerformanceEntryList;
  }
}

afterEach(() => {
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
    longtask?.records.push({
      entryType: "longtask",
      startTime: 10,
      duration: 60,
    });
    event?.records.push({
      entryType: "event",
      startTime: 20,
      duration: 24,
    });

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
});
