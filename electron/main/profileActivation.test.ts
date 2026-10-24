/**
 * Main's profile activation (NIR-1 DA-2 ST2; K3/2 "Main の確認" 1 to 6 and
 * "順序と起動時の gate"; DR-DA2-16 and DR-DA2-17). The backend is a mock of
 * the Main-only N-API; the real addon runs in `*.pipeline.spec.ts`.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../shared/ipcContract.js";

const dialogMock = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
}));
vi.mock("electron", () => ({ dialog: dialogMock }));

const {
  createProfileActivationController,
  createProfileEgressStatusNotifier,
  isProfileActivationApproved,
  parseProfileActivationDisplay,
  profileActivationDisplayDigest,
  profileActivationStatusForError,
  showProfileActivationDialog,
} = await import("./profileActivation.js");
const {
  createMainGrantController,
  createMainGrantInFlight,
  mainGrantErrorCode,
} = await import("./mainGrant.js");
const {
  consumeProfileActivation,
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
  PROFILE_EGRESS_PARTICIPANT_BOUND_MS,
} = await import("./profileEgress.js");
const { fakeGrantSender, fakeGrantWindow } =
  await import("./profileActivation.test.support.js");
const { nativeSqlPolicyV2 } = await import("./d2aSqlPolicyFixture.js");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DISPLAY = {
  title: "外部の AI を使わない設定を有効にしますか",
  message: "有効にすると…",
  detail: "1. 対象…\n8. 開示の版: 1",
  checkboxLabel: "アプリの操作では解除できないことを理解しました",
  buttons: ["取消", "有効にする"],
  defaultId: 0,
  cancelId: 0,
};

/** An independent copy of the canonical form (keys in UTF-16 order). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function nativeDigest(display: unknown, disclosureVersion = 1): string {
  return `sha256:${createHash("sha256")
    .update(
      canonical({
        domain: "grimodex/main-grant/v1/profile-activation/display",
        disclosureVersion,
        display,
      }),
      "utf8",
    )
    .digest("hex")}`;
}

const UNRESTRICTED = {
  profileId: "profile-1",
  callerEpoch: 4,
  restricted: false,
  handlesInvalidated: false,
  inFlightStopped: true,
  sqlPolicy: nativeSqlPolicyV2(),
};
const RESTRICTED = {
  ...UNRESTRICTED,
  profileId: "profile-1",
  callerEpoch: 5,
  restricted: true,
  handlesInvalidated: true,
};

interface MockNative {
  readonly backend: NapiBackendLike;
  readonly calls: string[];
  readonly fns: Record<string, ReturnType<typeof vi.fn>>;
}

function mockNative(
  options: {
    preview?: () => Promise<string>;
    /** The display Native's own constant holds (what issue checks). */
    nativeDisplay?: unknown;
    issueError?: string;
    consumeError?: string;
    commit?: () => Promise<string>;
    /** Native's stop request for the AI in flight (DR-DA2-24). */
    abortInFlight?: () => boolean;
    initial?: Record<string, unknown>;
  } = {},
): MockNative {
  const calls: string[] = [];
  const fns = {
    profileActivationPreview: vi.fn(
      options.preview ??
        (async () => {
          calls.push("preview");
          return JSON.stringify({
            previewId: "preview-ID-SENTINEL",
            display: DISPLAY,
            disclosureVersion: 1,
            expiresInMs: 60_000,
          });
        }),
    ),
    profileActivationIssue: vi.fn(
      async (
        _previewId: string,
        _senderId: number,
        _windowId: number,
        digest: string,
      ) => {
        calls.push("issue");
        if (options.issueError) throw new Error(options.issueError);
        if (digest !== nativeDigest(options.nativeDisplay ?? DISPLAY)) {
          throw new Error("PROFILE_ACTIVATION_REFUSED:display-mismatch");
        }
        return JSON.stringify({ grantId: "grant-ID-SENTINEL" });
      },
    ),
    profileActivationConsume: vi.fn(() => {
      calls.push("consume");
      if (options.consumeError) throw new Error(options.consumeError);
    }),
    profileActivationCommit: vi.fn(
      options.commit ??
        (async () => {
          calls.push("commit");
          return JSON.stringify(RESTRICTED);
        }),
    ),
    profileActivationAbortInFlight: vi.fn(
      options.abortInFlight ??
        (() => {
          calls.push("abort-in-flight");
          return true;
        }),
    ),
    mainGrantRevoke: vi.fn(),
    mainGrantRevokeSender: vi.fn(),
    mainGrantPreview: vi.fn(async () =>
      JSON.stringify({ previewId: "p", display: "d", expiresInMs: 60_000 }),
    ),
    mainGrantIssue: vi.fn(),
  };
  const backend = {
    initializeProfileEgress: async () =>
      JSON.stringify(options.initial ?? UNRESTRICTED),
    registerProfileEgressCaller: vi.fn(),
    invalidateProfileEgressCallers: vi.fn(),
    ...fns,
  } as unknown as NapiBackendLike;
  return { backend, calls, fns };
}

const approve = async () => ({ response: 1, checkboxChecked: true });

