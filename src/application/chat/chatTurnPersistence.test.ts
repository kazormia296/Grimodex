import { describe, expect, it } from "vitest";
import { shouldPersistChatTurnInRenderer } from "./chatTurnPersistence.js";

describe("renderer chat persistence ownership", () => {
  it("keeps legacy turns in the renderer and skips renderer persistence for M turns", () => {
    expect(shouldPersistChatTurnInRenderer(false)).toBe(true);
    expect(shouldPersistChatTurnInRenderer(true)).toBe(false);
  });
});
