import { describe, expect, it } from "vitest";
import { score } from "./score";
describe("B1 deterministic scoring", () => {
  it("detects expected facts and counts forbidden facts", () => {
    expect(score("時計職人", ["時計職人"], ["船大工"])).toEqual({
      correct: true,
      forbiddenCount: 0,
    });
    expect(
      score("時計職人だが船大工でもある", ["時計職人"], ["船大工"]),
    ).toEqual({ correct: true, forbiddenCount: 1 });
  });
});
