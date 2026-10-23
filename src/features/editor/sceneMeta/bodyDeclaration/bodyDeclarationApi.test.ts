import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import * as api from "./bodyDeclarationApi";
import {
  BODY_DECLARATION_AXES,
  BODY_DECLARATION_BLOCKERS,
  BODY_DECLARATION_REFUSAL_CODES,
  type ConfirmedAxes,
} from "./bodyDeclarationTypes";

const SCENE = {
  workspacePath: "/workspace",
  projectId: "project-1",
  sceneId: "scene-1",
} as const;
const OCC = { scopeVersion: 3, scopeToken: "scope-token" } as const;
const ALL_CONFIRMED: ConfirmedAxes = {
  story: true,
  auto: true,
  phase: true,
  reveal: true,
  pov: true,
};

function refusal(code: string): Error {
  return new Error(`Error: NEX_BODY_DECLARATION_REFUSED:${code}`);
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("readBodyDeclarationState", () => {
  it("sends only the workspace and the two keys of the Scene", async () => {
    invokeMock.mockResolvedValue({
      occ: OCC,
      declarationToken: null,
      state: { kind: "none", blocker: null },
    });
    await api.readBodyDeclarationState(SCENE);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]).toEqual([
      "narrative_scene_body_declaration_state",
      {
        expectedWorkspacePath: "/workspace",
        payload: { projectId: "project-1", sceneId: "scene-1" },
      },
    ]);
  });

  it("maps the closed answers", async () => {
    invokeMock.mockResolvedValueOnce({
      occ: OCC,
      declarationToken: "dt",
      state: {
        kind: "declared",
        effective: false,
        expiredBy: ["content", "scope"],
        blocker: null,
      },
    });
    await expect(api.readBodyDeclarationState(SCENE)).resolves.toEqual({
      ok: true,
      snapshot: {
        occ: OCC,
        declarationToken: "dt",
        state: {
          kind: "declared",
          effective: false,
          expiredBy: ["content", "scope"],
          blocker: null,
        },
      },
    });
    invokeMock.mockResolvedValueOnce({
      occ: null,
      declarationToken: null,
      state: { kind: "none", blocker: "scene-archived" },
    });
    await expect(api.readBodyDeclarationState(SCENE)).resolves.toEqual({
      ok: true,
      snapshot: {
        occ: null,
        declarationToken: null,
        state: { kind: "none", blocker: "scene-archived" },
      },
    });
    invokeMock.mockResolvedValueOnce({
      occ: OCC,
      declarationToken: null,
      state: { kind: "unavailable", reason: "half-state", blocker: null },
    });
    const unavailable = await api.readBodyDeclarationState(SCENE);
    expect(unavailable).toMatchObject({
      ok: true,
      snapshot: { state: { kind: "unavailable", reason: "half-state" } },
    });
  });

  const UNKNOWN = {
    occ: null,
    declarationToken: null,
    state: {
      kind: "unavailable",
      reason: "unknown-response",
      blocker: null,
    },
  };

  it.each([
    [
      "an unknown top-level field",
      {
        occ: null,
        declarationToken: null,
        state: { kind: "none", blocker: null },
        declaredAt: "2026-10-23T00:00:00Z",
      },
    ],
    ["a missing field", { occ: null, state: { kind: "none", blocker: null } }],
    [
      "an unknown kind",
      {
        occ: null,
        declarationToken: null,
        state: { kind: "pending", blocker: null },
      },
    ],
    [
      "an unknown blocker",
      {
        occ: null,
        declarationToken: null,
        state: { kind: "none", blocker: "graph-has-candidates" },
      },
    ],
    [
      "an unknown unavailable reason",
      {
        occ: null,
        declarationToken: null,
        state: { kind: "unavailable", reason: "brand-new", blocker: null },
      },
    ],
    [
      "an unknown expiry group",
      {
        occ: OCC,
        declarationToken: "dt",
        state: {
          kind: "declared",
          effective: false,
          expiredBy: ["time"],
          blocker: null,
        },
      },
    ],
    [
      "an unknown field inside the state",
      {
        occ: null,
        declarationToken: null,
        state: { kind: "none", blocker: null, excerpt: "..." },
      },
    ],
    [
      "an effective answer that also carries an expiry",
      {
        occ: OCC,
        declarationToken: "dt",
        state: {
          kind: "declared",
          effective: true,
          expiredBy: ["scope"],
          blocker: null,
        },
      },
    ],
    [
      "an effective answer that also carries a blocker",
      {
        occ: OCC,
        declarationToken: "dt",
        state: {
          kind: "declared",
          effective: true,
          expiredBy: [],
          blocker: "veto-pov",
        },
      },
    ],
    [
      "a malformed OCC",
      {
        occ: { scopeVersion: 0, scopeToken: "" },
        declarationToken: null,
        state: { kind: "none", blocker: null },
      },
    ],
    [
      "an empty declaration token",
      {
        occ: OCC,
        declarationToken: "",
        state: { kind: "none", blocker: null },
      },
    ],
    ["a non-object", "effective"],
    ["null", null],
  ])("folds %s to an unusable answer", async (_label, wire) => {
    invokeMock.mockResolvedValue(wire);
    await expect(api.readBodyDeclarationState(SCENE)).resolves.toEqual({
      ok: true,
      snapshot: UNKNOWN,
    });
  });

  it("returns a closed code when the read is refused, never throwing", async () => {
    invokeMock.mockRejectedValue(refusal("gate-closed"));
    await expect(api.readBodyDeclarationState(SCENE)).resolves.toEqual({
      ok: false,
      code: "gate-closed",
    });
  });
});

