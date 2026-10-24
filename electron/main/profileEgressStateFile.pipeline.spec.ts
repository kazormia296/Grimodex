// NIR-1 DA-2 ST2 (DR-DA2-19; K3/2 "起動時の gate" の受理条件の表、Negative (16),
// Recovery (4)(5); Negative (4) の PUB-G の前の要求): Main の gate を実 Native の
// addon で起動し、状態ファイルの各行で Native が admission を開いたまま Main が
// unavailable にする組合せがないこと、PUB-G の前の要求が not-activated で何も
// 変えないこと、activation の後の再起動で restricted のまま始まることを固定する。
//
// 実 Native の addon が要るので `vitest.electron-native.config.ts` だけが拾う。
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../shared/ipcContract.js";

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: vi.fn(async () => {
      throw new Error("the product dialog must not be shown in this spec");
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: () => [],
  },
}));

const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
const { Backend } = require(ADDON) as {
  Backend: new (appData: string) => NapiBackendLike & Record<string, any>;
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newAppData(stateFile?: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-da2-state-"));
  roots.push(root);
  const appData = path.join(root, "app-data");
  mkdirSync(appData, { recursive: true });
  if (stateFile !== undefined) {
    writeFileSync(path.join(appData, "profile-egress.json"), stateFile);
  }
  return appData;
}

async function startGate(appData: string) {
  vi.resetModules();
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const support = await import("./profileActivation.test.support.js");
  const backend = new Backend(appData);
  const gate = await createProfileEgressGate(backend);
  return { backend, gate, support };
}

const P = "6f0e2a8e-3c1f-4d1b-9c0b-0c7d1d2e3f40";
/** The rows of K3/2 "起動時の gate" that Native accepts (1 to 5). */
const ROWS: ReadonlyArray<
  readonly [name: string, file: string | undefined, restricted: boolean]
> = [
  ["1: no file", undefined, false],
  [
    "2: restricted v2, stopped",
    `{"schemaVersion":2,"profileId":"${P}","callerEpoch":4,"restricted":true,"handlesInvalidated":true,"inFlightStopped":true}`,
    true,
  ],
  [
    "2: restricted v2, stop unconfirmed",
    `{"schemaVersion":2,"profileId":"${P}","callerEpoch":4,"restricted":true,"handlesInvalidated":true,"inFlightStopped":false}`,
    true,
  ],
  [
    "3: restricted v1",
    `{"schemaVersion":1,"profileId":"${P}","callerEpoch":4,"restricted":true}`,
    true,
  ],
  [
    "3: restricted v2 without bits",
    `{"schemaVersion":2,"profileId":"${P}","callerEpoch":4,"restricted":true}`,
    true,
  ],
  [
    "4: unrestricted v2 with odd bits (J-1)",
    `{"schemaVersion":2,"profileId":"${P}","callerEpoch":4,"restricted":false,"handlesInvalidated":true,"inFlightStopped":false}`,
    false,
  ],
  [
    "4: unrestricted v1 (J-1)",
    `{"schemaVersion":1,"profileId":"${P}","callerEpoch":4,"restricted":false}`,
    false,
  ],
  ["5: broken JSON", "{not json", true],
  [
    "5: unknown schema",
    `{"schemaVersion":9,"profileId":"${P}","callerEpoch":4,"restricted":false}`,
    true,
  ],
];

describe("the state file acceptance table, Main and Native together (Negative (16))", () => {
  it.each(ROWS)(
    "state file acceptance table matches Native: %s",
    async (_name, file, restricted) => {
      const appData = newAppData(file);
      const before =
        file === undefined
          ? null
          : readFileSync(path.join(appData, "profile-egress.json"), "utf8");
      const { gate } = await startGate(appData);
      // Native accepted the row (its admission is open), so Main is not
      // unavailable either.
      expect(gate.unavailable).toBe(false);
      expect(gate.restricted).toBe(restricted);
      expect(gate.statusView!()).toEqual({
        state: restricted ? "restricted" : "unrestricted",
      });
      // J-1: an unrestricted row is read, never rewritten.
      if (!restricted && before !== null) {
        expect(
          readFileSync(path.join(appData, "profile-egress.json"), "utf8"),
        ).toBe(before);
      }
    },
  );

  it("row 6: an unreadable state file fails the Backend with the closed code and no path", () => {
    const appData = newAppData();
    mkdirSync(path.join(appData, "profile-egress.json"));
    let message = "";
    try {
      new Backend(appData);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(
      /PROFILE_EGRESS_UNAVAILABLE:state-file-unreadable/u,
    );
    expect(message).not.toContain(appData);
  });
});

describe("the request through Main with the real addon", () => {
  it("before PUB-G the request is not-activated and nothing changes (A-1, Negative (4))", async () => {
    const appData = newAppData();
    const { backend, gate, support } = await startGate(appData);
    const confirm = vi.fn(support.approveWithCheckbox);
    const result = await support.activateThroughMain(backend, gate, {
      openGate: false,
      confirm,
    });
    expect(result).toEqual({ status: "not-activated" });
    expect(confirm).not.toHaveBeenCalled();
    expect(gate.restricted).toBe(false);
    expect(gate.statusView!()).toEqual({ state: "unrestricted" });
    expect(() => statSync(path.join(appData, "profile-egress.json"))).toThrow();
  });

  it("a cancelled dialog closes nothing and leaves no state file", async () => {
    const appData = newAppData();
    const { backend, gate, support } = await startGate(appData);
    const result = await support.activateThroughMain(backend, gate, {
      confirm: async () => ({ response: 1, checkboxChecked: false }),
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(gate.restricted).toBe(false);
    expect(() => statSync(path.join(appData, "profile-egress.json"))).toThrow();
    // The slot is free again: the next request reaches the dialog.
    await expect(
      support.activateThroughMain(backend, gate, { openGate: false }),
    ).resolves.toEqual({ status: "activated" });
  });

  it("restart after the activation: restricted from the start, and the request is already-restricted (Recovery (4))", async () => {
    const appData = newAppData();
    const first = await startGate(appData);
    await expect(
      first.support.activateThroughMain(first.backend, first.gate),
    ).resolves.toEqual({ status: "activated" });
    const state = JSON.parse(
      readFileSync(path.join(appData, "profile-egress.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(state).toMatchObject({
      schemaVersion: 2,
      restricted: true,
      handlesInvalidated: true,
      inFlightStopped: true,
    });

    const restarted = await startGate(appData);
    expect(restarted.gate.restricted).toBe(true);
    expect(restarted.gate.unavailable).toBe(false);
    await expect(
      restarted.support.activateThroughMain(restarted.backend, restarted.gate),
    ).resolves.toEqual({ status: "already-restricted" });
  });
});