async function rig(
  native: MockNative,
  {
    confirm = approve,
    participantBoundMs,
    inFlight,
  }: {
    confirm?: Parameters<
      typeof createProfileActivationController
    >[0]["confirm"];
    participantBoundMs?: number;
    inFlight?: ReturnType<typeof createMainGrantInFlight>;
  } = {},
) {
  const gate = await createProfileEgressGate(native.backend, {
    participantBoundMs,
  });
  const views: unknown[] = [];
  gate.onStatusChange!((view) => views.push(view));
  const controller = createProfileActivationController({
    backend: native.backend,
    gate,
    confirm,
    inFlight,
  });
  const sender = fakeGrantSender(7);
  const win = fakeGrantWindow(3);
  const request = (
    overrides: Partial<Parameters<typeof controller.request>[0]> = {},
  ) =>
    controller.request({
      sender,
      win,
      callerIdentity: gate.issueCallerIdentity(sender.id),
      ...overrides,
    });
  return { gate, views, controller, sender, win, request };
}

describe("the request runs stages 1 to 7 once, in order (Positive (3))", () => {
  it("runs stages 1..7 once in order", async () => {
    const native = mockNative();
    const r = await rig(native);
    const order: string[] = [];
    r.gate.onStatusChange!((view) => order.push(`state:${view.state}`));
    native.fns.profileActivationConsume!.mockImplementation(() => {
      native.calls.push("consume");
      // Stage 1 runs before stage 2 closes anything.
      expect(r.gate.restricted).toBe(false);
    });

    await expect(r.request()).resolves.toEqual({ status: "activated" });
    expect(native.calls).toEqual(["preview", "issue", "consume", "commit"]);
    expect(r.views).toEqual([{ state: "activating" }, { state: "restricted" }]);
    expect(order).toEqual(["state:activating", "state:restricted"]);
    expect(r.gate.restricted).toBe(true);
    expect(r.gate.unavailable).toBe(false);
    expect(r.gate.statusView!()).toEqual({ state: "restricted" });
    // The consumed grant is not revoked.
    expect(native.fns.mainGrantRevoke).not.toHaveBeenCalled();
    expect(native.fns.mainGrantRevokeSender).not.toHaveBeenCalled();
    // Stage 7: the next identity is issued at the new epoch.
    expect(r.gate.issueCallerIdentity(7).callerEpoch).toBe(5);
  });

  it("stage 2 follows stage 1 in the same JS task", async () => {
    const native = mockNative();
    const r = await rig(native);
    let restrictedAfterConsume: boolean | null = null;
    native.fns.profileActivationConsume!.mockImplementation(() => {
      queueMicrotask(() => {
        restrictedAfterConsume = r.gate.restricted;
      });
    });
    await r.request();
    expect(restrictedAfterConsume).toBe(true);
  });

  it("binds the dialog text digest to the grant", async () => {
    const native = mockNative();
    const r = await rig(native);
    await r.request();
    const digest = native.fns.profileActivationIssue!.mock.calls[0]?.[3];
    expect(digest).toBe(nativeDigest(DISPLAY));
    expect(profileActivationDisplayDigest(DISPLAY as never, 1)).toBe(
      nativeDigest(DISPLAY),
    );
  });

  it("is refused when what Main showed differs from Native's text (P2-3)", async () => {
    const native = mockNative({
      nativeDisplay: { ...DISPLAY, detail: "Native's real disclosure" },
    });
    const r = await rig(native);
    await expect(r.request()).resolves.toEqual({ status: "refused" });
    expect(native.fns.profileActivationConsume).not.toHaveBeenCalled();
    expect(native.fns.mainGrantRevoke).toHaveBeenCalledWith(
      "preview-ID-SENTINEL",
    );
    expect(r.gate.restricted).toBe(false);
    expect(r.views).toEqual([]);
  });

  it("refuses a display outside the allowlist without a dialog", async () => {
    for (const display of [
      { ...DISPLAY, extra: "x" },
      { ...DISPLAY, defaultId: 1 },
      { ...DISPLAY, cancelId: 1 },
      { ...DISPLAY, buttons: ["only one"] },
      { ...DISPLAY, title: "" },
      "text",
    ]) {
      const native = mockNative({
        preview: async () =>
          JSON.stringify({
            previewId: "p",
            display,
            disclosureVersion: 1,
            expiresInMs: 60_000,
          }),
      });
      const confirm = vi.fn(approve);
      const r = await rig(native, { confirm });
      await expect(r.request()).resolves.toEqual({ status: "refused" });
      expect(confirm).not.toHaveBeenCalled();
      expect(native.fns.profileActivationIssue).not.toHaveBeenCalled();
    }
    expect(parseProfileActivationDisplay(DISPLAY)).toEqual(DISPLAY);
  });

  it("the product dialog shows Native's strings only, Cancel by default, the box unchecked", async () => {
    dialogMock.showMessageBox.mockResolvedValueOnce({
      response: 1,
      checkboxChecked: true,
    });
    const signal = new AbortController().signal;
    const answer = await showProfileActivationDialog({
      kind: "profile-activation",
      display: DISPLAY as never,
      win: fakeGrantWindow(3),
      senderId: 7,
      windowId: 3,
      displayDigest: nativeDigest(DISPLAY),
      signal,
    });
    expect(answer).toEqual({ response: 1, checkboxChecked: true });
    expect(dialogMock.showMessageBox).toHaveBeenCalledWith(expect.anything(), {
      type: "warning",
      title: DISPLAY.title,
      message: DISPLAY.message,
      detail: DISPLAY.detail,
      checkboxLabel: DISPLAY.checkboxLabel,
      checkboxChecked: false,
      buttons: DISPLAY.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal,
    });
  });

  it("approval needs both the approve button and the checked box", () => {
    expect(
      isProfileActivationApproved({ response: 1, checkboxChecked: true }),
    ).toBe(true);
    expect(
      isProfileActivationApproved({ response: 1, checkboxChecked: false }),
    ).toBe(false);
    expect(
      isProfileActivationApproved({ response: 0, checkboxChecked: true }),
    ).toBe(false);
  });
});

