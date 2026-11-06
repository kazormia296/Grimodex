import { describe, expect, it } from "vitest";

import { isWorkspaceQuarantinedError } from "./workspaceQuarantined";
import { isWorkspaceSwitchingError } from "./workspaceSwitching";

describe("isWorkspaceQuarantinedError", () => {
  it("matches the code, including through a cause chain", () => {
    const inner = Object.assign(new Error("x"), {
      code: "WORKSPACE_QUARANTINED",
    });
    expect(isWorkspaceQuarantinedError(inner)).toBe(true);
    expect(
      isWorkspaceQuarantinedError(new Error("wrap", { cause: inner })),
    ).toBe(true);
  });

  it("is distinct from a workspace switch", () => {
    const switching = Object.assign(new Error("x"), {
      code: "WORKSPACE_SWITCHING",
    });
    expect(isWorkspaceQuarantinedError(switching)).toBe(false);
    expect(isWorkspaceSwitchingError(switching)).toBe(true);
    expect(
      isWorkspaceSwitchingError(
        Object.assign(new Error("x"), { code: "WORKSPACE_QUARANTINED" }),
      ),
    ).toBe(false);
    expect(isWorkspaceQuarantinedError(new Error("plain"))).toBe(false);
  });
});
