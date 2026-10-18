// CB-2 / S3 F7: the evaluation CI seam of the body declaration.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock("electron", () => ({
  dialog: { showMessageBox: mocks.showMessageBox },
}));

const {
  BODY_DECLARATION_CI_GATE_ENTRY,
  BODY_DECLARATION_CI_NONCE_ENV,
  BODY_DECLARATION_CI_OWNER_TOKEN,
  BODY_DECLARATION_CI_OWNER_TOKEN_ENV,
  BODY_DECLARATION_CI_RECEIPT_MAX_BYTES,
  BODY_DECLARATION_CI_RECEIPT_MAX_DIGESTS,
  bodyDeclarationCiNonceDigest,
  bodyDeclarationCiReceiptPath,
  parseBodyDeclarationCiSeam,
  startBodyDeclarationCiSeam,
} = await import("./bodyDeclarationCiSeam.js");
const { createMainGrantController } = await import("./mainGrant.js");

const NONCE = "3f9a8f0e-5b6c-4d7e-8a9b-0c1d2e3f4a5b";
const launchEnv = (
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv => ({
  CI: "true",
  [BODY_DECLARATION_CI_OWNER_TOKEN_ENV]: BODY_DECLARATION_CI_OWNER_TOKEN,
  [BODY_DECLARATION_CI_NONCE_ENV]: NONCE,
  ...overrides,
});

let userData: string;
beforeEach(async () => {
  mocks.showMessageBox.mockReset();
  userData = await mkdtemp(path.join(tmpdir(), "body-declaration-seam-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("parseBodyDeclarationCiSeam", () => {
  it("is active only for an unpackaged CI=true launch with the exact token and a UUIDv4 nonce", () => {
    expect(
      parseBodyDeclarationCiSeam(launchEnv(), { isPackaged: false }),
    ).toEqual({ active: true, nonce: NONCE });
  });

  const inactive: Array<[string, NodeJS.ProcessEnv, boolean]> = [
    ["packaged", launchEnv(), true],
    ["CI absent", launchEnv({ CI: undefined }), false],
    ["CI is not exactly true", launchEnv({ CI: "1" }), false],
    ["CI is True", launchEnv({ CI: "True" }), false],
    [
      "owner token absent",
      launchEnv({ [BODY_DECLARATION_CI_OWNER_TOKEN_ENV]: undefined }),
      false,
    ],
    [
      "owner token differs",
      launchEnv({ [BODY_DECLARATION_CI_OWNER_TOKEN_ENV]: "other" }),
      false,
    ],
    [
      "owner token has a suffix",
      launchEnv({
        [BODY_DECLARATION_CI_OWNER_TOKEN_ENV]: `${BODY_DECLARATION_CI_OWNER_TOKEN} `,
      }),
      false,
    ],
    [
      "the maintenance seam's token is not accepted",
      launchEnv({
        [BODY_DECLARATION_CI_OWNER_TOKEN_ENV]: "c2-5b-product-journey-owner-v1",
      }),
      false,
    ],
    [
      "nonce absent",
      launchEnv({ [BODY_DECLARATION_CI_NONCE_ENV]: undefined }),
      false,
    ],
    [
      "nonce is not a UUID",
      launchEnv({ [BODY_DECLARATION_CI_NONCE_ENV]: "nonce" }),
      false,
    ],
    [
      "nonce is a UUIDv1",
      launchEnv({
        [BODY_DECLARATION_CI_NONCE_ENV]: "3f9a8f0e-5b6c-1d7e-8a9b-0c1d2e3f4a5b",
      }),
      false,
    ],
    [
      "nonce has a bad variant",
      launchEnv({
        [BODY_DECLARATION_CI_NONCE_ENV]: "3f9a8f0e-5b6c-4d7e-ca9b-0c1d2e3f4a5b",
      }),
      false,
    ],
  ];
  for (const [name, env, isPackaged] of inactive) {
    it(`is inactive when ${name}`, () => {
      expect(parseBodyDeclarationCiSeam(env, { isPackaged })).toEqual({
        active: false,
      });
    });
  }
});

function fakeBackend() {
  return { mainOpenPrePublicationGate: vi.fn() };
}

describe("startBodyDeclarationCiSeam", () => {
  it("leaves the gate closed for every inactive launch", async () => {
    for (const [env, isPackaged] of [
      [launchEnv({ CI: undefined }), false],
      [launchEnv(), true],
      [launchEnv({ [BODY_DECLARATION_CI_NONCE_ENV]: "x" }), false],
    ] as const) {
      const backend = fakeBackend();
      const handle = await startBodyDeclarationCiSeam({
        seam: parseBodyDeclarationCiSeam(env, { isPackaged }),
        backend,
        isPackaged,
        userDataDir: userData,
      });
      expect(handle).toBeNull();
      expect(backend.mainOpenPrePublicationGate).not.toHaveBeenCalled();
    }
    expect(await readdir(userData)).toEqual([]);
  });

  it("never starts for a packaged launch whatever the seam says", async () => {
    const backend = fakeBackend();
    const handle = await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend,
      isPackaged: true,
      userDataDir: userData,
    });
    expect(handle).toBeNull();
    expect(backend.mainOpenPrePublicationGate).not.toHaveBeenCalled();
  });

  it("opens only the body declaration entry, once, and records a receipt without the nonce", async () => {
    const backend = fakeBackend();
    const handle = await startBodyDeclarationCiSeam({
      seam: parseBodyDeclarationCiSeam(launchEnv(), { isPackaged: false }),
      backend,
      isPackaged: false,
      userDataDir: userData,
    });
    expect(handle).not.toBeNull();
    expect(backend.mainOpenPrePublicationGate).toHaveBeenCalledExactlyOnceWith(
      BODY_DECLARATION_CI_GATE_ENTRY,
    );
    expect(handle?.receiptPath).toBe(
      bodyDeclarationCiReceiptPath(userData, NONCE),
    );
    const text = await readFile(handle!.receiptPath, "utf8");
    expect(text).not.toContain(NONCE);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      BODY_DECLARATION_CI_RECEIPT_MAX_BYTES,
    );
    expect(JSON.parse(text)).toEqual({
      version: 1,
      type: "grimodex:body-declaration-ci-receipt",
      seamVersion: 1,
      envNames: {
        ci: "CI",
        ownerToken: BODY_DECLARATION_CI_OWNER_TOKEN_ENV,
        nonce: BODY_DECLARATION_CI_NONCE_ENV,
      },
      nonceDigest: bodyDeclarationCiNonceDigest(NONCE),
      isPackaged: false,
      gateEntry: "scene-body-declaration",
      gateOpened: true,
      approvedGrantKinds: ["body-declaration"],
      approvedGrantCount: 0,
      approvedBindingDigests: [],
    });
    // The receipt directory is named by the nonce's digest, not the nonce.
    const root = path.dirname(path.dirname(handle!.receiptPath));
    expect(await readdir(root)).toEqual([
      path.basename(path.dirname(handle!.receiptPath)),
    ]);
    expect(path.basename(path.dirname(handle!.receiptPath))).not.toBe(NONCE);
  });

  it("does not start when the gate cannot be opened", async () => {
    const backend = {
      mainOpenPrePublicationGate: vi.fn(() => {
        throw new Error("MAIN_GATE_KIND");
      }),
    };
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handle = await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend,
      isPackaged: false,
      userDataDir: userData,
    });
    expect(handle).toBeNull();
    error.mockRestore();
  });

  it("does not open the gate when the first receipt cannot be written", async () => {
    const backend = fakeBackend();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handle = await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend,
      isPackaged: false,
      userDataDir: path.join(userData, "missing", "nowhere"),
    });
    expect(handle).toBeNull();
    expect(backend.mainOpenPrePublicationGate).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("records that it is about to open the gate before it opens it", async () => {
    const order: string[] = [];
    const backend = {
      mainOpenPrePublicationGate: vi.fn(() => {
        order.push("open");
        const receipt = readFileSync(
          bodyDeclarationCiReceiptPath(userData, NONCE),
          "utf8",
        );
        order.push(`receipt-gateOpened-${JSON.parse(receipt).gateOpened}`);
      }),
    };
    await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend,
      isPackaged: false,
      userDataDir: userData,
    });
    expect(order).toEqual(["open", "receipt-gateOpened-false"]);
  });

  it("refuses every approval when the receipt that says the gate opened cannot be written", async () => {
    const backend = {
      mainOpenPrePublicationGate: vi.fn(() => {
        // Make the second write fail: replace the receipt directory by a file.
        const dir = path.dirname(bodyDeclarationCiReceiptPath(userData, NONCE));
        rmSync(dir, { recursive: true, force: true });
        writeFileSync(dir, "x");
      }),
    };
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handle = await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend,
      isPackaged: false,
      userDataDir: userData,
    });
    expect(backend.mainOpenPrePublicationGate).toHaveBeenCalledOnce();
    expect(handle).not.toBeNull();
    expect(
      await handle!.confirm({
        kind: "body-declaration",
        display: "D",
        win: {
          id: 1,
          isDestroyed: () => false,
          on: () => 0,
          removeListener: () => 0,
        },
        senderId: 7,
        windowId: 1,
        approvalDigest: "a".repeat(64),
        signal: new AbortController().signal,
      }),
    ).toBe(false);
    error.mockRestore();
  });

  it("approves body-declaration only, and records each approval before it is given", async () => {
    const handle = (await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend: fakeBackend(),
      isPackaged: false,
      userDataDir: userData,
    }))!;
    const base = {
      display: "D",
      win: {
        id: 1,
        isDestroyed: () => false,
        on: () => 0,
        removeListener: () => 0,
      },
      senderId: 7,
      windowId: 1,
      signal: new AbortController().signal,
    };
    // A kind this seam does not know (ProfileActivation, for one) is refused.
    expect(
      await handle.confirm({
        ...base,
        kind: "profile-activation" as never,
        approvalDigest: "x".repeat(64),
      }),
    ).toBe(false);
    expect(
      JSON.parse(await readFile(handle.receiptPath, "utf8")).approvedGrantCount,
    ).toBe(0);

    for (let i = 1; i <= BODY_DECLARATION_CI_RECEIPT_MAX_DIGESTS + 4; i += 1) {
      const digest = i.toString(16).padStart(64, "0");
      expect(
        await handle.confirm({
          ...base,
          kind: "body-declaration",
          approvalDigest: digest,
        }),
      ).toBe(true);
      const receipt = JSON.parse(
        await readFile(handle.receiptPath, "utf8"),
      ) as {
        approvedGrantCount: number;
        approvedBindingDigests: string[];
      };
      expect(receipt.approvedGrantCount).toBe(i);
      expect(receipt.approvedBindingDigests.at(-1)).toBe(digest);
      expect(receipt.approvedBindingDigests.length).toBeLessThanOrEqual(
        BODY_DECLARATION_CI_RECEIPT_MAX_DIGESTS,
      );
    }
    const dir = path.dirname(handle.receiptPath);
    expect(await readdir(dir)).toEqual(["receipt.json"]);
  });

  it("refuses the approval when the receipt cannot be written", async () => {
    const handle = (await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend: fakeBackend(),
      isPackaged: false,
      userDataDir: userData,
    }))!;
    await rm(userData, { recursive: true, force: true });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      await handle.confirm({
        kind: "body-declaration",
        display: "D",
        win: {
          id: 1,
          isDestroyed: () => false,
          on: () => 0,
          removeListener: () => 0,
        },
        senderId: 7,
        windowId: 1,
        approvalDigest: "a".repeat(64),
        signal: new AbortController().signal,
      }),
    ).toBe(false);
    error.mockRestore();
  });
});

