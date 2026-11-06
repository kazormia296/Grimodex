// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUnsavedEditsReporter,
  onUnsavedEditsRetained,
} from "./unsavedEditsGuard";

function installBridge(bridge: unknown) {
  Object.defineProperty(window, "grimodex", {
    configurable: true,
    value: bridge,
  });
}

describe("unsaved edits guard (renderer)", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "grimodex");
  });

  it("reports only when the flag flips", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    installBridge({ invoke, listen: vi.fn() });
    const report = createUnsavedEditsReporter();

    report(false);
    report(true);
    report(true);
    report(false);

    expect(invoke.mock.calls).toEqual([
      ["report_unsaved_edits", { hasUnsaved: true }],
      ["report_unsaved_edits", { hasUnsaved: false }],
    ]);
  });

  it("retries the same value after a failed report", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "x" })
      .mockResolvedValue({ ok: true, value: null });
    installBridge({ invoke, listen: vi.fn() });
    const report = createUnsavedEditsReporter();

    report(true);
    await Promise.resolve();
    await Promise.resolve();
    report(true);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does nothing outside Electron", () => {
    const report = createUnsavedEditsReporter();
    expect(() => report(true)).not.toThrow();
    const unlisten = onUnsavedEditsRetained(() => undefined);
    expect(() => unlisten()).not.toThrow();
  });

  it("subscribes to the retained event", () => {
    const unlisten = vi.fn();
    const listen = vi.fn((_channel: string, cb: (payload: unknown) => void) => {
      cb({ kind: "unsaved-edits-retained" });
      return unlisten;
    });
    installBridge({ invoke: vi.fn(), listen });
    const handler = vi.fn();

    const off = onUnsavedEditsRetained(handler);

    expect(listen).toHaveBeenCalledWith(
      "app:unsaved-edits-retained",
      expect.any(Function),
    );
    expect(handler).toHaveBeenCalledOnce();
    off();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
