import { describe, expect, it } from "vitest";

import { createCanonicalWriteContext } from "./writeContext";

describe("canonical write authority context", () => {
  it("requires an explicit route for ai-apply at runtime", () => {
    expect(() =>
      Reflect.apply(createCanonicalWriteContext, undefined, [
        "ai-apply",
        undefined,
        "request-1",
      ]),
    ).toThrow(/ai-apply.*explicit authorityRoute/i);
  });

  it.each(["interactive-agent-command", "interpreter-projection"] as const)(
    "accepts explicit ai-apply route %s",
    (authorityRoute) => {
      const context = createCanonicalWriteContext(
        "ai-apply",
        undefined,
        "request-1",
        { authorityRoute },
      );

      expect(context).toMatchObject({
        origin: "ai-apply",
        authorityRoute,
      });
    },
  );

  it("rejects a human origin paired with the interpreter route", () => {
    expect(() =>
      createCanonicalWriteContext("human", undefined, "request-1", {
        authorityRoute: "interpreter-projection",
      }),
    ).toThrow(/origin.*not valid/i);
  });
});
