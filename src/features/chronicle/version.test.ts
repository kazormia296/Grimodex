import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { getEventVersion } from "./version";

describe("getEventVersion", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("uses the project-scoped typed command and preserves null", async () => {
    invokeMock.mockResolvedValueOnce(4).mockResolvedValueOnce(null);

    await expect(getEventVersion("p1", "e1")).resolves.toBe(4);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "event_get_version", {
      projectId: "p1",
      eventId: "e1",
    });
    await expect(getEventVersion("p1", "missing")).resolves.toBeNull();
  });
});
