import { describe, expect, it } from "vitest";
import { PROFILE_ACTIVATION_UI_ENABLED } from "./profileActivationAvailability";

// The real constant, not a mock: the product keeps the activation entry and the
// status display closed until Session C-1 / PUB-G. A change that turns it on
// without that approval has to edit this test.
describe("profile activation UI availability", () => {
  it("is closed by default (only C-1 / PUB-G turns it on, with the Native gate)", () => {
    expect(PROFILE_ACTIVATION_UI_ENABLED).toBe(false);
  });
});
