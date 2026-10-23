import { describe, expect, it } from "vitest";
import {
  BODY_DECLARATION_UI_ENABLED,
  isBodyDeclarationUiEnabled,
} from "./bodyDeclarationAvailability";

// The real constant, not a mock: the product keeps the declaration UI closed
// until PUB-G. A change that turns it on without PUB-G has to edit this test.
describe("body declaration UI availability", () => {
  it("is closed by default (only PUB-G turns it on, with the product gate)", () => {
    expect(BODY_DECLARATION_UI_ENABLED).toBe(false);
    expect(isBodyDeclarationUiEnabled()).toBe(false);
  });
});
