import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./recorder", () => ({ recordChangeEvent: vi.fn() }));

import { recordChangeEvent } from "./recorder";
import { recordLayoutSnapshot } from "./captureLayout";
import type { LayoutState } from "@/features/layout/layoutTypes";

const rec = vi.mocked(recordChangeEvent);

const SAMPLE: LayoutState = {
  regions: {
    left: { size: 280, slots: [] },
    right: { size: 0, slots: [] },
    bottom: { size: 0, slots: [] },
  },
  center: { editorOpen: true, segments: [] },
};

beforeEach(() => rec.mockClear());

describe("captureLayout", () => {
  it("records a self-contained layout.snapshot under domain=layout / entityId=workspace, sceneId null", () => {
    recordLayoutSnapshot({ layout: SAMPLE });
    expect(rec).toHaveBeenCalledTimes(1);
    const ev = rec.mock.calls[0][0];
    expect(ev.domain).toBe("layout");
    expect(ev.opType).toBe("layout.snapshot");
    expect(ev.entityType).toBe("workspace");
    expect(ev.entityId).toBe("workspace");
    expect(ev.sceneId).toBeNull();
    expect((ev.payload as { layout: LayoutState }).layout).toEqual(SAMPLE);
  });

  it("includes activePresetId / hiddenStripePanels only when present", () => {
    recordLayoutSnapshot({
      layout: SAMPLE,
      activePresetId: "builtin:writing",
      hiddenStripePanels: ["chat"],
    });
    const payload = rec.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.activePresetId).toBe("builtin:writing");
    expect(payload.hiddenStripePanels).toEqual(["chat"]);
  });

  it("omits empty optional fields", () => {
    recordLayoutSnapshot({
      layout: SAMPLE,
      activePresetId: null,
      hiddenStripePanels: [],
    });
    const payload = rec.mock.calls[0][0].payload as Record<string, unknown>;
    expect("activePresetId" in payload).toBe(false);
    expect("hiddenStripePanels" in payload).toBe(false);
  });
});
