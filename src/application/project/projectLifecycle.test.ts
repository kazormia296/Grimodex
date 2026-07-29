import { describe, expect, it, vi } from "vitest";

import {
  registerProjectLifecycle,
  reloadProjectLifecycle,
} from "./projectLifecycle";

describe("project lifecycle port", () => {
  it("forwards reload commands to the registered registry", async () => {
    const reload = vi.fn(async () => ({ cancelled: false, degraded: [] }));
    registerProjectLifecycle(
      { reload },
      {
        resetChatForProject: vi.fn(),
        resetPhaseStateForProject: vi.fn(),
        resetUnplacedBeatsForProject: vi.fn(),
      },
    );

    const context = { projectId: "project-a", workspaceOpenRevision: 4 };
    const options = { beforeCommit: () => true };
    await expect(reloadProjectLifecycle(context, options)).resolves.toEqual({
      cancelled: false,
      degraded: [],
    });
    expect(reload).toHaveBeenCalledWith(context, options);
  });
});
