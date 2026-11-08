import { describe, expect, it } from "vitest";
import {
  HORIZONTAL_STRIPE_SIZE,
  OUTER_PAD_PX,
  STRIPE_GAP_PX,
  STRIPE_SIZE,
} from "@/features/layout/layoutConstants";
import {
  PROFILE_EGRESS_STATUS_BOTTOM_PX,
  PROFILE_EGRESS_STATUS_LEFT_PX,
} from "./profileEgressStatusPlacement";

describe("profile egress status placement", () => {
  it("clears the left stripe column and the bottom stripe row of the layout", () => {
    expect(PROFILE_EGRESS_STATUS_LEFT_PX).toBe(
      OUTER_PAD_PX + STRIPE_SIZE + STRIPE_GAP_PX,
    );
    expect(PROFILE_EGRESS_STATUS_BOTTOM_PX).toBe(
      OUTER_PAD_PX + HORIZONTAL_STRIPE_SIZE + STRIPE_GAP_PX,
    );
  });
});
