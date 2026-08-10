import { describe, expect, it } from "vitest";
import { shouldRunBackgroundAi } from "./maintenanceMode";

describe("shouldRunBackgroundAi", () => {
  it("never runs AI in manual mode", () => {
    expect(
      shouldRunBackgroundAi("manual", { allowBackgroundAi: true }, "small"),
    ).toBe(false);
  });

  it("never runs AI in deterministic mode, even if policy allows it", () => {
    expect(
      shouldRunBackgroundAi(
        "deterministic",
        { allowBackgroundAi: true },
        "small",
      ),
    ).toBe(false);
  });

  it("does not run AI in idle-suggestions mode when the policy disallows it", () => {
    expect(
      shouldRunBackgroundAi(
        "idle-suggestions",
        { allowBackgroundAi: false },
        "small",
      ),
    ).toBe(false);
  });

  it("blocks AI for a large-scale batch even when the mode/policy would otherwise allow it", () => {
    expect(
      shouldRunBackgroundAi(
        "idle-suggestions",
        { allowBackgroundAi: true },
        "large",
      ),
    ).toBe(false);
  });

  it("runs AI only for idle-suggestions + allowBackgroundAi + small scale", () => {
    expect(
      shouldRunBackgroundAi(
        "idle-suggestions",
        { allowBackgroundAi: true },
        "small",
      ),
    ).toBe(true);
  });
});