describe("declareBody", () => {
  it("sends exactly the closed payload and nothing a renderer could forge", async () => {
    invokeMock.mockResolvedValue({ outcome: "declared" });
    await expect(
      api.declareBody({
        scene: SCENE,
        occ: OCC,
        declarationToken: "dt",
        confirmed: ALL_CONFIRMED,
      }),
    ).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0] as [
      string,
      { expectedWorkspacePath: string; payload: Record<string, unknown> },
    ];
    expect(command).toBe("narrative_scene_body_declaration_declare");
    expect(Object.keys(args).sort()).toEqual([
      "expectedWorkspacePath",
      "payload",
    ]);
    expect(Object.keys(args.payload).sort()).toEqual([
      "expected",
      "projectId",
      "requestId",
      "sceneId",
      "values",
    ]);
    expect(args.payload.expected).toEqual({
      scopeVersion: 3,
      scopeToken: "scope-token",
      declarationToken: "dt",
    });
    expect(typeof args.payload.requestId).toBe("string");
    const wire = JSON.stringify(args);
    for (const forbidden of [
      "grant",
      "sender",
      "window",
      "digest",
      "declarationId",
      "previewId",
      "declaredAt",
    ]) {
      expect(wire.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("names the declared token as null when there is no declaration", async () => {
    invokeMock.mockResolvedValue({ outcome: "declared" });
    await api.declareBody({
      scene: SCENE,
      occ: OCC,
      declarationToken: null,
      confirmed: ALL_CONFIRMED,
    });
    const payload = (
      invokeMock.mock.calls[0][1] as {
        payload: { expected: { declarationToken: string | null } };
      }
    ).payload;
    expect(payload.expected.declarationToken).toBeNull();
  });

  it("always sends the v1 subset, whatever the caller passes", async () => {
    invokeMock.mockResolvedValue({ outcome: "declared" });
    await api.declareBody({
      scene: SCENE,
      occ: OCC,
      declarationToken: null,
      // A caller cannot choose a value: only confirmations are accepted.
      confirmed: { ...ALL_CONFIRMED, reveal: true },
    });
    const payload = (
      invokeMock.mock.calls[0][1] as { payload: { values: unknown } }
    ).payload;
    expect(payload.values).toEqual({
      story: "independent",
      auto: "independent",
      phase: "independent",
      reveal: "non-secret",
      pov: "independent",
    });
    expect(Object.isFrozen(api.BODY_DECLARATION_VALUES)).toBe(true);
  });

  it.each(BODY_DECLARATION_AXES)(
    "does not call Native while the %s axis is unconfirmed",
    async (axis) => {
      const confirmed = { ...ALL_CONFIRMED, [axis]: false };
      await expect(
        api.declareBody({
          scene: SCENE,
          occ: OCC,
          declarationToken: null,
          confirmed,
        }),
      ).resolves.toEqual({ ok: false, code: "invalid-request" });
      expect(invokeMock).not.toHaveBeenCalled();
    },
  );

  it("does not treat an unknown success shape as a declaration", async () => {
    invokeMock.mockResolvedValue({ outcome: "declared", extra: 1 });
    await expect(
      api.declareBody({
        scene: SCENE,
        occ: OCC,
        declarationToken: null,
        confirmed: ALL_CONFIRMED,
      }),
    ).resolves.toEqual({ ok: false, code: "unknown-refusal" });
  });
});

describe("revokeBody", () => {
  it("sends the closed payload with the screen's declaration token and no grant", async () => {
    invokeMock.mockResolvedValue({ outcome: "revoked" });
    await expect(
      api.revokeBody({ scene: SCENE, declarationToken: "dt" }),
    ).resolves.toEqual({ ok: true, outcome: "revoked" });
    const [command, args] = invokeMock.mock.calls[0] as [
      string,
      { payload: Record<string, unknown> },
    ];
    expect(command).toBe("narrative_scene_body_declaration_revoke");
    expect(Object.keys(args.payload).sort()).toEqual([
      "declarationToken",
      "projectId",
      "requestId",
      "sceneId",
    ]);
  });

  it.each(["revoked", "no-declaration", "declaration-changed"])(
    "returns the closed outcome %s",
    async (outcome) => {
      invokeMock.mockResolvedValue({ outcome });
      await expect(
        api.revokeBody({ scene: SCENE, declarationToken: "dt" }),
      ).resolves.toEqual({ ok: true, outcome });
    },
  );

  it("folds an unknown outcome to a refusal", async () => {
    invokeMock.mockResolvedValue({ outcome: "restored" });
    await expect(
      api.revokeBody({ scene: SCENE, declarationToken: "dt" }),
    ).resolves.toEqual({ ok: false, code: "unknown-refusal" });
  });
});

describe("the wrapper never builds or forwards a grant", () => {
  it("passes (command, args) only, and exposes no way to write a confirmation", async () => {
    invokeMock.mockResolvedValue({ outcome: "declared" });
    await api.declareBody({
      scene: SCENE,
      occ: OCC,
      declarationToken: null,
      confirmed: ALL_CONFIRMED,
    });
    await api.revokeBody({ scene: SCENE, declarationToken: "dt" });
    await api.readBodyDeclarationState(SCENE);
    for (const call of invokeMock.mock.calls) {
      expect(call).toHaveLength(2);
    }
    const exported = Object.keys(api);
    expect(
      exported.filter((name) => /grant|confirm|dialog|approve/iu.test(name)),
    ).toEqual([]);
  });
});

describe("requestId", () => {
  it("is fresh for every operation, retries and re-declarations included", async () => {
    invokeMock.mockResolvedValueOnce({ outcome: "declared" });
    invokeMock.mockRejectedValueOnce(refusal("state-changed"));
    invokeMock.mockResolvedValueOnce({ outcome: "revoked" });
    invokeMock.mockResolvedValueOnce({ outcome: "no-declaration" });
    invokeMock.mockResolvedValueOnce({ outcome: "declared" });
    const declare = () =>
      api.declareBody({
        scene: SCENE,
        occ: OCC,
        declarationToken: null,
        confirmed: ALL_CONFIRMED,
      });
    await declare();
    await declare(); // a retry after a refusal
    await api.revokeBody({ scene: SCENE, declarationToken: "dt" });
    await api.revokeBody({ scene: SCENE, declarationToken: "dt" });
    await declare(); // a re-declaration after a revoke
    const ids = invokeMock.mock.calls.map(
      (call) =>
        (call[1] as { payload: { requestId: string } }).payload.requestId,
    );
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
});

describe("bodyDeclarationRefusalCode", () => {
  it.each(
    BODY_DECLARATION_REFUSAL_CODES.filter((code) => !code.startsWith("grant-")),
  )("keeps the Native code %s", (code) => {
    if (
      code === "egress-denied" ||
      code === "timeout" ||
      code === "unknown-refusal" ||
      code === "store-failure"
    ) {
      return; // renderer-side folds, covered below
    }
    expect(api.bodyDeclarationRefusalCode(refusal(code))).toBe(code);
  });

  it("covers every blocker as a code", () => {
    for (const blocker of BODY_DECLARATION_BLOCKERS) {
      expect(api.bodyDeclarationRefusalCode(refusal(blocker))).toBe(blocker);
    }
  });

  it.each([
    ["MAIN_GRANT_CANCELLED", "grant-cancelled"],
    ["MAIN_GRANT_EXPIRED", "grant-expired"],
    ["MAIN_GRANT_REVOKED", "grant-revoked"],
    ["MAIN_GRANT_BUSY", "grant-busy"],
    ["MAIN_GRANT_REQUIRED", "grant-required"],
    ["MAIN_GRANT_SENDER_UNAVAILABLE", "grant-sender-unavailable"],
    ["MAIN_GRANT_FAILED", "grant-failed"],
    ["MAIN_GRANT_SOMETHING_NEW", "grant-failed"],
  ])("maps %s", (message, code) => {
    expect(api.bodyDeclarationRefusalCode(new Error(message))).toBe(code);
  });

  it("folds Native's store failures, the caller admission and the timeout", () => {
    expect(api.bodyDeclarationRefusalCode(refusal("sqlite-busy"))).toBe(
      "store-failure",
    );
    expect(api.bodyDeclarationRefusalCode(refusal("timed-out"))).toBe(
      "store-failure",
    );
    expect(
      api.bodyDeclarationRefusalCode(
        new Error("D2A_EGRESS_DENIED: caller identity is missing"),
      ),
    ).toBe("egress-denied");
    expect(
      api.bodyDeclarationRefusalCode(new Error("IPC timeout after 10000ms: x")),
    ).toBe("timeout");
  });

  it("never returns or exposes a raw message", async () => {
    const secret = "ENOENT: no such file '/home/author/private/novel.sqlite'";
    expect(api.bodyDeclarationRefusalCode(new Error(secret))).toBe(
      "unknown-refusal",
    );
    expect(api.bodyDeclarationRefusalCode(secret)).toBe("unknown-refusal");
    expect(api.bodyDeclarationRefusalCode(refusal("brand-new-code"))).toBe(
      "unknown-refusal",
    );
    invokeMock.mockRejectedValue(new Error(secret));
    const read = await api.readBodyDeclarationState(SCENE);
    const declare = await api.declareBody({
      scene: SCENE,
      occ: OCC,
      declarationToken: null,
      confirmed: ALL_CONFIRMED,
    });
    const revoke = await api.revokeBody({
      scene: SCENE,
      declarationToken: "dt",
    });
    expect(JSON.stringify([read, declare, revoke])).not.toContain("/home");
    expect(read).toEqual({ ok: false, code: "unknown-refusal" });
  });
});
