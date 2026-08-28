import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  configureNarrativeMaintenanceCiSeam,
  createNarrativeMaintenanceCiReceipt,
  createNarrativeMaintenanceCiQuiescenceWriter,
  NARRATIVE_MAINTENANCE_QUIESCENCE_TYPE,
  NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
  NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
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
}: {
  freshnessHoldProjectId?: string | null;
  heldProjectId?: string | null;
} = {}) {
  const state = {
    authorityId: "authority-1",
    generation: 1,
    freshnessHoldProjectId,
    heldProjectId,
    projects: [],
    marker: null,
  };
  return {
    ...state,
    stateDigest: `sha256:${createHash("sha256")
      .update(canonicalJson(state), "utf8")
      .digest("hex")}`,
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

  it("emits one immutable quiescence sequence only after matching main signals", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-quiescence-"),
    );
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const seam = parseNarrativeMaintenanceCiSeam(baseEnv, {
        isPackaged: false,
      });
      await writeNarrativeMaintenanceCiReceipt(seam, {
        isPackaged: false,
        userDataDir,
      });
      await writeFile(
        path.join(
          userDataDir,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
        ),
        canonicalJson({
          version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
          type: NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
          nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          requestNonce: "00000000-0000-4000-8000-000000000002",
          phase: "seam-test",
          requestedAt: "1970-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const writer = createNarrativeMaintenanceCiQuiescenceWriter(seam, {
        userDataDir,
      });
      expect(writer).not.toBeNull();
      const state = quiescenceState();
      const binding = { authorityId: "authority-1", generation: 1 };
      await writer?.recordMaintenance({
        discoveryGeneration: 1,
        observedAtMs: Date.now(),
        workspaceBinding: binding,
        discoveryEmpty: true,
        discoveryInFlight: false,
        timerScheduled: false,
        pendingRetry: false,
        pendingEvent: false,
        wakeAckPending: false,
      });
      await writer?.recordScheduler({
        cycleGeneration: 1,
        observedAtMs: Date.now(),
        workspaceBinding: binding,
        cycleAccepted: true,
        queueIdle: true,
        inFlight: false,
        hasMore: false,
        timerScheduled: false,
      });
      const artifact = (await writer?.recordFreshness({
        cycleGeneration: 1,
        observedAtMs: Date.now(),
        inFlight: false,
        hasMore: false,
        noWrite: true,
        wakePending: false,
        timerScheduled: false,
        nextCycleGuardStateDigest: null,
        quiescenceState: state,
      })) as { receipt: Record<string, unknown> } | null;
      expect(artifact).not.toBeNull();
      expect(artifact?.receipt).toMatchObject({
        type: NARRATIVE_MAINTENANCE_QUIESCENCE_TYPE,
        nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
        sequence: 1,
        stateDigest: state.stateDigest,
      });
      expect(
        await readdir(
          path.join(
            userDataDir,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          ),
        ),
      ).toEqual([
        "quiescence-0000000001.json",
        NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
        "receipt.json",
      ]);
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 1,
          observedAtMs: Date.now(),
          inFlight: false,
          hasMore: false,
          noWrite: true,
          heldProjectId: null,
          cutoverNotReady: false,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits a distinct held-project quiescence receipt only with cutover NOT_READY evidence", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-quiescence-held-"),
    );
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const holdProjectId = "project-hold";
      const seam = parseNarrativeMaintenanceCiSeam(
        {
          ...baseEnv,
          [NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV]: holdProjectId,
        },
        { isPackaged: false },
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
      await writeFile(
        path.join(nonceDir, NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE),
        canonicalJson({
          version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
          type: NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
          nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          requestNonce: "00000000-0000-4000-8000-000000000005",
          phase: "held-cycle",
          requestedAt: "1970-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const writer = createNarrativeMaintenanceCiQuiescenceWriter(seam, {
        userDataDir,
      });
      const state = quiescenceState({
        freshnessHoldProjectId: holdProjectId,
        heldProjectId: holdProjectId,
      });
      const binding = { authorityId: "authority-1", generation: 1 };
      const observedAtMs = Date.now();
      await writer?.recordMaintenance({
        discoveryGeneration: 1,
        observedAtMs,
        workspaceBinding: binding,
        discoveryEmpty: true,
        discoveryInFlight: false,
        timerScheduled: false,
        pendingRetry: false,
        pendingEvent: false,
        wakeAckPending: false,
      });
      await writer?.recordScheduler({
        cycleGeneration: 1,
        observedAtMs,
        workspaceBinding: binding,
        cycleAccepted: true,
        queueIdle: true,
        inFlight: false,
        hasMore: false,
        timerScheduled: false,
      });
      const artifact = await writer?.recordFreshness({
        cycleGeneration: 1,
        observedAtMs,
        inFlight: false,
        hasMore: false,
        noWrite: true,
        heldProjectId: holdProjectId,
        cutoverNotReady: true,
        wakePending: false,
        timerScheduled: false,
        nextCycleGuardStateDigest: null,
        quiescenceState: state,
      });
      expect(artifact).not.toBeNull();
      expect(
        (artifact as { receipt: Record<string, unknown> }).receipt,
      ).toMatchObject({
        sequence: 1,
        state,
        freshness: expect.objectContaining({
          heldProjectId: holdProjectId,
          cutoverNotReady: true,
          noWrite: true,
        }),
      });
      await expect(
        writer?.recordFreshness({
          cycleGeneration: 2,
          observedAtMs,
          inFlight: false,
          hasMore: false,
          noWrite: true,
          heldProjectId: holdProjectId,
          cutoverNotReady: false,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("invalidates stale signals for in-flight, queued, mismatched, and unguarded timer cycles", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-quiescence-"),
    );
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const seam = parseNarrativeMaintenanceCiSeam(baseEnv, {
        isPackaged: false,
      });
      await writeNarrativeMaintenanceCiReceipt(seam, {
        isPackaged: false,
        userDataDir,
      });
      await writeFile(
        path.join(
          userDataDir,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
        ),
        canonicalJson({
          version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
          type: NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
          nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          requestNonce: "00000000-0000-4000-8000-000000000002",
          phase: "seam-test",
          requestedAt: "1970-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const writer = createNarrativeMaintenanceCiQuiescenceWriter(seam, {
        userDataDir,
      });
      const state = quiescenceState();
      const binding = { authorityId: "authority-1", generation: 1 };
      const maintenance = {
        discoveryGeneration: 1,
        observedAtMs: Date.now(),
        workspaceBinding: binding,
        discoveryEmpty: true,
        discoveryInFlight: false,
        timerScheduled: false,
        pendingRetry: false,
        pendingEvent: false,
        wakeAckPending: false,
      };
      const scheduler = {
        cycleGeneration: 1,
        observedAtMs: Date.now(),
        workspaceBinding: binding,
        cycleAccepted: true,
        queueIdle: true,
        inFlight: false,
        hasMore: false,
        timerScheduled: false,
      };
      await writer?.recordMaintenance(maintenance);
      await writer?.recordScheduler(scheduler);
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 1,
          observedAtMs: Date.now(),
          inFlight: true,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).toBeNull();
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 2,
          observedAtMs: Date.now(),
          inFlight: false,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: true,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).toBeNull();
      expect(
        await writer?.recordMaintenance({
          ...maintenance,
          discoveryGeneration: 2,
          observedAtMs: Date.now(),
          discoveryEmpty: false,
        }),
      ).toBeNull();
      await expect(
        writer?.recordFreshness({
          cycleGeneration: 3,
          observedAtMs: Date.now(),
          inFlight: false,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: {
            ...state,
            authorityId: "authority-other",
          },
        }),
      ).rejects.toThrow(/stateDigest/);
      expect(
        await readdir(
          path.join(
            userDataDir,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          ),
        ),
      ).toEqual([
        NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
        "receipt.json",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rechecks queued rediscovery and Freshness in-flight state before issuing each sequence", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-quiescence-"),
    );
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const seam = parseNarrativeMaintenanceCiSeam(baseEnv, {
        isPackaged: false,
      });
      await writeNarrativeMaintenanceCiReceipt(seam, {
        isPackaged: false,
        userDataDir,
      });
      const nonceDir = path.join(
        userDataDir,
        NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
        baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      );
      await writeFile(
        path.join(nonceDir, NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE),
        canonicalJson({
          version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
          type: NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
          nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          requestNonce: "00000000-0000-4000-8000-000000000004",
          phase: "runtime-recheck",
          requestedAt: "1970-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const writer = createNarrativeMaintenanceCiQuiescenceWriter(seam, {
        userDataDir,
      });
      const state = quiescenceState();
      const binding = { authorityId: "authority-1", generation: 1 };
      const runtime = {
        mutationRevision: 1,
        maintenance: {
          mutationRevision: 1,
          workspaceBinding: binding,
          discoveryInFlight: false,
          timerScheduled: false,
          pendingRetry: false,
          pendingEvent: false,
          wakeAckPending: false,
        },
        scheduler: {
          mutationRevision: 1,
          workspaceBinding: binding,
          queueIdle: true,
          inFlight: false,
          hasMore: false,
          timerScheduled: false,
        },
        freshness: {
          mutationRevision: 1,
          inFlight: false,
          hasMore: false,
          heldProjectId: null,
          cutoverNotReady: false,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        },
      };
      writer?.setRuntimeStateReader(() => runtime);
      const observedAtMs = Date.now();
      await writer?.recordMaintenance({
        discoveryGeneration: 1,
        observedAtMs,
        workspaceBinding: binding,
        discoveryEmpty: true,
        discoveryInFlight: false,
        timerScheduled: false,
        pendingRetry: false,
        pendingEvent: false,
        wakeAckPending: false,
      });
      await writer?.recordScheduler({
        cycleGeneration: 1,
        observedAtMs,
        workspaceBinding: binding,
        cycleAccepted: true,
        queueIdle: true,
        inFlight: false,
        hasMore: false,
        timerScheduled: false,
      });
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 1,
          observedAtMs,
          inFlight: false,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).not.toBeNull();

      runtime.maintenance.pendingEvent = true;
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 2,
          observedAtMs,
          inFlight: false,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).toBeNull();
      runtime.maintenance.pendingEvent = false;
      runtime.maintenance.discoveryInFlight = true;
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 2,
          observedAtMs,
          inFlight: false,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).toBeNull();
      runtime.maintenance.discoveryInFlight = false;
      runtime.freshness.inFlight = true;
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 3,
          observedAtMs,
          inFlight: false,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).toBeNull();
      runtime.freshness.inFlight = false;
      const final = await writer?.recordFreshness({
        cycleGeneration: 3,
        observedAtMs,
        inFlight: false,
        hasMore: false,
        noWrite: true,
        wakePending: false,
        timerScheduled: false,
        nextCycleGuardStateDigest: null,
        quiescenceState: state,
      });
      expect(final).not.toBeNull();
      expect(
        (final as { receipt: { sequence: number } }).receipt.sequence,
      ).toBe(2);
      expect(await readdir(nonceDir)).toEqual([
        "quiescence-0000000001.json",
        "quiescence-0000000002.json",
        NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
        "receipt.json",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not turn pre-request idle observations into a fresh quiescence receipt", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-quiescence-"),
    );
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const seam = parseNarrativeMaintenanceCiSeam(baseEnv, {
        isPackaged: false,
      });
      await writeNarrativeMaintenanceCiReceipt(seam, {
        isPackaged: false,
        userDataDir,
      });
      const nonceDir = path.join(
        userDataDir,
        NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
        baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      );
      const writeRequest = async (requestNonce: string, requestedAt: string) =>
        writeFile(
          path.join(nonceDir, NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE),
          canonicalJson({
            version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
            type: NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
            nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
            requestNonce,
            phase: "causal-request",
            requestedAt,
          }),
          { mode: 0o600 },
        );
      await writeRequest(
        "00000000-0000-4000-8000-000000000002",
        "2999-01-01T00:00:00.000Z",
      );
      const writer = createNarrativeMaintenanceCiQuiescenceWriter(seam, {
        userDataDir,
      });
      const state = quiescenceState();
      const binding = { authorityId: "authority-1", generation: 1 };
      const maintenance = {
        discoveryGeneration: 1,
        observedAtMs: Date.now(),
        workspaceBinding: binding,
        discoveryEmpty: true,
        discoveryInFlight: false,
        timerScheduled: false,
        pendingRetry: false,
        pendingEvent: false,
        wakeAckPending: false,
      };
      const scheduler = {
        cycleGeneration: 1,
        observedAtMs: Date.now(),
        workspaceBinding: binding,
        cycleAccepted: true,
        queueIdle: true,
        inFlight: false,
        hasMore: false,
        timerScheduled: false,
      };
      const freshness = {
        cycleGeneration: 1,
        observedAtMs: Date.now(),
        inFlight: false,
        hasMore: false,
        noWrite: true,
        wakePending: false,
        timerScheduled: false,
        nextCycleGuardStateDigest: null,
        quiescenceState: state,
      };
      await writer?.recordMaintenance(maintenance);
      await writer?.recordScheduler(scheduler);
      expect(await writer?.recordFreshness(freshness)).toBeNull();
      expect(await readdir(nonceDir)).toEqual([
        NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
        "receipt.json",
      ]);

      await writeRequest(
        "00000000-0000-4000-8000-000000000003",
        new Date(Date.now() - 1_000).toISOString(),
      );
      await writer?.recordMaintenance({
        ...maintenance,
        discoveryGeneration: 2,
        observedAtMs: Date.now(),
      });
      await writer?.recordScheduler({
        ...scheduler,
        cycleGeneration: 2,
        observedAtMs: Date.now(),
      });
      const artifact = await writer?.recordFreshness({
        ...freshness,
        cycleGeneration: 2,
        observedAtMs: Date.now(),
      });
      expect(artifact).not.toBeNull();
      expect(
        (artifact as { receipt: { requestNonce: string } }).receipt
          .requestNonce,
      ).toBe("00000000-0000-4000-8000-000000000003");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a runtime mutation during file I/O before atomic publication", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-quiescence-toctou-"),
    );
    try {
      const userDataDir = path.join(tempRoot, "user-data");
      await mkdir(userDataDir);
      const seam = parseNarrativeMaintenanceCiSeam(baseEnv, {
        isPackaged: false,
      });
      await writeNarrativeMaintenanceCiReceipt(seam, {
        isPackaged: false,
        userDataDir,
      });
      const nonceDir = path.join(
        userDataDir,
        NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
        baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      );
      await writeFile(
        path.join(nonceDir, NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE),
        canonicalJson({
          version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
          type: NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
          nonce: baseEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
          requestNonce: "00000000-0000-4000-8000-000000000005",
          phase: "toctou",
          requestedAt: "1970-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const writer = createNarrativeMaintenanceCiQuiescenceWriter(seam, {
        userDataDir,
      });
      const state = quiescenceState();
      const binding = { authorityId: "authority-1", generation: 1 };
      const runtime = {
        mutationRevision: 1,
        maintenance: {
          mutationRevision: 1,
          workspaceBinding: binding,
          discoveryInFlight: false,
          timerScheduled: false,
          pendingRetry: false,
          pendingEvent: false,
          wakeAckPending: false,
        },
        scheduler: {
          mutationRevision: 1,
          workspaceBinding: binding,
          queueIdle: true,
          inFlight: false,
          hasMore: false,
          timerScheduled: false,
        },
        freshness: {
          mutationRevision: 1,
          inFlight: false,
          hasMore: false,
          heldProjectId: null,
          cutoverNotReady: false,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        },
      };
      let reads = 0;
      writer?.setRuntimeStateReader(() => {
        reads += 1;
        if (reads === 1) {
          // This microtask runs while the writer is awaiting request/root/file
          // I/O. The final synchronous guard must reject the stale temp.
          queueMicrotask(() => {
            runtime.mutationRevision = 2;
            runtime.freshness.mutationRevision = 2;
            runtime.freshness.inFlight = true;
          });
        }
        return runtime;
      });
      const observedAtMs = Date.now();
      await writer?.recordMaintenance({
        discoveryGeneration: 1,
        observedAtMs,
        workspaceBinding: binding,
        discoveryEmpty: true,
        discoveryInFlight: false,
        timerScheduled: false,
        pendingRetry: false,
        pendingEvent: false,
        wakeAckPending: false,
      });
      await writer?.recordScheduler({
        cycleGeneration: 1,
        observedAtMs,
        workspaceBinding: binding,
        cycleAccepted: true,
        queueIdle: true,
        inFlight: false,
        hasMore: false,
        timerScheduled: false,
      });
      expect(
        await writer?.recordFreshness({
          cycleGeneration: 1,
          observedAtMs,
          inFlight: false,
          hasMore: false,
          noWrite: true,
          wakePending: false,
          timerScheduled: false,
          nextCycleGuardStateDigest: null,
          quiescenceState: state,
        }),
      ).toBeNull();
      expect(reads).toBe(2);
      expect(await readdir(nonceDir)).toEqual([
        NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
        "receipt.json",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
