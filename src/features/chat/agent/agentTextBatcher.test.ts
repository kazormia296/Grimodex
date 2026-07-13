import { describe, expect, it, vi } from "vitest";
import { createAgentTextBatcher } from "./agentTextBatcher";

describe("createAgentTextBatcher", () => {
  it("publishes multiple agent responses in one scheduled frame", () => {
    let scheduled: (() => void) | undefined;
    const publish = vi.fn();
    const batcher = createAgentTextBatcher(publish, (callback) => {
      scheduled = callback;
      return 1;
    });

    batcher.push("first");
    batcher.push("second");

    expect(publish).not.toHaveBeenCalled();
    scheduled?.();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("first\n\nsecond");
  });

  it("flushes synchronously and does not drop the tail", () => {
    const publish = vi.fn();
    const batcher = createAgentTextBatcher(publish, () => 1);

    batcher.push("tail");
    batcher.flush();
    batcher.dispose();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("tail");
  });

  it("preserves paragraph separators across scheduled frames", () => {
    const scheduled: Array<() => void> = [];
    let content = "";
    const batcher = createAgentTextBatcher(
      (text) => {
        content += text;
      },
      (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      vi.fn(),
    );

    batcher.push("first");
    scheduled.shift()?.();
    batcher.push("second");
    scheduled.shift()?.();

    expect(content).toBe("first\n\nsecond");
  });
});
