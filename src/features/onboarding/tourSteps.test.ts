import { describe, expect, it } from "vitest";
import { expandPreset } from "@/features/ai-policy/preset";
import { getTourSteps } from "./tourSteps";

describe("SampleTour step order", () => {
  it("starts with workspace/project guidance and ends with export before completion", () => {
    const steps = getTourSteps(expandPreset("full"), { includeExport: true });

    expect(steps[0]).toMatchObject({
      key: "workspace",
      panelId: null,
      passive: true,
      slides: [
        { id: "workspace", targets: ["workspace-menu"] },
        { id: "project", targets: ["project-menu"] },
      ],
    });
    expect(steps.at(-2)).toMatchObject({
      key: "export",
      panelId: null,
      passive: true,
      slides: [{ id: "overview", targets: ["export-button"] }],
    });
    expect(steps.at(-1)?.key).toBe("end");
  });

  it("keeps workspace and export guidance when AI steps are filtered out", () => {
    const steps = getTourSteps(expandPreset("off"), { includeExport: true });
    const keys = steps.map((step) => step.key);

    expect(keys[0]).toBe("workspace");
    expect(keys).toContain("export");
    expect(keys).not.toContain("chat");
    expect(keys).toContain("codex");
    expect(keys.at(-1)).toBe("end");
  });

  it("omits export guidance when the runtime cannot export projects", () => {
    const steps = getTourSteps(expandPreset("full"), { includeExport: false });
    const keys = steps.map((step) => step.key);

    expect(keys).not.toContain("export");
    expect(keys.at(-1)).toBe("end");
  });
});
