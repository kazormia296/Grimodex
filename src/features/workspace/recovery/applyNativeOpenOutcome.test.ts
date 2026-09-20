import { describe, expect, it } from "vitest";
import { applyNativeOpenOutcome } from "./applyNativeOpenOutcome";

const workspace = {
  name: "W1",
  isExisting: true,
  workspaceId: "w1",
};

const proof = {
  schemaVersion: 1 as const,
  revision: 12,
  status: "ready" as const,
  bindingToken: "opaque-ready-token",
  activation: "ready" as const,
};

describe("applyNativeOpenOutcome lifecycle proof", () => {
  it("keeps the exact Native proof on a structured ready result", () => {
    expect(
      applyNativeOpenOutcome(
        { status: "ready", workspace, lifecycle: proof },
        "/workspaces/W1",
      ),
    ).toMatchObject({ kind: "ready", lifecycle: proof });
  });

  it("rejects a structured success without a valid proof", () => {
    expect(
      applyNativeOpenOutcome(
        { status: "ready", workspace },
        "/workspaces/W1",
      ),
    ).toEqual({
      kind: "invalid",
      reasonCode: "NEX_WORKSPACE_OPEN_LIFECYCLE_PROOF_MISSING",
    });
    expect(
      applyNativeOpenOutcome(
        {
          status: "migrated",
          workspace,
          migration: {
            fromSchema: 1,
            toSchema: 2,
            receiptPath: "/tmp/receipt",
            recovered: true,
          },
          lifecycle: { ...proof, bindingToken: "" },
        },
        "/workspaces/W1",
      ),
    ).toMatchObject({ kind: "invalid" });
  });

  it("keeps the explicitly marked legacy adapter separate", () => {
    expect(
      applyNativeOpenOutcome(workspace, "/workspaces/W1"),
    ).toMatchObject({ kind: "ready", lifecycle: null });
  });
});
