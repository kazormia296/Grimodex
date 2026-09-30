import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({ invoke }));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "session-1",
}));

import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "@/features/timelapse/genesisBarrier";
import { agentWriteBundle } from "./bundle";

beforeEach(() => {
  vi.clearAllMocks();
  _resetTimelapseGenesisBarriersForTests();
  publishCurrentProjectId("project-1");
});

describe("agent_write_bundle genesis admission", () => {
  it("performs no Native side effect after a failed genesis", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    genesis.fail(new Error("genesis failed"));

    await expect(
      agentWriteBundle({
        projectId: "project-1",
        statements: [],
        undoJournal: {
          entityKind: "codex",
          entityId: "entry-1",
          opKind: "update",
          beforeJson: null,
          afterJson: null,
          baseVersion: 1,
          resultVersion: 2,
        },
        changeEvent: {
          eventUid: "event-1",
          sceneId: null,
          domain: "codex",
          opType: "entry.update",
          entityType: "codex_entry",
          entityId: "entry-1",
          payload: "{}",
          timestamp: 1,
        },
      }),
    ).rejects.toMatchObject({ name: "TimelapseGenesisBarrierError" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
