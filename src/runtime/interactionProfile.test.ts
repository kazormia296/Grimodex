import { resolveInteractionProfile } from "./interactionProfile";

describe("interaction profile", () => {
  it("recognizes coarse touch input", () => {
    expect(
      resolveInteractionProfile({
        pointer: "coarse",
        hover: "none",
        reducedMotion: false,
      }),
    ).toEqual({ pointer: "coarse", hover: "none", reducedMotion: false });
  });

  it("keeps reduced-motion independent of pointer capability", () => {
    expect(
      resolveInteractionProfile({
        pointer: "fine",
        hover: "hover",
        reducedMotion: true,
      }).reducedMotion,
    ).toBe(true);
  });
});
