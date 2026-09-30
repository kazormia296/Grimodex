import { describe, expect, it } from "vitest";

import { parseWorkspaceLifecycleView } from "./workspaceLifecycleView.js";

describe("workspace lifecycle view", () => {
  it("accepts a ready view with an opaque token", () => {
    expect(
      parseWorkspaceLifecycleView(
        JSON.stringify({
          schemaVersion: 1,
          revision: 4,
          status: "ready",
          bindingToken: "bnd-token",
          activation: "ready",
        }),
      ),
    ).toMatchObject({ status: "ready", activation: "ready", revision: 4 });
  });

  it("keeps recovery-required separate from ready", () => {
    const view = parseWorkspaceLifecycleView({
      schemaVersion: 1,
      revision: 5,
      status: "recovery-required",
      bindingToken: "bnd-recovery",
      activation: "requires-open",
    });
    expect(view.activation).toBe("requires-open");
  });

  it("rejects invalid combinations and unknown fields", () => {
    expect(() =>
      parseWorkspaceLifecycleView({
        schemaVersion: 1,
        revision: 1,
        status: "closed",
        bindingToken: "old",
        activation: "none",
      }),
    ).toThrow(/closed requires/);
    expect(() =>
      parseWorkspaceLifecycleView({
        schemaVersion: 1,
        revision: 1,
        status: "ready",
        bindingToken: "bnd-ready",
        activation: "ready",
        locator: "/secret",
      }),
    ).toThrow(/unknown or missing/);
  });
});
