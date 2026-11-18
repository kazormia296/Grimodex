import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "@/features/chat/agent/agentTypes";
import type { ChatIrUsedIds } from "@/features/chat/agent/chatTurnToolScope";

const gate = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/features/chat/agent/chatAgentIrAvailability", () => ({
  get CHAT_AGENT_IR_ENABLED() {
    return gate.enabled;
  },
}));

import {
  createChatResearchSubagentHandler,
  createChatTurnToolContext,
  createGuardedExecuteTool,
} from "./chatAgentToolHandlers";

type ExecuteTool = Parameters<
  typeof createChatTurnToolContext
>[0]["executeTool"];
type ExecuteReadOnlyTool = Parameters<
  typeof createChatTurnToolContext
>[0]["executeReadOnlyTool"];

function result(name: string, toolCallId: string): ToolResult {
  return { toolCallId, name, content: {}, summary: name, tokensUsed: 0 };
}

describe("createGuardedExecuteTool", () => {
  function setup(
    overrides: { authorityThrows?: boolean; beforeFails?: boolean } = {},
  ) {
    const calls: string[] = [];
    const executeTool = vi.fn<ExecuteTool>(async (name, id) => {
      calls.push("executeTool");
      return result(name, id);
    });
    const assertTurnAuthority = vi.fn(() => {
      calls.push("authority");
      if (overrides.authorityThrows) throw new Error("turn changed");
    });
    const handleAskUserTool = vi.fn((name: string, id: string) => {
      calls.push("askUser");
      return name === "ask_user" ? result(name, id) : null;
    });
    const runResearchSubagent = vi.fn((name: string, id: string) => {
      calls.push("research");
      return name === "run_research" ? Promise.resolve(result(name, id)) : null;
    });
    const beforeExecute = vi.fn(
      async (name: string, id: string, authorized: boolean) => {
        calls.push(`before:${authorized}`);
        return overrides.beforeFails
          ? { ...result(name, id), summary: "reservation failed" }
          : null;
      },
    );
    const guarded = createGuardedExecuteTool({
      executeTool,
      assertTurnAuthority,
      handleAskUserTool,
      runResearchSubagent,
      beforeExecute,
      fullyInjectedIds: new Set(["injected-1"]),
      chatMessageId: "assistant-1",
    });
    return {
      calls,
      executeTool,
      assertTurnAuthority,
      handleAskUserTool,
      runResearchSubagent,
      beforeExecute,
      guarded,
    };
  }

  it("checks the turn authority before anything else", async () => {
    const s = setup({ authorityThrows: true });
    await expect(s.guarded("search_events", "t1", {})).rejects.toThrow(
      "turn changed",
    );
    expect(s.calls).toEqual(["authority"]);
  });

  it("answers ask_user itself", async () => {
    const s = setup();
    const out = await s.guarded("ask_user", "t1", {});
    expect(out.name).toBe("ask_user");
    expect(s.runResearchSubagent).not.toHaveBeenCalled();
    expect(s.executeTool).not.toHaveBeenCalled();
  });

  it("answers run_research itself", async () => {
    const s = setup();
    const out = await s.guarded("run_research", "t1", { task: "x" });
    expect(out.name).toBe("run_research");
    expect(s.executeTool).not.toHaveBeenCalled();
  });

  it("short-circuits an entry that is already injected", async () => {
    const s = setup();
    const out = await s.guarded("get_codex_entry", "t1", { id: "injected-1" });
    expect(out.summary).toBe("Already injected (short-circuited)");
    expect(s.executeTool).not.toHaveBeenCalled();
  });

  it("runs beforeExecute only for a call that reaches executeTool, right before it (#940)", async () => {
    const s = setup();
    await s.guarded("ask_user", "t1", {});
    await s.guarded("run_research", "t2", { task: "x" });
    await s.guarded("get_codex_entry", "t3", { id: "injected-1" });
    expect(s.beforeExecute).not.toHaveBeenCalled();
    s.calls.length = 0;
    await s.guarded("search_events", "t4", {}, { projectId: "p1" } as never);
    expect(s.calls).toEqual([
      "authority",
      "askUser",
      "research",
      "before:true",
      "executeTool",
    ]);
    expect(s.beforeExecute).toHaveBeenLastCalledWith(
      "search_events",
      "t4",
      true,
    );
  });

  it("returns the beforeExecute failure without running the tool (#940)", async () => {
    const s = setup({ beforeFails: true });
    const out = await s.guarded("search_events", "t1", {});
    expect(out.summary).toBe("reservation failed");
    expect(s.beforeExecute).toHaveBeenLastCalledWith(
      "search_events",
      "t1",
      false,
    );
    expect(s.executeTool).not.toHaveBeenCalled();
  });

  it("passes any other call to executeTool, with the chat message id in the authorization", async () => {
    const s = setup();
    await s.guarded("get_codex_entry", "t1", { id: "other" });
    expect(s.executeTool).toHaveBeenLastCalledWith("get_codex_entry", "t1", {
      id: "other",
    });
    const authorization = { projectId: "p1" } as never;
    await s.guarded("search_events", "t2", {}, authorization);
    expect(s.executeTool).toHaveBeenLastCalledWith(
      "search_events",
      "t2",
      {},
      {
        projectId: "p1",
        chatMessageId: "assistant-1",
      },
    );
  });
});

