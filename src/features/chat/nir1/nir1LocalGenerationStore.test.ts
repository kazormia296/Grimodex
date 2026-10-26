import { beforeEach, describe, expect, it } from "vitest";
import type { Nir1LocalTurnPorts } from "@/application/chat/nir1LocalGenerationTurn";
import {
  cancelNir1LocalGenerationOf,
  dispatchNir1LocalGeneration,
  resetNir1LocalGenerationsForTest,
  useNir1LocalGenerationStore,
} from "./nir1LocalGenerationStore";

// DD-1c review fix 1 (DR-DD1C-17): a running generation stays visible and
// stoppable when another accepted send arrives for the same conversation.

const CONVERSATION = "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TARGET = {
  purpose: "writing" as const,
  conversationId: CONVERSATION,
  sceneId: "scene-1",
};
const ENABLED = { presentation: "enabled" } as const;

function ports() {
  const calls: string[] = [];
  const continues: Array<(value: unknown) => void> = [];
  const value: Nir1LocalTurnPorts = {
    start: async () => {
      calls.push("start");
      return { status: "started", handle: `${calls.length}`.padStart(32, "0") };
    },
    continue: (handle) => {
      calls.push(`continue:${handle.slice(-2)}`);
      return new Promise((resolve) => continues.push(resolve as never));
    },
    cancel: async (handle) => {
      calls.push(`cancel:${handle.slice(-2)}`);
      return { status: "ok" };
    },
    setTimer: (run) => {
      void Promise.resolve().then(run);
      return 0;
    },
    clearTimer: () => {},
    now: () => 0,
  };
  return { value, calls, continues };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = () => useNir1LocalGenerationStore.getState();

beforeEach(() => resetNir1LocalGenerationsForTest());

describe("the local generations of the document", () => {
  it("keeps a running generation when another send is accepted", async () => {
    const p = ports();
    dispatchNir1LocalGeneration(TARGET, ENABLED, p.value);
    await flush();
    expect(state().turns[CONVERSATION]?.phase).toBe("running");
    dispatchNir1LocalGeneration(TARGET, ENABLED, p.value);
    await flush();
    expect(p.calls.filter((call) => call === "start")).toHaveLength(1);
    expect(state().turns[CONVERSATION]?.phase).toBe("running");
    expect(state().notices[CONVERSATION]).toBe("NIR1_LOCAL_SESSION_BUSY");
    cancelNir1LocalGenerationOf(CONVERSATION);
    await flush();
    expect(p.calls).toContain("cancel:01");
  });

  it("keeps a running generation over a policy refusal of a new send", async () => {
    const p = ports();
    dispatchNir1LocalGeneration(TARGET, ENABLED, p.value);
    await flush();
    dispatchNir1LocalGeneration(
      TARGET,
      { presentation: "hidden", reason: "NIR1_LOCAL_POLICY_DENIED" },
      p.value,
    );
    expect(state().turns[CONVERSATION]?.phase).toBe("running");
    expect(state().notices[CONVERSATION]).toBe("NIR1_LOCAL_POLICY_DENIED");
    cancelNir1LocalGenerationOf(CONVERSATION);
    await flush();
    expect(p.calls).toContain("cancel:01");
  });

  it("starts a new generation once the previous one ended", async () => {
    const p = ports();
    dispatchNir1LocalGeneration(TARGET, ENABLED, p.value);
    await flush();
    p.continues[0]({
      status: "ok",
      text: "",
      thinking: "",
      state: "succeeded",
      terminalCode: null,
      drained: true,
    });
    await flush();
    expect(state().turns[CONVERSATION]?.phase).toBe("succeeded");
    dispatchNir1LocalGeneration(TARGET, ENABLED, p.value);
    await flush();
    expect(p.calls.filter((call) => call === "start")).toHaveLength(2);
    expect(state().turns[CONVERSATION]?.phase).toBe("running");
    expect(state().notices[CONVERSATION]).toBeUndefined();
  });

  // Re-review P3-1: the busy notice ends with the generation it was about.
  it("clears the busy notice when the running generation ends", async () => {
    const p = ports();
    dispatchNir1LocalGeneration(TARGET, ENABLED, p.value);
    await flush();
    dispatchNir1LocalGeneration(TARGET, ENABLED, p.value);
    expect(state().notices[CONVERSATION]).toBe("NIR1_LOCAL_SESSION_BUSY");
    p.continues[0]({
      status: "ok",
      text: "",
      thinking: "",
      state: "succeeded",
      terminalCode: null,
      drained: true,
    });
    await flush();
    expect(state().turns[CONVERSATION]?.phase).toBe("succeeded");
    expect(state().notices[CONVERSATION]).toBeUndefined();
  });
});
