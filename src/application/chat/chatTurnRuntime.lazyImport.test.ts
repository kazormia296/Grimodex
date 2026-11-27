import { describe, expect, it, vi } from "vitest";
import { createChatTurnRuntime } from "./chatTurnRuntime";

vi.mock("./chatTurnMastraEngine", () => {
  throw new Error("Mastra engine failed to load");
});

describe("chat turn runtime lazy Mastra import", () => {
  it("returns null when the dynamic import fails", async () => {
    await expect(
      createChatTurnRuntime().tryMastraTurn({} as never),
    ).resolves.toBeNull();
  });
});