describe("createChatTurnToolContext", () => {
  const executeTool = vi.fn<ExecuteTool>(async (name, id) => result(name, id));
  const executeReadOnlyTool = vi.fn<ExecuteReadOnlyTool>(async (name, id) =>
    result(name, id),
  );
  const assertTurnAuthority = vi.fn();
  const input = {
    executeTool,
    executeReadOnlyTool,
    enabled: true,
    projectId: "p1",
    workspacePath: "/w" as string | null,
    currentSceneId: "scene-1",
    tokenBudget: 8_000,
    assertTurnAuthority,
  };

  beforeEach(() => {
    gate.enabled = false;
    vi.clearAllMocks();
  });

  it("B-T5: returns the very same functions while the constant is false", () => {
    const context = createChatTurnToolContext(input);
    expect(context.executeTool).toBe(executeTool);
    expect(context.executeReadOnlyTool).toBe(executeReadOnlyTool);
    const record = { params: {} } as { params: object; usedIds?: unknown };
    context.attachUsedIds(record as never);
    expect(record.usedIds).toBeUndefined();
  });

  it("returns the same functions for a send that is not a private Agent's", () => {
    gate.enabled = true;
    const context = createChatTurnToolContext({ ...input, enabled: false });
    expect(context.executeTool).toBe(executeTool);
    expect(context.executeReadOnlyTool).toBe(executeReadOnlyTool);
  });

  it("binds scope and ir to the main agent, and the scope only to the sub-agent", async () => {
    gate.enabled = true;
    const context = createChatTurnToolContext(input);
    expect(context.executeTool).not.toBe(executeTool);
    const params = { query: "q" };
    const authorization = { projectId: "p1" } as never;
    await context.executeTool("search_events", "t1", params, authorization);
    const [, , , auth, main] = executeTool.mock.calls[0]!;
    expect(auth).toBe(authorization);
    expect(main?.scope).toEqual({ projectId: "p1", currentSceneId: "scene-1" });
    expect(main?.ir).toMatchObject({
      workspacePath: "/w",
      tokenCap: 2_000,
      counter: { chars: 0 },
      assertCurrent: assertTurnAuthority,
    });

    await context.executeReadOnlyTool("search_events", "t2", params);
    const sub = executeReadOnlyTool.mock.calls[0]![3];
    expect(sub).toEqual({
      scope: { projectId: "p1", currentSceneId: "scene-1" },
    });
    expect(Object.keys(sub!)).toEqual(["scope"]);
  });

  it("normalizes an empty Scene id to null and floors the cap at 1 token", async () => {
    gate.enabled = true;
    const context = createChatTurnToolContext({
      ...input,
      currentSceneId: "",
      workspacePath: null,
      tokenBudget: 3,
    });
    await context.executeTool("search_events", "t1", {});
    const main = executeTool.mock.calls[0]![4];
    expect(main?.scope?.currentSceneId).toBeNull();
    expect(main?.ir?.workspacePath).toBeNull();
    expect(main?.ir?.tokenCap).toBe(1);
  });

  it("gives every turn its own counter", async () => {
    gate.enabled = true;
    const a = createChatTurnToolContext(input);
    const b = createChatTurnToolContext(input);
    await a.executeTool("search_events", "t1", {});
    await b.executeTool("search_events", "t1", {});
    const irA = executeTool.mock.calls[0]![4]!.ir!;
    const irB = executeTool.mock.calls[1]![4]!.ir!;
    expect(irA.counter).not.toBe(irB.counter);
  });

  it("copies usedIds onto the record of the same params object only", async () => {
    gate.enabled = true;
    const context = createChatTurnToolContext(input);
    const params = { query: "q" };
    await context.executeTool("search_events", "t1", params);
    const ir = executeTool.mock.calls[0]![4]!.ir!;
    ir.noteUsedIds(params, ["rev-1", "rev-2"], ["ev-1"]);

    const other = { params: { query: "q" } } as {
      params: Record<string, unknown>;
      usedIds?: ChatIrUsedIds;
    };
    context.attachUsedIds(other);
    expect(other.usedIds).toBeUndefined();

    const record = { params } as {
      params: Record<string, unknown>;
      usedIds?: ChatIrUsedIds;
    };
    context.attachUsedIds(record);
    expect(record.usedIds).toEqual({
      revisionIds: ["rev-1", "rev-2"],
      eventIds: ["ev-1"],
      generation: null,
    });
  });

  it("the bound sub-agent executor fits the research handler's option type", () => {
    gate.enabled = true;
    const context = createChatTurnToolContext(input);
    const option: Parameters<
      typeof createChatResearchSubagentHandler
    >[0]["executeReadOnlyTool"] = context.executeReadOnlyTool;
    expect(option).toBe(context.executeReadOnlyTool);
  });
});
