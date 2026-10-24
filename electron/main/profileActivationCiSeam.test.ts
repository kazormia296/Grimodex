/**
 * The profile activation's journey seam (a) (DA-2 DR-DA2-10; K3/2 "公開" (a),
 * Negative (12); P3-2, P3-4).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  parseProfileActivationCiSeam,
  PROFILE_ACTIVATION_CI_GATE_ENTRY,
  PROFILE_ACTIVATION_CI_NONCE_ENV,
  PROFILE_ACTIVATION_CI_OWNER_TOKEN,
  PROFILE_ACTIVATION_CI_OWNER_TOKEN_ENV,
  PROFILE_ACTIVATION_CI_RESPONSE_ENV,
  startProfileActivationCiSeam,
} from "./profileActivationCiSeam.js";
import {
  BODY_DECLARATION_CI_NONCE_ENV,
  BODY_DECLARATION_CI_OWNER_TOKEN,
  BODY_DECLARATION_CI_OWNER_TOKEN_ENV,
  parseBodyDeclarationCiSeam,
  startBodyDeclarationCiSeam,
} from "./bodyDeclarationCiSeam.js";
import { fakeGrantWindow } from "./profileActivation.test.support.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const USER_DATA = path.resolve("/tmp/grimodex-journey-user-data");
/** The development and product directories of an ordinary launch (R-3). */
const DEV_USER_DATA = path.resolve("/home/user/.config/GrimodexElectronDev");
const PRODUCT_USER_DATA = path.resolve(
  "/home/user/.local/share/com.miyakey.grimodex",
);
const DEFAULT_USER_DATA_DIRS = [DEV_USER_DATA, PRODUCT_USER_DATA] as const;
const NONCE = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    CI: "true",
    [PROFILE_ACTIVATION_CI_OWNER_TOKEN_ENV]: PROFILE_ACTIVATION_CI_OWNER_TOKEN,
    [PROFILE_ACTIVATION_CI_NONCE_ENV]: NONCE,
    [PROFILE_ACTIVATION_CI_RESPONSE_ENV]: "approve",
    GRIMODEX_USER_DATA_DIR: USER_DATA,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function confirmation(kind: string, signal = new AbortController().signal) {
  return {
    kind,
    display: {
      title: "t",
      message: "m",
      detail: "d",
      checkboxLabel: "c",
      buttons: ["取消", "有効にする"],
      defaultId: 0,
      cancelId: 0,
    },
    win: fakeGrantWindow(1),
    senderId: 1,
    windowId: 1,
    displayDigest: "sha256:x",
    signal,
  } as never;
}

describe("parseProfileActivationCiSeam", () => {
  it("is active only with the exact environment and the journey's userData", () => {
    expect(
      parseProfileActivationCiSeam(env(), {
        isPackaged: false,
        userDataDir: USER_DATA,
        defaultUserDataDirs: DEFAULT_USER_DATA_DIRS,
      }),
    ).toEqual({ active: true, nonce: NONCE, response: "approve" });
  });

  it.each([
    ["packaged", env(), true, USER_DATA],
    ["CI is not exactly true", env({ CI: "1" }), false, USER_DATA],
    ["no CI", env({ CI: undefined }), false, USER_DATA],
    [
      "another owner token",
      env({
        [PROFILE_ACTIVATION_CI_OWNER_TOKEN_ENV]:
          BODY_DECLARATION_CI_OWNER_TOKEN,
      }),
      false,
      USER_DATA,
    ],
    [
      "a nonce that is not a UUIDv4",
      env({ [PROFILE_ACTIVATION_CI_NONCE_ENV]: "x" }),
      false,
      USER_DATA,
    ],
    [
      "an unknown response",
      env({ [PROFILE_ACTIVATION_CI_RESPONSE_ENV]: "yes" }),
      false,
      USER_DATA,
    ],
    [
      "no response",
      env({ [PROFILE_ACTIVATION_CI_RESPONSE_ENV]: undefined }),
      false,
      USER_DATA,
    ],
    [
      "no journey userData (P3-4)",
      env({ GRIMODEX_USER_DATA_DIR: undefined }),
      false,
      USER_DATA,
    ],
    [
      "a relative journey userData",
      env({ GRIMODEX_USER_DATA_DIR: "rel/dir" }),
      false,
      USER_DATA,
    ],
    [
      "another userData than the launch uses",
      env(),
      false,
      "/home/user/.config/GrimodexElectronDev",
    ],
    [
      "the override names the development data directory (R-3)",
      env({ GRIMODEX_USER_DATA_DIR: DEV_USER_DATA }),
      false,
      DEV_USER_DATA,
    ],
    [
      "the override names the product data directory (R-3)",
      env({ GRIMODEX_USER_DATA_DIR: `${PRODUCT_USER_DATA}/` }),
      false,
      PRODUCT_USER_DATA,
    ],
  ] as const)(
    "is inert when %s (Negative (12))",
    (_name, launchEnv, isPackaged, userDataDir) => {
      expect(
        parseProfileActivationCiSeam(launchEnv, {
          isPackaged,
          userDataDir,
          defaultUserDataDirs: DEFAULT_USER_DATA_DIRS,
        }),
      ).toEqual({ active: false });
    },
  );

  it("is inert when the default directories are not a list of paths (R-3)", () => {
    for (const defaultUserDataDirs of [
      undefined,
      "not-a-list",
      [42],
    ] as unknown as readonly string[][]) {
      expect(
        parseProfileActivationCiSeam(env(), {
          isPackaged: false,
          userDataDir: USER_DATA,
          defaultUserDataDirs,
        }),
      ).toEqual({ active: false });
    }
  });
});

