import { describe, expect, it } from "vitest";
import {
  NIR1_GRAPH_UI_ENABLED,
  isNir1GraphUiEnabled,
} from "./nir1GraphAvailability";

// The real constant, not a mock: the product keeps the Graph UI closed until
// PUB-G. A change that turns it on without PUB-G has to edit this test.
describe("Related Scenes Graph UI availability", () => {
  it("is closed by default (only PUB-G turns it on, with the Native gate)", () => {
    expect(NIR1_GRAPH_UI_ENABLED).toBe(false);
    expect(isNir1GraphUiEnabled()).toBe(false);
  });
});
