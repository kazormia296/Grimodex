import { describe, expect, it, vi } from "vitest";

import {
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_FRESHNESS_DISABLE_ENV,
  configureNarrativeMaintenanceCiSeam,
  parseNarrativeMaintenanceCiSeam,
  shouldDisableNarrativeFreshnessForLaunch,
  shouldDisableNarrativeMaintenanceForLaunch,
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
      freshness: null,
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
    expect(() =>
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          [NARRATIVE_FRESHNESS_DISABLE_ENV]: "enabled",
        },
        { isPackaged: false },
      ),
    ).toThrow(/NARRATIVE_FRESHNESS/);
    expect(() =>
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          [NARRATIVE_FRESHNESS_DISABLE_ENV]: "disabled",
        },
        { isPackaged: false },
      ),
    ).toThrow(/requires.*SETUP.*disabled/i);
    for (const environment of [{ isPackaged: true }, { isPackaged: false }]) {
      const env =
        environment.isPackaged === true
          ? { ...baseEnv, [NARRATIVE_FRESHNESS_DISABLE_ENV]: "enabled" }
          : {
              ...baseEnv,
              CI: "false",
              [NARRATIVE_FRESHNESS_DISABLE_ENV]: "enabled",
            };
      expect(parseNarrativeMaintenanceCiSeam(env, environment)).toEqual({
        active: false,
      });
    }
    expect(
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: "other-owner",
          [NARRATIVE_FRESHNESS_DISABLE_ENV]: "enabled",
        },
        { isPackaged: false },
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
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP: "disabled",
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER: "dependency-gap",
        [NARRATIVE_FRESHNESS_DISABLE_ENV]: "disabled",
      },
    });

    expect(result).toMatchObject({ active: true, freshness: "disabled" });
    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith({
      isPackaged: false,
      ci: "true",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      fault: null,
      trigger: "dependency-gap",
      setup: "disabled",
      productJourneyBarrierId: null,
      correlation: null,
    });
  });

  it("suppresses only the setup launch and never normal or inactive launches", () => {
    expect(
      shouldDisableNarrativeMaintenanceForLaunch({
        active: true,
        ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
        fault: null,
        trigger: null,
        setup: "disabled",
        freshness: null,
        productJourneyBarrierId: null,
        correlation: null,
      }),
    ).toBe(true);
    expect(
      shouldDisableNarrativeMaintenanceForLaunch({
        active: true,
        ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
        fault: null,
        trigger: null,
        setup: null,
        freshness: null,
        productJourneyBarrierId: null,
        correlation: null,
      }),
    ).toBe(false);
    expect(shouldDisableNarrativeMaintenanceForLaunch({ active: false })).toBe(
      false,
    );
  });

  it("disables freshness only for the exact owner-gated restore launch seam", () => {
    const restoreSeam = parseNarrativeMaintenanceCiSeam(
      {
        ...baseEnv,
        GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP: "disabled",
        [NARRATIVE_FRESHNESS_DISABLE_ENV]: "disabled",
      },
      { isPackaged: false },
    );
    expect(shouldDisableNarrativeFreshnessForLaunch(restoreSeam)).toBe(true);
    expect(
      shouldDisableNarrativeFreshnessForLaunch({
        active: true,
        ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
        fault: null,
        trigger: null,
        setup: "disabled",
        freshness: null,
        productJourneyBarrierId: null,
        correlation: null,
      }),
    ).toBe(false);
    expect(
      shouldDisableNarrativeFreshnessForLaunch(
        parseNarrativeMaintenanceCiSeam(baseEnv, { isPackaged: false }),
      ),
    ).toBe(false);
    expect(
      shouldDisableNarrativeFreshnessForLaunch(
        parseNarrativeMaintenanceCiSeam(
          {
            ...baseEnv,
            CI: "false",
            [NARRATIVE_FRESHNESS_DISABLE_ENV]: "disabled",
          },
          { isPackaged: false },
        ),
      ),
    ).toBe(false);
  });
});
