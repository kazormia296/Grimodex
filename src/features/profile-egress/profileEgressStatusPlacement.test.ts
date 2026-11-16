import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HORIZONTAL_STRIPE_SIZE,
  OUTER_PAD_PX,
  STRIPE_GAP_PX,
  STRIPE_SIZE,
} from "@/features/layout/layoutConstants";
import {
  EDITOR_STATUS_BAR_CLEARANCE_PX,
  PROFILE_EGRESS_STATUS_BOTTOM_PX,
  PROFILE_EGRESS_STATUS_LEFT_PX,
  PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX,
  PROFILE_EGRESS_STATUS_PHONE_LEFT_PX,
  PROFILE_EGRESS_STATUS_PLACEMENT_CLASS,
} from "./profileEgressStatusPlacement";

const phoneCss = readFileSync(
  new URL("../layout/adaptive/phoneWorkspace.css", import.meta.url),
  "utf8",
);

describe("profile egress status placement", () => {
  it("clears the left stripe column and the bottom stripe row of the layout", () => {
    expect(PROFILE_EGRESS_STATUS_LEFT_PX).toBe(
      OUTER_PAD_PX + STRIPE_SIZE + STRIPE_GAP_PX,
    );
    expect(PROFILE_EGRESS_STATUS_BOTTOM_PX).toBe(
      OUTER_PAD_PX +
        HORIZONTAL_STRIPE_SIZE +
        STRIPE_GAP_PX +
        EDITOR_STATUS_BAR_CLEARANCE_PX,
    );
  });

  it("lifts the display above the editor status bar (29 px) with a gap", () => {
    expect(EDITOR_STATUS_BAR_CLEARANCE_PX).toBeGreaterThan(29);
  });

  it("keeps the literal Tailwind classes in step with the numbers", () => {
    const cls = PROFILE_EGRESS_STATUS_PLACEMENT_CLASS.split(" ");
    expect(cls).toContain(`left-[${PROFILE_EGRESS_STATUS_LEFT_PX}px]`);
    expect(cls).toContain(`bottom-[${PROFILE_EGRESS_STATUS_BOTTOM_PX}px]`);
    expect(cls).toContain(
      `max-[719px]:left-[${PROFILE_EGRESS_STATUS_PHONE_LEFT_PX}px]`,
    );
    expect(cls).toContain(
      `max-[719px]:bottom-[calc(${PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX}px+env(safe-area-inset-bottom))]`,
    );
  });

  it("sits above the phone workspace nav (68 px plus the safe area)", () => {
    const nav = /--phone-workspace-nav-height:\s*(\d+)px/.exec(phoneCss);
    expect(nav).not.toBeNull();
    expect(PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX).toBeGreaterThan(
      Number(nav![1]),
    );
  });
});
