import { describe, expect, it } from "vitest";
import {
  BODY_DECLARATION_BLOCKERS,
  BODY_DECLARATION_EXPIRY_GROUPS,
  type BodyDeclarationBlocker,
} from "./bodyDeclarationTypes";
import { declaredStanding, type DeclaredStanding } from "./declaredStanding";

// The mapping of DR-CB3-29: a blocker or an expiry group is "paused" only when
// putting the cause back leaves the same bytes effective again (the draft's
// veto row and DR-CB3-12's workspace group). Every other cause moved a token.
const BLOCKER_STANDING: Record<BodyDeclarationBlocker, DeclaredStanding> = {
  "scene-not-found": "expired",
  "scene-archived": "expired",
  "scope-unavailable": "expired",
  "scope-not-explicit": "expired",
  "scope-unresolved": "expired",
  "body-empty": "expired",
  "body-too-large": "expired",
  "body-unreadable": "expired",
  "title-too-large": "expired",
  "locator-unavailable": "paused",
  "veto-secret-foreshadow": "paused",
  "veto-secret-event-reveal": "paused",
  "veto-secret-event-link": "paused",
  "veto-pov": "expired",
  "veto-limit": "paused",
  "declaration-unreadable": "expired",
};

describe("declaredStanding", () => {
  it("is effective only when native says so", () => {
    expect(
      declaredStanding({ effective: true, expiredBy: [], blocker: null }),
    ).toBe("effective");
  });

  it("covers every blocker with an explicit decision", () => {
    expect(Object.keys(BLOCKER_STANDING).sort()).toEqual(
      [...BODY_DECLARATION_BLOCKERS].sort(),
    );
  });

  it.each(BODY_DECLARATION_BLOCKERS)("maps the blocker %s", (blocker) => {
    expect(declaredStanding({ effective: false, expiredBy: [], blocker })).toBe(
      BLOCKER_STANDING[blocker],
    );
  });

  it.each(BODY_DECLARATION_EXPIRY_GROUPS)(
    "maps the group %s alone",
    (group) => {
      expect(
        declaredStanding({
          effective: false,
          expiredBy: [group],
          blocker: null,
        }),
      ).toBe(group === "workspace" ? "paused" : "expired");
    },
  );

  it("is an expiry as soon as one group that does not come back differs", () => {
    expect(
      declaredStanding({
        effective: false,
        expiredBy: ["content", "workspace"],
        blocker: null,
      }),
    ).toBe("expired");
  });

  it("does not call an unknown reason an expiry", () => {
    expect(
      declaredStanding({ effective: false, expiredBy: [], blocker: null }),
    ).toBe("paused");
  });
});
