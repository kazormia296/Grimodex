import {
  resolveViewportProfile,
  type WorkspaceViewportProfile,
} from "./viewportProfile";

describe("viewport profile", () => {
  it.each<[number, WorkspaceViewportProfile]>([
    [0, "phone"],
    [719, "phone"],
    [720, "compact"],
    [1119, "compact"],
    [1120, "wide"],
    [1440, "wide"],
  ])("maps %s px to %s", (width, expected) => {
    expect(resolveViewportProfile(width)).toBe(expected);
  });

  it("uses container width rather than user agent hints", () => {
    expect(resolveViewportProfile(390)).toBe("phone");
    expect(resolveViewportProfile(1280)).toBe("wide");
  });
});