describe("the seam through Main's confirmation", () => {
  it("replaces the dialog's display and press, and nothing else of the product path", async () => {
    const handle = (await startBodyDeclarationCiSeam({
      seam: { active: true, nonce: NONCE },
      backend: fakeBackend(),
      isPackaged: false,
      userDataDir: userData,
    }))!;
    const backend = {
      mainGrantPreview: vi.fn(async () =>
        JSON.stringify({ previewId: "p", display: "D", expiresInMs: 60_000 }),
      ),
      mainGrantIssue: vi.fn(async () => JSON.stringify({ grantId: "g" })),
      mainGrantRevoke: vi.fn(),
      mainGrantRevokeSender: vi.fn(),
    };
    const controller = createMainGrantController({
      backend: backend as unknown as NapiBackendLike,
      confirm: handle.confirm,
    });
    const listeners = { on: () => 0, removeListener: () => 0 };
    const dispatch = vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        value: { outcome: "declared" },
      }),
    );
    const env = await controller.run({
      command: "narrative_scene_body_declaration_declare",
      sender: { id: 7, isDestroyed: () => false, ...listeners },
      win: { id: 3, isDestroyed: () => false, ...listeners },
      args: { expectedWorkspacePath: "/w", payload: {} },
      dispatch,
    });
    expect(env).toEqual({ ok: true, value: { outcome: "declared" } });
    // No product dialog was shown, but Native's preview and issue ran.
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(backend.mainGrantPreview).toHaveBeenCalledTimes(1);
    expect(backend.mainGrantIssue).toHaveBeenCalledWith("p", 7, 3);
    const receipt = JSON.parse(await readFile(handle.receiptPath, "utf8")) as {
      approvedGrantCount: number;
    };
    expect(receipt.approvedGrantCount).toBe(1);
  });
});
