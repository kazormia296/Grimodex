import { describe, expect, it } from "vitest";
import { isAgentForeshadowSecretInputSupported } from "./agentForeshadowSecretWritePolicy.js";

describe("agent foreshadow secret write policy", () => {
  it.each([undefined, false])("accepts create secret input %s", (secret) => {
    const input = secret === undefined ? {} : { secret };
    expect(
      isAgentForeshadowSecretInputSupported("create_foreshadow", input),
    ).toBe(true);
  });

  it.each([true, "true", 1, null, undefined])(
    "rejects create secret input %s",
    (secret) => {
      expect(
        isAgentForeshadowSecretInputSupported("create_foreshadow", {
          secret,
        }),
      ).toBe(false);
    },
  );

  it("rejects any update secret key and accepts an omitted key", () => {
    expect(
      isAgentForeshadowSecretInputSupported("update_foreshadow", {
        id: "f1",
      }),
    ).toBe(true);
    for (const secret of [true, false, null, undefined]) {
      expect(
        isAgentForeshadowSecretInputSupported("update_foreshadow", {
          id: "f1",
          secret,
        }),
      ).toBe(false);
    }
  });

  it("leaves other tools outside this policy", () => {
    expect(
      isAgentForeshadowSecretInputSupported("create_event", {
        secret: true,
      }),
    ).toBe(true);
  });
});
