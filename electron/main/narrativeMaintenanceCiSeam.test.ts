import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  NARRATIVE_MAINTENANCE_NONCE_ENV,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV,
  NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
  NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
  NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
  NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES,
  NARRATIVE_FRESHNESS_DISABLE_ENV,
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_TYPE,
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE,
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
  configureNarrativeMaintenanceCiSeam,
  createNarrativeMaintenanceCiReceipt,
  createNarrativeMaintenanceCiHeldFreshnessWriter,
  shouldFailFastNarrativeMaintenanceCiLaunch,
  parseNarrativeMaintenanceCiSeam,
  shouldDisableNarrativeFreshnessForLaunch,
  shouldDisableNarrativeMaintenanceForLaunch,
  writeNarrativeMaintenanceCiReceipt,
} from "./narrativeMaintenanceCiSeam.js";

const baseEnv = {
  CI: "true",
  [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  [NARRATIVE_MAINTENANCE_NONCE_ENV]: "00000000-0000-4000-8000-000000000001",
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function quiescenceState({
  freshnessHoldProjectId = null,
  heldProjectId = null,
  marker = null,
}: {
  freshnessHoldProjectId?: string | null;
  heldProjectId?: string | null;
  marker?: unknown;
} = {}) {
  const state = {
    authorityId: "authority-1",
    generation: 1,
    freshnessHoldProjectId,
    heldProjectId,
    projects: [],
    marker,
  };
  return {
    ...state,
    stateDigest: `sha256:${createHash("sha256")
      .update(canonicalJson(state), "utf8")
      .digest("hex")}`,
  };
}

const HELD_FRESHNESS_TYPE = NARRATIVE_MAINTENANCE_HELD_FRESHNESS_TYPE;
const HELD_FRESHNESS_REQUEST_TYPE =
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE;
const HELD_FRESHNESS_REQUEST_FILE =
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE;
const HELD_FRESHNESS_SEQUENCE_PREFIX = "held-freshness-";
const TEST_WORKSPACE_BINDING = { authorityId: "authority-1", generation: 1 };

function syncDirectorySync(directory: string): number {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return Date.now();
}

function syncFileSync(filePath: string): void {
  const descriptor = openSync(filePath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function createHeldFreshnessWriterFixture(
  prefix: string,
  options: {
    afterRequestBarrierForTest?: () => void;
    beforePublishForTest?: (finalPath: string) => void;
    freshnessHoldProjectId?: string | null;
  } = {},
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const userDataDir = path.join(tempRoot, "user-data");
  await mkdir(userDataDir);
  const seam = parseNarrativeMaintenanceCiSeam(
    {
      ...baseEnv,
      [NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV]:
        options.freshnessHoldProjectId ?? "project-hold",
    },
    {
      isPackaged: false,
    },
  );
  await writeNarrativeMaintenanceCiReceipt(seam, {
    isPackaged: false,
    userDataDir,
  });
  const nonceDir = path.join(
    userDataDir,
    NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
    baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
  );
  return {
    tempRoot,
    userDataDir,
    nonceDir,
    seam,
    writer: createNarrativeMaintenanceCiHeldFreshnessWriter(seam, {
      userDataDir,
      afterRequestBarrierForTest: options.afterRequestBarrierForTest,
      beforePublishForTest: options.beforePublishForTest,
    }),
  };
}

async function writeHeldFreshnessRequest(
  nonceDir: string,
  requestNonce: string,
  workspaceBinding = TEST_WORKSPACE_BINDING,
  fileName = HELD_FRESHNESS_REQUEST_FILE,
) {
  const requestPath = path.join(nonceDir, fileName);
  const temporaryPath = `${requestPath}.tmp`;
  await writeFile(
    temporaryPath,
    canonicalJson({
      version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
      type: HELD_FRESHNESS_REQUEST_TYPE,
      nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      requestNonce,
      phase: "held-freshness-test",
      requestedAt: "1970-01-01T00:00:00.000Z",
      workspaceBinding,
    }),
    { mode: 0o600 },
  );
  syncFileSync(temporaryPath);
  await rename(temporaryPath, requestPath);
  syncDirectorySync(nonceDir);
}

function writeHeldFreshnessRequestSync(
  nonceDir: string,
  requestNonce: string,
  fileName = HELD_FRESHNESS_REQUEST_FILE,
) {
  writeFileSync(
    path.join(nonceDir, fileName),
    canonicalJson({
      version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
      type: HELD_FRESHNESS_REQUEST_TYPE,
      nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      requestNonce,
      phase: "held-freshness-test",
      requestedAt: "1970-01-01T00:00:00.000Z",
      workspaceBinding: TEST_WORKSPACE_BINDING,
    }),
    { mode: 0o600 },
  );
}

function heldFreshnessObservation(
  state: ReturnType<typeof quiescenceState>,
  cycleGeneration: number,
  heldProjectId: string | null = "project-hold",
  observedAtMs = Date.now() + 100,
  cycleStartedAtMs = Date.now() + 10,
) {
  return {
    cycleGeneration,
    cycleStartedAtMs,
    observedAtMs,
    inFlight: false,
    hasMore: false,
    noWrite: true,
    heldProjectId,
    cutoverNotReady: heldProjectId !== null,
    wakePending: false,
    timerScheduled: false,
    nextCycleGuardStateDigest: null,
    quiescenceState: state,
  };
}

describe("C2-5B main-only CI seam", () => {
  it("activates only for the unpackaged exact-CI exact-owner launch", () => {
    expect(
      parseNarrativeMaintenanceCiSeam(baseEnv, { isPackaged: false }),
    ).toMatchObject({
      active: true,
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      nonce: "00000000-0000-4000-8000-000000000001",
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
      nonce: "00000000-0000-4000-8000-000000000001",
      fault: "transient-io",
      trigger: "foreground-workspace-wake",
      setup: "disabled",
      freshness: null,
      freshnessHoldProjectId: null,
      productJourneyBarrierId: "barrier-1",
      correlation: "correlation-1",
    });
    expect(seam).not.toHaveProperty("graphContractDigest");
  });

  it("accepts the Freshness hold only for the active owner-gated launch", () => {
    expect(
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          [NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV]: "project-hold",
        },
        { isPackaged: false },
      ),
    ).toMatchObject({
      active: true,
      freshnessHoldProjectId: "project-hold",
    });
    expect(
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          CI: "false",
          [NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV]: "not-read",
        },
        { isPackaged: false },
      ),
    ).toEqual({ active: false });
    expect(
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          [NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV]: " hold ",
        },
        { isPackaged: true },
      ),
    ).toEqual({ active: false });
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

  it("requires a launch nonce for every active seam", () => {
    const { [NARRATIVE_MAINTENANCE_NONCE_ENV]: _nonce, ...withoutNonce } =
      baseEnv;
    expect(() =>
      parseNarrativeMaintenanceCiSeam(withoutNonce, { isPackaged: false }),
    ).toThrow(/nonce/i);
  });

  it("creates an exact main receipt without owner token or paths", () => {
    const receipt = createNarrativeMaintenanceCiReceipt(
      parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP: "disabled",
          GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER: "dependency-gap",
          [NARRATIVE_FRESHNESS_DISABLE_ENV]: "disabled",
        },
        { isPackaged: false },
      ),
      { isPackaged: false },
    );
    expect(receipt).toEqual({
      version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
      type: NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
      nonce: "00000000-0000-4000-8000-000000000001",
      active: true,
      setup: "disabled",
      freshness: "disabled",
      freshnessHoldProjectId: null,
      fault: null,
      trigger: "dependency-gap",
      isPackaged: false,
      nativeAck: true,
    });
    expect(receipt).not.toHaveProperty("ownerToken");
    expect(receipt).not.toHaveProperty("path");
  });

  it("writes one canonical fsynced receipt atomically and rejects duplicates", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grimodex-receipt-"));
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const seam = parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP: "disabled",
        },
        { isPackaged: false },
      );
      const artifact = await writeNarrativeMaintenanceCiReceipt(seam, {
        isPackaged: false,
        userDataDir,
      });
      expect(artifact).not.toBeNull();
      expect(artifact?.receipt.nativeAck).toBe(true);
      expect(artifact?.byteLength).toBeLessThanOrEqual(
        NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES,
      );
      expect(artifact?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      const root = path.join(
        userDataDir,
        NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
      );
      const nonceDir = path.join(
        root,
        baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      );
      expect(await readdir(root)).toEqual([
        baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      ]);
      expect(await readdir(nonceDir)).toEqual(["receipt.json"]);
      const encoded = await readFile(
        path.join(nonceDir, "receipt.json"),
        "utf8",
      );
      expect(
        (await stat(path.join(nonceDir, "receipt.json"))).mode & 0o777,
      ).toBe(0o600);
      expect(JSON.parse(encoded)).toEqual(artifact?.receipt);
      expect(encoded).not.toContain(NARRATIVE_MAINTENANCE_OWNER_TOKEN);
      await expect(
        writeNarrativeMaintenanceCiReceipt(seam, {
          isPackaged: false,
          userDataDir,
        }),
      ).rejects.toThrow(/clean|already exists|receipt/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinked or unexpected receipt roots without deleting evidence", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grimodex-receipt-"));
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const root = path.join(
        userDataDir,
        NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
      );
      const outside = path.join(tempRoot, "outside");
      await mkdir(outside);
      await symlink(outside, root);
      const seam = parseNarrativeMaintenanceCiSeam(baseEnv, {
        isPackaged: false,
      });
      await expect(
        writeNarrativeMaintenanceCiReceipt(seam, {
          isPackaged: false,
          userDataDir,
        }),
      ).rejects.toThrow(/regular directory|escaped|symlink/i);
      await rm(root, { force: true });
      await mkdir(root);
      await expect(
        writeNarrativeMaintenanceCiReceipt(seam, {
          isPackaged: false,
          userDataDir,
        }),
      ).resolves.not.toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("marks only exact-CI owner launches as acceptance-fatal", () => {
    expect(
      shouldFailFastNarrativeMaintenanceCiLaunch({
        isPackaged: false,
        env: baseEnv,
      }),
    ).toBe(true);
    expect(
      shouldFailFastNarrativeMaintenanceCiLaunch({
        isPackaged: true,
        env: baseEnv,
      }),
    ).toBe(false);
    expect(
      shouldFailFastNarrativeMaintenanceCiLaunch({
        isPackaged: false,
        env: { ...baseEnv, CI: "false" },
      }),
    ).toBe(false);
    expect(
      shouldFailFastNarrativeMaintenanceCiLaunch({
        isPackaged: false,
        env: { ...baseEnv, [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: "other" },
      }),
    ).toBe(false);
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
      freshnessHoldProjectId: null,
      productJourneyBarrierId: null,
      correlation: null,
    });
  });

  it("suppresses only the setup launch and never normal or inactive launches", () => {
    expect(
      shouldDisableNarrativeMaintenanceForLaunch({
        active: true,
        ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
        nonce: "00000000-0000-4000-8000-000000000001",
        fault: null,
        trigger: null,
        setup: "disabled",
        freshness: null,
        freshnessHoldProjectId: null,
        productJourneyBarrierId: null,
        correlation: null,
      }),
    ).toBe(true);
    expect(
      shouldDisableNarrativeMaintenanceForLaunch({
        active: true,
        ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
        nonce: "00000000-0000-4000-8000-000000000001",
        fault: null,
        trigger: null,
        setup: null,
        freshness: null,
        freshnessHoldProjectId: null,
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
        nonce: "00000000-0000-4000-8000-000000000001",
        fault: null,
        trigger: null,
        setup: "disabled",
        freshness: null,
        freshnessHoldProjectId: null,
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

  it("publishes one held-Freshness event after the request rename without owner callbacks", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      // A completed callback before request visibility is not evidence. The
      // next periodic Held callback is the only causal publication point.
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 1),
        ),
      ).toBeNull();
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000006",
      );
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 2),
        ),
      ).toBeNull();
      const artifact = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 3),
      );
      expect(artifact).not.toBeNull();
      expect(
        (artifact as { receipt: Record<string, unknown> }).receipt,
      ).toEqual(
        expect.objectContaining({
          type: HELD_FRESHNESS_TYPE,
          requestNonce: "00000000-0000-4000-8000-000000000006",
          workspaceBinding: TEST_WORKSPACE_BINDING,
          freshness: expect.objectContaining({
            heldProjectId: "project-hold",
            cutoverNotReady: true,
            noWrite: true,
            hasMore: false,
          }),
        }),
      );
      expect(
        (artifact as { receipt: Record<string, unknown> }).receipt,
      ).not.toHaveProperty("discovery");
      expect(
        (artifact as { receipt: Record<string, unknown> }).receipt,
      ).not.toHaveProperty("scheduler");
      expect(await readdir(fixture.nonceDir)).toEqual([
        `${HELD_FRESHNESS_SEQUENCE_PREFIX}0000000001.json`,
        HELD_FRESHNESS_REQUEST_FILE,
        "receipt.json",
      ]);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("requires the same request after the first durable barrier and resets on mutation", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-barrier-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000005",
      );

      // The first callback only establishes the main-process durable barrier.
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 1),
        ),
      ).toBeNull();

      // A changed request cannot reuse the prior barrier. It must establish a
      // new one and remain fail-closed for this callback.
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000006",
      );
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 2),
        ),
      ).toBeNull();

      const artifact = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 3),
      );
      expect(artifact).not.toBeNull();
      const receipt = (artifact as { receipt: Record<string, unknown> })
        .receipt;
      const freshness = receipt.freshness as Record<string, unknown>;
      expect(receipt.requestNonce).toBe("00000000-0000-4000-8000-000000000006");
      expect(freshness.requestPublishedAtMs).toEqual(expect.any(Number));
      expect(freshness.requestBarrierCycleGeneration).toBe(2);
      expect(freshness.cycleStartedAtMs).toBeGreaterThan(
        freshness.requestPublishedAtMs as number,
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("arms the durable request barrier before recordFreshness returns", async () => {
    let barrierArmed = false;
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-synchronous-barrier-red-",
      {
        afterRequestBarrierForTest: () => {
          barrierArmed = true;
        },
      },
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000023",
      );

      const firstCallback = fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 1),
      );
      expect(barrierArmed).toBe(true);
      await expect(firstCallback).resolves.toBeNull();
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a pre-barrier cycle fail-closed before a later causal cycle", async () => {
    vi.useFakeTimers();
    const t1 = 50_000;
    vi.setSystemTime(t1);
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-barrier-timing-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000007",
      );
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 1, "project-hold", t1 + 1, t1 - 1),
        ),
      ).toBeNull();
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 2, "project-hold", t1 + 1, t1),
        ),
      ).toBeNull();
      const artifact = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 3, "project-hold", t1 + 2, t1 + 1),
      );
      expect(artifact).not.toBeNull();
      expect(
        (artifact as { receipt: Record<string, unknown> }).receipt.freshness,
      ).toEqual(
        expect.objectContaining({
          requestBarrierCycleGeneration: 1,
          requestPublishedAtMs: t1,
          cycleStartedAtMs: t1 + 1,
        }),
      );
    } finally {
      vi.useRealTimers();
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("treats nullable maintenance and scheduler producer bindings as ordinary invalidation", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-null-binding-red-",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        fixture.writer?.recordMaintenance({
          discoveryGeneration: 1,
          observedAtMs: Date.now(),
          workspaceBinding: null,
          discoveryEmpty: true,
          discoveryInFlight: false,
          timerScheduled: false,
          pendingRetry: false,
          pendingEvent: false,
          wakeAckPending: false,
        }),
      ).resolves.toBeNull();
      await expect(
        fixture.writer?.recordScheduler({
          cycleGeneration: 1,
          observedAtMs: Date.now(),
          workspaceBinding: null,
          cycleAccepted: true,
          queueIdle: true,
          inFlight: false,
          hasMore: false,
          timerScheduled: false,
        }),
      ).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for a request binding mismatch, an unheld cycle, and a marker", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-gates-red-",
    );
    try {
      const heldState = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000007",
        { authorityId: "authority-other", generation: 1 },
      );
      await expect(
        fixture.writer?.recordFreshness(heldFreshnessObservation(heldState, 1)),
      ).resolves.toBeNull();

      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000008",
      );
      await expect(
        fixture.writer?.recordFreshness(
          heldFreshnessObservation(quiescenceState(), 2, null),
        ),
      ).resolves.toBeNull();

      const markedState = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
        marker: {
          migrationId: "narrative-c2-canonical-freshness-v1",
          contractVersion: 1,
          appliedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000009",
      );
      await expect(
        fixture.writer?.recordFreshness(
          heldFreshnessObservation(markedState, 3),
        ),
      ).resolves.toBeNull();
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("does not observe a request until atomic rename and rejects duplicate request publication", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-atomic-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      const temporaryRequest = `${HELD_FRESHNESS_REQUEST_FILE}.tmp`;
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000010",
        TEST_WORKSPACE_BINDING,
        temporaryRequest,
      );
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 1),
        ),
      ).toBeNull();
      await rename(
        path.join(fixture.nonceDir, temporaryRequest),
        path.join(fixture.nonceDir, HELD_FRESHNESS_REQUEST_FILE),
      );
      const first = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 2),
      );
      expect(first).toBeNull();
      const second = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 3),
      );
      expect(second).not.toBeNull();
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 4),
        ),
      ).toBeNull();
      expect(await readdir(fixture.nonceDir)).toEqual([
        `${HELD_FRESHNESS_SEQUENCE_PREFIX}0000000001.json`,
        HELD_FRESHNESS_REQUEST_FILE,
        "receipt.json",
      ]);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("does not accept a request renamed during a queued callback until the next cycle", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-rename-race-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      const temporaryRequest = `${HELD_FRESHNESS_REQUEST_FILE}.tmp`;
      const observedAtMs = Date.now();
      const callback = fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 1, "project-hold", observedAtMs),
      );
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000011",
        TEST_WORKSPACE_BINDING,
        temporaryRequest,
      );
      await rename(
        path.join(fixture.nonceDir, temporaryRequest),
        path.join(fixture.nonceDir, HELD_FRESHNESS_REQUEST_FILE),
      );
      expect(await callback).toBeNull();
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 2),
        ),
      ).toBeNull();
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 3),
        ),
      ).not.toBeNull();
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("arms only after a strict main directory barrier for a renamed request", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-durable-publication-race-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      const request = {
        version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
        type: HELD_FRESHNESS_REQUEST_TYPE,
        nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
        requestNonce: "00000000-0000-4000-8000-000000000022",
        phase: "held-freshness-durable-publication",
        requestedAt: "1970-01-01T00:00:00.000Z",
        workspaceBinding: TEST_WORKSPACE_BINDING,
      };
      const temporaryPath = path.join(
        fixture.nonceDir,
        `${HELD_FRESHNESS_REQUEST_FILE}.tmp`,
      );
      const requestPath = path.join(
        fixture.nonceDir,
        HELD_FRESHNESS_REQUEST_FILE,
      );
      writeFileSync(temporaryPath, canonicalJson(request), { mode: 0o600 });
      syncFileSync(temporaryPath);
      renameSync(temporaryPath, requestPath);

      // The request is visible after rename, but the nonce directory has not
      // been fsynced by the harness. The main writer must establish its own
      // strict barrier and cannot certify this callback from metadata alone.
      const barrierCallback = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 1, "project-hold", Date.now() + 100),
      );
      expect(barrierCallback).toBeNull();

      const cycleStartedAtMs = Date.now() + 10;
      const afterBarrier = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(
          state,
          2,
          "project-hold",
          cycleStartedAtMs + 1,
          cycleStartedAtMs,
        ),
      );
      expect(afterBarrier).not.toBeNull();
      expect(
        (afterBarrier as { receipt: Record<string, unknown> }).receipt
          .freshness,
      ).toEqual(
        expect.objectContaining({
          requestBarrierCycleGeneration: 1,
          requestPublishedAtMs: expect.any(Number),
        }),
      );
      const freshness = (afterBarrier as { receipt: Record<string, unknown> })
        .receipt.freshness as Record<string, unknown>;
      expect(cycleStartedAtMs).toBeGreaterThan(
        freshness.requestPublishedAtMs as number,
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a request published after callback entry at the same observed time", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-publication-race-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      const temporaryRequest = `${HELD_FRESHNESS_REQUEST_FILE}.tmp`;
      writeHeldFreshnessRequestSync(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000016",
        temporaryRequest,
      );
      const callbackEntryObservedAtMs = Date.now();
      // Leave a measurable publication boundary so filesystems with
      // millisecond timestamps cannot collapse the two observations.
      await new Promise((resolve) => setTimeout(resolve, 10));
      renameSync(
        path.join(fixture.nonceDir, temporaryRequest),
        path.join(fixture.nonceDir, HELD_FRESHNESS_REQUEST_FILE),
      );
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(
            state,
            1,
            "project-hold",
            callbackEntryObservedAtMs,
          ),
        ),
      ).toBeNull();
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 2),
        ),
      ).not.toBeNull();
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an atomic request replacement captured before the queued read", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-request-replace-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000012",
      );
      const callback = fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 1),
      );

      // Replace the final request before the queued operation gets to its
      // reader. The operation must parse the invocation snapshot, then reject
      // the durable path mismatch rather than publishing for the old request.
      const replacement = `${HELD_FRESHNESS_REQUEST_FILE}.tmp`;
      writeHeldFreshnessRequestSync(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000013",
        replacement,
      );
      renameSync(
        path.join(fixture.nonceDir, replacement),
        path.join(fixture.nonceDir, HELD_FRESHNESS_REQUEST_FILE),
      );
      expect(await callback).toBeNull();
      expect(await readdir(fixture.nonceDir)).toEqual([
        HELD_FRESHNESS_REQUEST_FILE,
        "receipt.json",
      ]);

      // The rejected invocation does not consume the sequence. The next
      // Freshness cycle can publish the replacement as sequence one.
      const next = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 2),
      );
      expect(next).toBeNull();
      const published = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 3),
      );
      expect(published).not.toBeNull();
      expect(
        (published as { receipt: Record<string, unknown> }).receipt,
      ).toEqual(
        expect.objectContaining({
          sequence: 1,
          requestNonce: "00000000-0000-4000-8000-000000000013",
        }),
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("does not overwrite a competing sequence target or advance sequence", async () => {
    let publishInterpositions = 0;
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-publish-competitor-red-",
      {
        beforePublishForTest: (finalPath) => {
          publishInterpositions += 1;
          if (publishInterpositions === 1) {
            writeFileSync(finalPath, "competitor", { mode: 0o600 });
          }
        },
      },
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000015",
      );
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 1),
        ),
      ).toBeNull();
      const competitorPath = path.join(
        fixture.nonceDir,
        `${HELD_FRESHNESS_SEQUENCE_PREFIX}0000000001.json`,
      );
      const competing = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 2),
      );
      expect(competing).toBeNull();
      expect(publishInterpositions).toBe(1);
      expect(await readFile(competitorPath, "utf8")).toBe("competitor");
      await rm(competitorPath, { force: true });
      const next = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 3),
      );
      expect(next).toBeNull();
      const published = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(state, 4),
      );
      expect(published).not.toBeNull();
      expect(
        (published as { receipt: Record<string, unknown> }).receipt.sequence,
      ).toBe(1);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a non-adjacent replay of a request nonce during one launch", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-request-replay-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      const requestA = "00000000-0000-4000-8000-000000000017";
      const requestB = "00000000-0000-4000-8000-000000000018";
      await writeHeldFreshnessRequest(fixture.nonceDir, requestA);
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 1),
        ),
      ).toBeNull();
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 2),
        ),
      ).not.toBeNull();

      await writeHeldFreshnessRequest(fixture.nonceDir, requestB);
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 3),
        ),
      ).toBeNull();
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 4),
        ),
      ).not.toBeNull();

      // A request nonce is a launch-lifetime identity, not merely a
      // consecutive-cycle value. Replaying A after B must not publish again.
      await writeHeldFreshnessRequest(fixture.nonceDir, requestA);
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 5),
        ),
      ).toBeNull();
      expect(await readdir(fixture.nonceDir)).toEqual([
        `${HELD_FRESHNESS_SEQUENCE_PREFIX}0000000001.json`,
        `${HELD_FRESHNESS_SEQUENCE_PREFIX}0000000002.json`,
        HELD_FRESHNESS_REQUEST_FILE,
        "receipt.json",
      ]);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a held callback without a post-publication native cycle start", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-cycle-causality-red-",
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      const cycleStartedAtMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000020",
      );

      // The native cycle started before this request was published. Even
      // though it completed afterward, its state snapshot is not causal.
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(
            state,
            1,
            "project-hold",
            Date.now() + 100,
            cycleStartedAtMs,
          ),
        ),
      ).toBeNull();
      const nextCycleStartedAtMs = Date.now() + 10;
      const next = await fixture.writer?.recordFreshness(
        heldFreshnessObservation(
          state,
          2,
          "project-hold",
          nextCycleStartedAtMs + 10,
          nextCycleStartedAtMs,
        ),
      );
      expect(next).not.toBeNull();
      expect(
        (next as { receipt: Record<string, unknown> }).receipt.sequence,
      ).toBe(1);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a self-consistent payload whose hold is outside the launch seam", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-seam-binding-red-",
      { freshnessHoldProjectId: "project-seam" },
    );
    try {
      const state = quiescenceState({
        freshnessHoldProjectId: "project-payload",
        heldProjectId: "project-payload",
      });
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000021",
      );
      // The state and observation agree with each other, but neither is the
      // effective hold selected by the owner-gated seam.
      expect(
        await fixture.writer?.recordFreshness(
          heldFreshnessObservation(state, 1, "project-payload"),
        ),
      ).toBeNull();
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a contained request symlink even when O_NOFOLLOW is unavailable", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-request-symlink-red-",
    );
    const outsideDir = path.join(fixture.tempRoot, "outside");
    const requestPath = path.join(
      fixture.nonceDir,
      HELD_FRESHNESS_REQUEST_FILE,
    );
    try {
      await mkdir(outsideDir);
      const outsideRequest = path.join(outsideDir, "request.json");
      await writeHeldFreshnessRequest(
        outsideDir,
        "00000000-0000-4000-8000-000000000019",
        TEST_WORKSPACE_BINDING,
        "request.json",
      );
      await symlink(outsideRequest, requestPath);
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });

      // Simulate win32, where O_NOFOLLOW is unavailable. Path-level
      // validation must still reject the symlink before opening its target.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        expect(
          await fixture.writer?.recordFreshness(
            heldFreshnessObservation(state, 1),
          ),
        ).toBeNull();
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
        });
      }
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when strict nonce directory fsync is unavailable", async () => {
    const fixture = await createHeldFreshnessWriterFixture(
      "grimodex-held-freshness-directory-fsync-blocked-red-",
    );
    try {
      await writeHeldFreshnessRequest(
        fixture.nonceDir,
        "00000000-0000-4000-8000-000000000023",
      );
      const state = quiescenceState({
        freshnessHoldProjectId: "project-hold",
        heldProjectId: "project-hold",
      });
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        expect(
          await fixture.writer?.recordFreshness(
            heldFreshnessObservation(state, 1),
          ),
        ).toBeNull();
        expect(
          await fixture.writer?.recordFreshness(
            heldFreshnessObservation(state, 2),
          ),
        ).toBeNull();
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
        });
      }
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});
