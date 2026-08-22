import { describe, expect, it, vi } from "vitest";

import {
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  configureNarrativeMaintenanceCiSeam,
  parseNarrativeMaintenanceCiSeam,
} from "./narrativeMaintenanceCiSeam.js";

const baseEnv = {
  CI: "true",
  [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
};

describe("C2-5B main-only CI seam", () => {
  it("activates only for the unpackaged exact-CI exact-owner launch", () => {
    expect(
      parseNarrativeMaintenanceCiSeam(baseEnv, { isPackaged: false }),
    ).toMatchObject({
      active: true,
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    });
    expect(
      parseNarrativeMaintenanceCiSeam(baseEnv, { isPackaged: true }),
    ).toEqual({ active: false });
    expect(
      parseNarrativeMaintenanceCiSeam(
        { ...baseEnv, CI: "TRUE" },
        { isPackaged: false },
      ),
    ).toEqual({ active: false });
    expect(
      parseNarrativeMaintenanceCiSeam(
        { ...baseEnv, [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: "other" },
        { isPackaged: false },
      ),
    ).toEqual({ active: false });
  });

  it("parses the runner's closed fault/trigger/setup schema without digest input", () => {
    const seam = parseNarrativeMaintenanceCiSeam(
      {
        ...baseEnv,
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT: "transient-io",
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER:
          "foreground-workspace-wake",
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP: "disabled",
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID: "barrier-1",
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_CORRELATION: "correlation-1",
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_GRAPH_DIGEST: "must-not-be-read",
      },
      { isPackaged: false },
    );
    expect(seam).toEqual({
      active: true,
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      fault: "transient-io",
      trigger: "foreground-workspace-wake",
      setup: "disabled",
      productJourneyBarrierId: "barrier-1",
      correlation: "correlation-1",
    });
    expect(seam).not.toHaveProperty("graphContractDigest");
  });

  it("rejects unknown values and incomplete marker pairs only when active", () => {
    expect(() =>
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT: "repair",
        },
        { isPackaged: false },
      ),
    ).toThrow(/fault/i);
    expect(() =>
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID: "barrier-only",
        },
        { isPackaged: false },
      ),
    ).toThrow(/barrier|correlation/i);
    expect(
      parseNarrativeMaintenanceCiSeam(
        { ...baseEnv, GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT: "repair" },
        { isPackaged: true },
      ),
    ).toEqual({ active: false });
  });

  it("configures native exactly once after activation and never exposes an IPC bridge", async () => {
    const configure = vi.fn().mockResolvedValue('{"status":"enabled"}');
    const backend = { configureNarrativeMaintenanceCiSeam: configure };

    const result = await configureNarrativeMaintenanceCiSeam(backend, {
      isPackaged: false,
      env: {
        ...baseEnv,
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER: "dependency-gap",
      },
    });

    expect(result.active).toBe(true);
    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith({
      isPackaged: false,
      ci: "true",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      fault: null,
      trigger: "dependency-gap",
      setup: null,
      productJourneyBarrierId: null,
      correlation: null,
    });
  });
});