describe("refusals (Negative (4)(5))", () => {
  it.each([
    ["cancel", { response: 0, checkboxChecked: false }, "cancelled"],
    [
      "approve without the box",
      { response: 1, checkboxChecked: false },
      "cancelled",
    ],
    [
      "the box without approve",
      { response: 0, checkboxChecked: true },
      "cancelled",
    ],
  ] as const)("%s closes nothing", async (_name, answer, status) => {
    const native = mockNative();
    const r = await rig(native, { confirm: async () => answer });
    await expect(r.request()).resolves.toEqual({ status });
    expect(native.fns.profileActivationIssue).not.toHaveBeenCalled();
    expect(native.fns.profileActivationConsume).not.toHaveBeenCalled();
    expect(native.fns.mainGrantRevoke).toHaveBeenCalled();
    expect(r.gate.restricted).toBe(false);
    expect(r.views).toEqual([]);
  });

  it("refuses with typed codes in every state", async () => {
    // PUB-G closed: Native's gate refuses the preview → not-activated, no dialog.
    {
      const confirm = vi.fn(approve);
      const native = mockNative({
        preview: async () => {
          throw new Error("PROFILE_ACTIVATION_REFUSED:gate-closed");
        },
      });
      const r = await rig(native, { confirm });
      await expect(r.request()).resolves.toEqual({ status: "not-activated" });
      expect(confirm).not.toHaveBeenCalled();
    }
    // Already restricted.
    {
      const native = mockNative({ initial: RESTRICTED });
      const r = await rig(native);
      await expect(r.request()).resolves.toEqual({
        status: "already-restricted",
      });
      expect(native.fns.profileActivationPreview).not.toHaveBeenCalled();
    }
    // Unavailable gate.
    {
      const native = mockNative({
        initial: { ...UNRESTRICTED, sqlPolicy: null },
      });
      const r = await rig(native);
      expect(r.gate.unavailable).toBe(true);
      await expect(r.request()).resolves.toEqual({ status: "unavailable" });
    }
    // Activation in flight: a second request is busy, not queued.
    {
      let release!: (value: string) => void;
      const native = mockNative({
        commit: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      });
      const r = await rig(native);
      const first = r.request();
      await vi.waitFor(() => expect(r.gate.activating).toBe(true));
      await expect(r.request()).resolves.toEqual({ status: "busy" });
      release(JSON.stringify(RESTRICTED));
      await expect(first).resolves.toEqual({ status: "activated" });
    }
    // Native lifecycle / slot busy, expired at issue.
    for (const [error, status] of [
      ["PROFILE_ACTIVATION_REFUSED:lifecycle-busy", "busy"],
      ["MAIN_GRANT_BUSY", "busy"],
      ["PROFILE_ACTIVATION_REFUSED:already-restricted", "already-restricted"],
      ["PROFILE_EGRESS_UNAVAILABLE:state-file-unwritable", "unavailable"],
      ["MAIN_GRANT_MISMATCH", "refused"],
    ] as const) {
      const native = mockNative({
        preview: async () => {
          throw new Error(`${error}: /home/user/secret/path`);
        },
      });
      const r = await rig(native);
      await expect(r.request(), error).resolves.toEqual({ status });
    }
    {
      const native = mockNative({ issueError: "MAIN_GRANT_EXPIRED" });
      const r = await rig(native);
      await expect(r.request()).resolves.toEqual({ status: "expired" });
      expect(native.fns.profileActivationConsume).not.toHaveBeenCalled();
    }
  });

  it("refuses another sender's identity, a missing window and a destroyed sender", async () => {
    const native = mockNative();
    const r = await rig(native);
    const other = r.gate.issueCallerIdentity(99);
    await expect(r.request({ callerIdentity: other })).resolves.toEqual({
      status: "refused",
    });
    await expect(
      r.request({ callerIdentity: { ...r.gate.issueCallerIdentity(7) } }),
    ).resolves.toEqual({ status: "refused" });
    await expect(r.request({ callerIdentity: undefined })).resolves.toEqual({
      status: "refused",
    });
    await expect(r.request({ win: null })).resolves.toEqual({
      status: "refused",
    });
    r.sender.destroyed = true;
    await expect(r.request()).resolves.toEqual({ status: "refused" });
    expect(native.fns.profileActivationPreview).not.toHaveBeenCalled();
  });

  it("a sender gone or a window closed during the dialog revokes and closes nothing", async () => {
    for (const end of ["sender", "navigation", "window"] as const) {
      const native = mockNative();
      let r!: Awaited<ReturnType<typeof rig>>;
      r = await rig(native, {
        confirm: async () => {
          if (end === "sender") r.sender.emit("destroyed");
          if (end === "navigation")
            r.sender.emit("did-start-navigation", { isMainFrame: true });
          if (end === "window") r.win.emit("closed");
          return { response: 1, checkboxChecked: true };
        },
      });
      await expect(r.request(), end).resolves.toEqual({ status: "refused" });
      expect(native.fns.profileActivationIssue).not.toHaveBeenCalled();
      expect(native.fns.mainGrantRevokeSender).toHaveBeenCalledWith(7);
      expect(r.gate.restricted).toBe(false);
    }
  });

  it("the preview's time running out is expired, and the dialog is aborted", async () => {
    const native = mockNative({
      preview: async () =>
        JSON.stringify({
          previewId: "p",
          display: DISPLAY,
          disclosureVersion: 1,
          expiresInMs: 5,
        }),
    });
    const r = await rig(native, {
      confirm: (confirmation) =>
        new Promise((resolve) => {
          confirmation.signal.addEventListener("abort", () =>
            resolve({ response: 1, checkboxChecked: true }),
          );
        }),
    });
    await expect(r.request()).resolves.toEqual({ status: "expired" });
    expect(native.fns.profileActivationIssue).not.toHaveBeenCalled();
    expect(native.fns.mainGrantRevoke).toHaveBeenCalledWith("p");
  });

  it("a stage 1 refusal closes nothing", async () => {
    const native = mockNative({ consumeError: "MAIN_GRANT_STATE_CHANGED" });
    const r = await rig(native);
    await expect(r.request()).resolves.toEqual({ status: "refused" });
    expect(native.fns.profileActivationCommit).not.toHaveBeenCalled();
    expect(r.gate.restricted).toBe(false);
    expect(r.gate.unavailable).toBe(false);
    expect(r.views).toEqual([]);
  });

  it("never returns or emits preview or grant ids", async () => {
    const native = mockNative();
    const r = await rig(native);
    const result = await r.request();
    const visible = JSON.stringify([result, r.views, r.gate.statusView!()]);
    for (const secret of [
      "preview-ID-SENTINEL",
      "grant-ID-SENTINEL",
      "profile-1",
      '"callerEpoch"',
      "sha256:",
    ]) {
      expect(visible).not.toContain(secret);
    }
  });

  it("shares one in-flight confirmation with MG-1 (P3-2)", async () => {
    const inFlight = createMainGrantInFlight();
    let releaseDialog!: () => void;
    const native = mockNative();
    const r = await rig(native, {
      inFlight,
      confirm: () =>
        new Promise((resolve) => {
          releaseDialog = () =>
            resolve({ response: 0, checkboxChecked: false });
        }),
    });
    const mainGrant = createMainGrantController({
      backend: native.backend,
      inFlight,
      confirm: async () => true,
    });
    const pending = r.request();
    await vi.waitFor(() => expect(inFlight.held).toBe(true));
    const sender = fakeGrantSender(8);
    await expect(
      mainGrant.run({
        command: "narrative_scene_body_declaration_declare",
        sender,
        win: fakeGrantWindow(4),
        args: {},
        dispatch: async () => ({ ok: true, value: null }),
      }),
    ).resolves.toEqual({ ok: false, error: "MAIN_GRANT_BUSY" });
    releaseDialog();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(inFlight.held).toBe(false);

    // The other way round: a body declaration dialog makes the request busy.
    let releaseBody!: () => void;
    const bodyGrant = createMainGrantController({
      backend: native.backend,
      inFlight,
      confirm: () =>
        new Promise((resolve) => {
          releaseBody = () => resolve(false);
        }),
    });
    const body = bodyGrant.run({
      command: "narrative_scene_body_declaration_declare",
      sender: fakeGrantSender(9),
      win: fakeGrantWindow(5),
      args: {},
      dispatch: async () => ({ ok: true, value: null }),
    });
    await vi.waitFor(() => expect(inFlight.held).toBe(true));
    await expect(r.request()).resolves.toEqual({ status: "busy" });
    releaseBody();
    await body;
  });

  it("maps Native's closed codes and keeps nothing else of the message", () => {
    expect(
      mainGrantErrorCode(
        new Error("PROFILE_ACTIVATION_REFUSED:display-mismatch at /secret"),
      ),
    ).toBe("PROFILE_ACTIVATION_REFUSED:display-mismatch");
    expect(
      mainGrantErrorCode(
        new Error("PROFILE_EGRESS_UNAVAILABLE:barrier-timeout (path)"),
      ),
    ).toBe("PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
    expect(profileActivationStatusForError(new Error("anything"))).toBe(
      "refused",
    );
  });
});

describe("stages 2 to 7 on the gate (DR-DA2-17)", () => {
  async function unrestrictedGate(
    native = mockNative(),
    participantBoundMs?: number,
  ) {
    const gate = await createProfileEgressGate(native.backend, {
      participantBoundMs,
    });
    const views: unknown[] = [];
    gate.onStatusChange!((view) => views.push(view));
    const consumed = () =>
      consumeProfileActivation(native.backend, "grant", 7, 3);
    return { gate, views, consumed, native };
  }

  it("accepts only a token from the consume, once (Negative (6) on Main)", async () => {
    const { gate, consumed, native } = await unrestrictedGate();
    await expect(gate.beginProfileActivation!({} as never)).rejects.toThrow(
      /PROFILE_ACTIVATION_REFUSED:not-reserved/u,
    );
    expect(gate.restricted).toBe(false);
    const token = consumed();
    await expect(gate.beginProfileActivation!(token)).resolves.toEqual({
      state: "restricted",
    });
    await expect(gate.beginProfileActivation!(token)).rejects.toThrow(
      /not-reserved/u,
    );
    expect(native.fns.profileActivationCommit).toHaveBeenCalledOnce();
  });

  it("refuses new-class invokes during stages 2..7 with sync points (Negative (3))", async () => {
    let release!: (value: string) => void;
    const native = mockNative({
      commit: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const { gate, consumed } = await unrestrictedGate(native);
    const identity = gate.issueCallerIdentity(7);
    const activation = gate.beginProfileActivation!(consumed());
    // Sync point: stage 2 has run inside the call.
    expect(gate.activating).toBe(true);
    expect(gate.statusView!()).toEqual({ state: "activating" });
    for (const [command, args] of [
      ["related_scenes_begin", { callerIdentity: identity }],
      ["fts_search", { callerIdentity: identity }],
      ["send_chat_message", {}],
      ["send_inline_ai_stream", {}],
      ["nir1_pack_context", {}],
    ] as const) {
      expect(() => gate.assertInvoke(command, args), command).toThrow(
        new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`),
      );
    }
    // Results admitted before stage 2 are refused at completion.
    for (const command of [
      "send_chat_message",
      "send_inline_ai_stream",
      "list_ai_models",
      "nir1_pack_context",
    ]) {
      expect(
        () => gate.assertPlaintextPublication(command, {}),
        command,
      ).toThrow(/completed after profile restriction began/u);
    }
    expect(gate.allowsBackendEvent("chat:stream-chunk")).toBe(false);
    expect(() => gate.assertExternalUrl()).toThrow();
    // Still refused while Native's stages 4 and 5 run.
    await vi.waitFor(() =>
      expect(native.fns.profileActivationCommit).toHaveBeenCalledOnce(),
    );
    expect(() =>
      gate.assertInvoke("related_scenes_begin", { callerIdentity: identity }),
    ).toThrow(/being restricted|not issued/u);
    release(JSON.stringify(RESTRICTED));
    await expect(activation).resolves.toEqual({ state: "restricted" });
  });

  it("unrestricted keeps returning legacy AI results (no identity check added)", async () => {
    const { gate } = await unrestrictedGate();
    expect(() =>
      gate.assertPlaintextPublication("send_chat_message", {
        callerIdentity: { senderId: 1, stale: true },
      }),
    ).not.toThrow();
  });

  it("stage 3 bound: a participant that does not stop fails closed and is force-stopped", async () => {
    const native = mockNative();
    const { gate, views, consumed } = await unrestrictedGate(native, 20);
    const forceStop = vi.fn();
    const quickForceStop = vi.fn();
    gate.registerMainEgressParticipant(
      "stuck",
      () => new Promise(() => {}),
      forceStop,
    );
    gate.registerMainEgressParticipant("quick", async () => {}, quickForceStop);
    await expect(gate.beginProfileActivation!(consumed())).resolves.toEqual({
      state: "unavailable",
      reason: "participant-timeout",
    });
    expect(forceStop).toHaveBeenCalledOnce();
    expect(quickForceStop).not.toHaveBeenCalled();
    expect(native.fns.profileActivationCommit).not.toHaveBeenCalled();
    expect(gate.unavailable).toBe(true);
    expect(views).toEqual([
      { state: "activating" },
      { state: "unavailable", reason: "participant-timeout" },
    ]);
  });

  it("stage 3 bound: participants that stop inside the bound continue to stage 4", async () => {
    // L-7: fake timers and a participant released by hand, one tick before
    // the 30 s bound; no wall clock.
    vi.useFakeTimers();
    const native = mockNative();
    const { gate, consumed } = await unrestrictedGate(native);
    let stop!: () => void;
    gate.registerMainEgressParticipant(
      "slow-but-in-time",
      () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
    );
    const activation = gate.beginProfileActivation!(consumed());
    await vi.advanceTimersByTimeAsync(PROFILE_EGRESS_PARTICIPANT_BOUND_MS - 1);
    expect(gate.activating).toBe(true);
    expect(native.fns.profileActivationCommit).not.toHaveBeenCalled();
    stop();
    await expect(activation).resolves.toEqual({ state: "restricted" });
    expect(native.fns.profileActivationCommit).toHaveBeenCalledOnce();
    expect(native.fns.profileActivationAbortInFlight).not.toHaveBeenCalled();
    // The bound's timer was cleared: nothing fires after it.
    await vi.advanceTimersByTimeAsync(PROFILE_EGRESS_PARTICIPANT_BOUND_MS);
    expect(gate.statusView!()).toEqual({ state: "restricted" });
  });

  it("the stage 3 bound is 30 s and a longer test value is cut to it", async () => {
    expect(PROFILE_EGRESS_PARTICIPANT_BOUND_MS).toBe(30_000);
    vi.useFakeTimers();
    const native = mockNative();
    const gate = await createProfileEgressGate(native.backend, {
      participantBoundMs: 10 * 60_000,
    });
    gate.registerMainEgressParticipant("stuck", () => new Promise(() => {}));
    const activation = gate.beginProfileActivation!(
      consumeProfileActivation(native.backend, "g", 1, 1),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(gate.activating).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(activation).resolves.toEqual({
      state: "unavailable",
      reason: "participant-timeout",
    });
  });

  it("fails closed at each stage, with the closed reason, and returns nothing", async () => {
    // Stage 2: a listener throws.
    {
      const native = mockNative();
      const { gate, consumed } = await unrestrictedGate(native);
      gate.onStatusChange!((view) => {
        if (view.state === "activating") throw new Error("title reset failed");
      });
      await expect(gate.beginProfileActivation!(consumed())).resolves.toEqual({
        state: "unavailable",
        reason: "activation-failed",
      });
      expect(native.fns.profileActivationCommit).not.toHaveBeenCalled();
    }
    // Stage 3: a participant fails.
    {
      const native = mockNative();
      const { gate, consumed } = await unrestrictedGate(native);
      gate.registerMainEgressParticipant("cli-ai", async () => {
        throw new Error("drain failed");
      });
      await expect(gate.beginProfileActivation!(consumed())).resolves.toEqual({
        state: "unavailable",
        reason: "participant-failed",
      });
      expect(native.fns.profileActivationCommit).not.toHaveBeenCalled();
    }
    // Stages 4 and 5: Native's closed reasons.
    for (const [message, reason] of [
      [
        "PROFILE_EGRESS_UNAVAILABLE:state-file-unwritable",
        "state-file-unwritable",
      ],
      ["PROFILE_EGRESS_UNAVAILABLE:barrier-timeout", "barrier-timeout"],
      ["PROFILE_EGRESS_UNAVAILABLE:activation-failed", "activation-failed"],
      ["PROFILE_ACTIVATION_REFUSED:shutdown", "activation-failed"],
      ["PROFILE_ACTIVATION_REFUSED:not-reserved", "activation-failed"],
      ["something else /with/a/path", "activation-failed"],
    ] as const) {
      const native = mockNative({
        commit: async () => {
          throw new Error(message);
        },
      });
      const { gate, consumed, views } = await unrestrictedGate(native);
      await expect(
        gate.beginProfileActivation!(consumed()),
        message,
      ).resolves.toEqual({ state: "unavailable", reason });
      expect(gate.restricted).toBe(true);
      expect(gate.unavailable).toBe(true);
      expect(JSON.stringify(views)).not.toContain("path");
      expect(() => gate.assertInvoke("send_chat_message", {})).toThrow();
    }
    // Stage 6: an invalid restricted status.
    {
      const native = mockNative({
        commit: async () => JSON.stringify(UNRESTRICTED),
      });
      const { gate, consumed } = await unrestrictedGate(native);
      await expect(gate.beginProfileActivation!(consumed())).resolves.toEqual({
        state: "unavailable",
        reason: "activation-failed",
      });
    }
  });

  it("a stage 2 or 3 failure asks Native to stop the AI in flight, once, before the unavailable notice (L-1)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Array<{
      readonly name: string;
      readonly reason: string;
      readonly arrange: (
        gate: Awaited<ReturnType<typeof createProfileEgressGate>>,
      ) => void;
      readonly bound?: number;
    }> = [
      {
        name: "stage 2: a listener throws",
        reason: "activation-failed",
        arrange: (gate) =>
          gate.onStatusChange((view) => {
            if (view.state === "activating") throw new Error("title reset");
          }),
      },
      {
        name: "stage 3: participant-timeout",
        reason: "participant-timeout",
        bound: 0,
        arrange: (gate) =>
          gate.registerMainEgressParticipant(
            "stuck",
            () => new Promise(() => {}),
          ),
      },
      {
        name: "stage 3: participant-failed",
        reason: "participant-failed",
        arrange: (gate) =>
          gate.registerMainEgressParticipant("cli-ai", async () => {
            throw new Error("drain failed");
          }),
      },
    ];
    for (const { name, reason, arrange, bound } of cases) {
      const native = mockNative();
      const gate = await createProfileEgressGate(native.backend, {
        participantBoundMs: bound,
      });
      gate.onStatusChange((view) => native.calls.push(`notice:${view.state}`));
      arrange(gate);
      await expect(
        gate.beginProfileActivation(
          consumeProfileActivation(native.backend, "grant", 7, 3),
        ),
        name,
      ).resolves.toEqual({ state: "unavailable", reason });
      expect(
        native.fns.profileActivationAbortInFlight,
        name,
      ).toHaveBeenCalledOnce();
      expect(native.fns.profileActivationCommit, name).not.toHaveBeenCalled();
      expect(native.calls.slice(native.calls.indexOf("consume")), name).toEqual(
        [
          "consume",
          "notice:activating",
          "abort-in-flight",
          "notice:unavailable",
        ],
      );
    }
  });

  it("stages 4 and 5 failing do not repeat the stop (Native asked for it itself)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const commit of [
      async () => {
        throw new Error("PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
      },
      async () => JSON.stringify(UNRESTRICTED),
    ]) {
      const native = mockNative({ commit });
      const gate = await createProfileEgressGate(native.backend);
      await expect(
        gate.beginProfileActivation(
          consumeProfileActivation(native.backend, "grant", 7, 3),
        ),
      ).resolves.toMatchObject({ state: "unavailable" });
      expect(native.fns.profileActivationAbortInFlight).not.toHaveBeenCalled();
    }
  });

  it("a missing, refusing or throwing stop request does not keep the gate from unavailable (L-1)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const abortInFlight of [
      () => false,
      () => {
        throw new Error("napi failed");
      },
      null,
    ]) {
      const native = mockNative(
        abortInFlight === null ? {} : { abortInFlight },
      );
      const backend =
        abortInFlight === null
          ? ({
              ...native.backend,
              profileActivationAbortInFlight: undefined,
            } as NapiBackendLike)
          : native.backend;
      const gate = await createProfileEgressGate(backend);
      const views: unknown[] = [];
      gate.onStatusChange((view) => views.push(view));
      gate.registerMainEgressParticipant("cli-ai", async () => {
        throw new Error("drain failed");
      });
      await expect(
        gate.beginProfileActivation(
          consumeProfileActivation(backend, "grant", 7, 3),
        ),
      ).resolves.toEqual({
        state: "unavailable",
        reason: "participant-failed",
      });
      expect(gate.unavailable).toBe(true);
      expect(views.at(-1)).toEqual({
        state: "unavailable",
        reason: "participant-failed",
      });
      expect(() => gate.assertInvoke("send_chat_message", {})).toThrow();
    }
    expect(
      errors.mock.calls.some(([line]) =>
        String(line).includes("Native's stop request failed: napi failed"),
      ),
    ).toBe(true);
  });

  it("a quit during stage 3 does not go on to stage 4 (L-3)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const native = mockNative();
    const gate = await createProfileEgressGate(native.backend);
    let stop!: () => void;
    gate.registerMainEgressParticipant(
      "cli-ai",
      () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
    );
    const activation = gate.beginProfileActivation(
      consumeProfileActivation(native.backend, "grant", 7, 3),
    );
    gate.noteAppQuitting();
    stop();
    await expect(activation).resolves.toEqual({
      state: "unavailable",
      reason: "activation-failed",
    });
    expect(native.fns.profileActivationCommit).not.toHaveBeenCalled();
    expect(native.fns.profileActivationAbortInFlight).toHaveBeenCalledOnce();
  });

  it("a quit noted after stage 4 began changes nothing in Main (Native's shutdown edge decides)", async () => {
    let release!: (value: string) => void;
    const native = mockNative({
      commit: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const gate = await createProfileEgressGate(native.backend);
    const activation = gate.beginProfileActivation(
      consumeProfileActivation(native.backend, "grant", 7, 3),
    );
    await vi.waitFor(() =>
      expect(native.fns.profileActivationCommit).toHaveBeenCalledOnce(),
    );
    gate.noteAppQuitting();
    release(JSON.stringify(RESTRICTED));
    await expect(activation).resolves.toEqual({ state: "restricted" });
  });

  it("workspace events during stage 3 or the commit register no caller; stage 7 registers lazily at the new workspace (L-5, D-4 (b))", async () => {
    for (const during of ["stage-3", "commit"] as const) {
      let stop!: () => void;
      let release!: (value: string) => void;
      const native = mockNative({
        commit: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      });
      const register = native.backend
        .registerProfileEgressCaller as unknown as ReturnType<typeof vi.fn>;
      const gate = await createProfileEgressGate(native.backend);
      if (during === "stage-3") {
        gate.registerMainEgressParticipant(
          "cli-ai",
          () =>
            new Promise<void>((resolve) => {
              stop = resolve;
            }),
        );
      }
      const before = gate.issueCallerIdentity(7);
      const activation = gate.beginProfileActivation(
        consumeProfileActivation(native.backend, "grant", 7, 3),
      );
      // Sync point: the activation is waiting in stage 3 or in the commit.
      if (during === "commit") {
        await vi.waitFor(() =>
          expect(native.fns.profileActivationCommit).toHaveBeenCalledOnce(),
        );
      } else {
        expect(native.fns.profileActivationCommit).not.toHaveBeenCalled();
      }
      gate.observeBackendEvent!("workspace:opened", {
        workspace: { workspaceId: "workspace-2" },
      });
      gate.observeBackendEvent!("workspace:lifecycle-state", {
        schemaVersion: 1,
        revision: 4,
        status: "ready",
        bindingToken: "bnd-ready",
        activation: "ready",
      });
      const during1 = gate.issueCallerIdentity(7);
      expect(during1.workspaceId, during).toBe("workspace-2");
      expect(during1.callerId, during).not.toBe(before.callerId);
      // `issueCallerIdentity` does not register while `activationPromise` is set.
      expect(register, during).not.toHaveBeenCalled();
      expect(
        () =>
          gate.assertInvoke("related_scenes_begin", {
            callerIdentity: during1,
          }),
        during,
      ).toThrow(new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`));

      if (during === "stage-3") {
        stop();
        await vi.waitFor(() =>
          expect(native.fns.profileActivationCommit).toHaveBeenCalledOnce(),
        );
        expect(register, during).not.toHaveBeenCalled();
      }
      release(JSON.stringify(RESTRICTED));
      await expect(activation, during).resolves.toEqual({
        state: "restricted",
      });
      expect(register, during).not.toHaveBeenCalled();

      // Stage 7: the next invoke registers once, at the new epoch and workspace.
      const after = gate.issueCallerIdentity(7);
      expect(register, during).toHaveBeenCalledOnce();
      const registered = JSON.parse(register.mock.calls[0]![0] as string) as {
        callerId: string;
        callerEpoch: number;
        workspaceId: string;
      };
      expect(registered, during).toMatchObject({
        callerId: after.callerId,
        callerEpoch: RESTRICTED.callerEpoch,
        workspaceId: "workspace-2",
      });
      expect(after.callerId, during).not.toBe(during1.callerId);
    }
  });

  it("status command answers while unavailable without ids or epoch", async () => {
    const gate = await createProfileEgressGate(null);
    expect(gate.statusView!()).toEqual({
      state: "unavailable",
      reason: "backend-unavailable",
    });
    const invalid = await createProfileEgressGate(
      mockNative({ initial: { ...UNRESTRICTED, inFlightStopped: false } })
        .backend,
    );
    expect(invalid.statusView!()).toEqual({
      state: "unavailable",
      reason: "status-invalid",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = await createProfileEgressGate({
      ...mockNative().backend,
      initializeProfileEgress: async () => {
        throw new Error(
          "PROFILE_EGRESS_UNAVAILABLE:state-file-unwritable: /home/u/.config/x",
        );
      },
    } as NapiBackendLike);
    expect(failing.statusView!()).toEqual({
      state: "unavailable",
      reason: "state-file-unwritable",
    });
    expect(JSON.stringify(failing.statusView!())).not.toContain("/home");
    // R-7: the Backend could not be built because the state file is
    // unreadable (row 6); only that closed reason is carried.
    for (const [backendConstructionFailure, reason] of [
      ["state-file-unreadable", "state-file-unreadable"],
      [null, "backend-unavailable"],
      ["barrier-timeout", "backend-unavailable"],
    ] as const) {
      const gate = await createProfileEgressGate(null, {
        backendConstructionFailure,
      });
      expect(gate.statusView()).toEqual({ state: "unavailable", reason });
    }
  });
});

describe("the status notifier index.ts installs (P2-4, Negative (28))", () => {
  it("stage 2 resets titles and ends streams; unavailable disposes the license scheduler; every state is broadcast", () => {
    const deps = {
      resetWindowTitles: vi.fn(),
      terminateAiStreams: vi.fn(),
      disposeLicenseValidation: vi.fn(),
      broadcast: vi.fn(),
    };
    const notify = createProfileEgressStatusNotifier(deps);
    notify({ state: "activating" });
    expect(deps.resetWindowTitles).toHaveBeenCalledOnce();
    expect(deps.terminateAiStreams).toHaveBeenCalledOnce();
    expect(deps.disposeLicenseValidation).not.toHaveBeenCalled();
    notify({ state: "restricted" });
    expect(deps.disposeLicenseValidation).not.toHaveBeenCalled();
    notify({ state: "unavailable", reason: "participant-timeout" });
    expect(deps.disposeLicenseValidation).toHaveBeenCalledOnce();
    expect(deps.broadcast.mock.calls).toEqual([
      ["profile-egress:state", { state: "activating" }],
      ["profile-egress:state", { state: "restricted" }],
      [
        "profile-egress:state",
        { state: "unavailable", reason: "participant-timeout" },
      ],
    ]);
  });

  it("an unavailable activation stops the periodic license check (P2-4)", async () => {
    vi.useFakeTimers();
    const { createLicenseValidationScheduler } =
      await import("./licenseValidation.js");
    const runLicenseValidateCycle = vi.fn(async () => null);
    const scheduler = createLicenseValidationScheduler(
      { runLicenseValidateCycle },
      vi.fn(),
    );
    scheduler.start();
    const native = mockNative({
      commit: async () => {
        throw new Error("PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
      },
    });
    const gate = await createProfileEgressGate(native.backend);
    gate.onStatusChange!(
      createProfileEgressStatusNotifier({
        resetWindowTitles: () => undefined,
        terminateAiStreams: () => undefined,
        disposeLicenseValidation: () => scheduler.dispose(),
        broadcast: () => undefined,
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await gate.beginProfileActivation!(
      consumeProfileActivation(native.backend, "g", 1, 1),
    );
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1_000);
    expect(runLicenseValidateCycle).not.toHaveBeenCalled();
  });
});
