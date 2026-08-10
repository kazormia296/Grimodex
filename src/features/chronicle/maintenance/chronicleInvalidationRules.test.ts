import { describe, expect, it } from "vitest";
import { adviseChronicleInvalidation } from "./chronicleInvalidationRules";

describe("adviseChronicleInvalidation", () => {
  it("never auto-deletes events when evidence disappears", () => {
    expect(adviseChronicleInvalidation("event-link").autoDeleteEvent).toBe(
      false,
    );
    expect(adviseChronicleInvalidation("scene-content").policy).toBe(
      "revalidate-exact",
    );
  });

  it("keeps calendar changes on resolve-only path", () => {
    expect(adviseChronicleInvalidation("calendar").policy).toBe("resolve-only");
  });
});