describe("startProfileActivationCiSeam", () => {
  const active = {
    active: true,
    nonce: NONCE,
    response: "approve",
  } as const;

  it("opens the one entry once and approves the profile activation only", async () => {
    const mainOpenPrePublicationGate = vi.fn();
    const handle = startProfileActivationCiSeam({
      seam: active,
      backend: { mainOpenPrePublicationGate },
      isPackaged: false,
    });
    expect(mainOpenPrePublicationGate.mock.calls).toEqual([
      [PROFILE_ACTIVATION_CI_GATE_ENTRY],
    ]);
    expect(PROFILE_ACTIVATION_CI_GATE_ENTRY).toBe("profile-activation");
    await expect(
      handle!.confirm(confirmation("profile-activation")),
    ).resolves.toEqual({
      response: 1,
      checkboxChecked: true,
    });
    // Another kind is refused, never approved (P3-2).
    await expect(
      handle!.confirm(confirmation("body-declaration")),
    ).resolves.toEqual({
      response: 0,
      checkboxChecked: false,
    });
  });

  it("cancel refuses; timeout answers only when the preview's time runs out", async () => {
    const backend = { mainOpenPrePublicationGate: vi.fn() };
    const cancel = startProfileActivationCiSeam({
      seam: { ...active, response: "cancel" },
      backend,
      isPackaged: false,
    });
    await expect(
      cancel!.confirm(confirmation("profile-activation")),
    ).resolves.toEqual({
      response: 0,
      checkboxChecked: false,
    });
    const timeout = startProfileActivationCiSeam({
      seam: { ...active, response: "timeout" },
      backend,
      isPackaged: false,
    });
    // L-7: no wall clock. However long the time runs, the seam answers only
    // when the preview's abort arrives, and it keeps no timer of its own.
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      let settled = false;
      const answer = timeout!
        .confirm(confirmation("profile-activation", abort.signal))
        .then((value) => {
          settled = true;
          return value;
        });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      abort.abort();
      await expect(answer).resolves.toEqual({
        response: 0,
        checkboxChecked: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout answers at once when the preview was already aborted", async () => {
    const timeout = startProfileActivationCiSeam({
      seam: { ...active, response: "timeout" },
      backend: { mainOpenPrePublicationGate: vi.fn() },
      isPackaged: false,
    });
    const abort = new AbortController();
    abort.abort();
    const answer = timeout!.confirm(
      confirmation("profile-activation", abort.signal),
    );
    await expect(answer).resolves.toEqual({
      response: 0,
      checkboxChecked: false,
    });
  });

  it("never starts packaged or inactive, and never touches the backend then", () => {
    const mainOpenPrePublicationGate = vi.fn();
    expect(
      startProfileActivationCiSeam({
        seam: active,
        backend: { mainOpenPrePublicationGate },
        isPackaged: true,
      }),
    ).toBeNull();
    expect(
      startProfileActivationCiSeam({
        seam: { active: false },
        backend: { mainOpenPrePublicationGate },
        isPackaged: false,
      }),
    ).toBeNull();
    expect(mainOpenPrePublicationGate).not.toHaveBeenCalled();
  });

  it("is not started when the entry cannot be opened", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      startProfileActivationCiSeam({
        seam: active,
        backend: {
          mainOpenPrePublicationGate: () => {
            throw new Error("unknown entry");
          },
        },
        isPackaged: false,
      }),
    ).toBeNull();
  });
});

describe("the two seams each refuse the other's kind (P3-2)", () => {
  it("the body declaration seam does not approve a profile activation", async () => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "grimodex-seams-")),
    );
    roots.push(root);
    const seam = parseBodyDeclarationCiSeam(
      {
        CI: "true",
        [BODY_DECLARATION_CI_OWNER_TOKEN_ENV]: BODY_DECLARATION_CI_OWNER_TOKEN,
        [BODY_DECLARATION_CI_NONCE_ENV]: NONCE,
      },
      { isPackaged: false },
    );
    const handle = await startBodyDeclarationCiSeam({
      seam,
      backend: { mainOpenPrePublicationGate: vi.fn() },
      isPackaged: false,
      userDataDir: root,
    });
    await expect(
      handle!.confirm({
        kind: "profile-activation",
      } as never),
    ).resolves.toBe(false);
  });
});
