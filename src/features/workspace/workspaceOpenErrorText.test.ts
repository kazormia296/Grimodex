import { describe, expect, it } from "vitest";
import { workspaceOpenErrorText } from "./workspaceOpenErrorText";

describe("workspaceOpenErrorText", () => {
  const t = (key: string) => `<${key}>`;

  it("appends the guidance for an exclusive lease timeout", () => {
    expect(
      workspaceOpenErrorText(
        "WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT: workspace lease is held by another process",
        t,
      ),
    ).toBe(
      "WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT: workspace lease is held by another process <workspace.leaseTimeoutHint>",
    );
  });

  it("leaves other errors untouched", () => {
    expect(workspaceOpenErrorText("disk full", t)).toBe("disk full");
  });
});
