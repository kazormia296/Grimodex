import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const mainDirectory = dirname(fileURLToPath(import.meta.url));
const mainIndexSource = readFileSync(join(mainDirectory, "index.ts"), "utf8");
const maintenanceSource = readFileSync(
  join(mainDirectory, "narrativeMaintenance.ts"),
  "utf8",
);
const preloadSource = readFileSync(
  join(mainDirectory, "../preload/index.ts"),
  "utf8",
);

describe("C2-5B Phase 1 main-only integration contract", () => {
  it("turns workspace opened and restored events into a main scheduler wake", () => {
    const eventWiring = mainIndexSource.slice(
      mainIndexSource.indexOf("registerEventBus(backend"),
    );

    expect(eventWiring).toMatch(/workspace:opened/);
    expect(eventWiring).toMatch(/workspace:(?:restored|restore)/);
    expect(eventWiring).toMatch(/narrativeMaintenance\.(?:request|enqueue)/);
    expect(eventWiring).toMatch(/project/i);
  });

  it("keeps the workspace wake and retry/failure contract outside renderer IPC", () => {
    expect(preloadSource).not.toMatch(/narrativeMaintenance/i);
    expect(mainIndexSource).not.toMatch(/preload.*narrativeMaintenance/i);
    expect(maintenanceSource).toMatch(/terminalReasonCode/);
    expect(maintenanceSource).toMatch(/failureClass/);
  });
});
