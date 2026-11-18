import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
}));

import { IpcInvokeError } from "@/lib/tauri";
import { selectChatAgentIr } from "./chatIr";

const REQUEST = {
  query: "SECRET-QUERY-TEXT 主人公の秘密",
  projectId: "project-1",
  expectedWorkspacePath: "/workspace/a",
  currentSceneId: "scene-9",
  chronicleEventIds: ["event-1", "event-2", "event-3"],
};

const ITEM = {
  $grimodexIr: 1,
  origin: "manuscript",
  revisionId: "rev-1",
  sceneId: "scene-1",
  sceneTitle: "第一章",
  summary: "要約",
  review: "human-approved",
  quotes: ["引用"],
  score: 0.8123,
};

function ipcError(
  code: ConstructorParameters<typeof IpcInvokeError>[1]["code"],
  message: string,
) {
  return new IpcInvokeError("chat_agent_ir_select", {
    code,
    message,
    retryable: false,
    outcome: "failed",
  });
}

/** An answer of Native with the five keys; `excludedEventIds` follows the status. */
function native(overrides: Record<string, unknown> = {}) {
  const base = {
    status: "available",
    success: true,
    items: [ITEM],
    eventIds: {},
    ...overrides,
  };
  const judged =
    base.status === "available" || base.status === "none-above-threshold";
  return { excludedEventIds: judged ? [] : null, ...base };
}

function notAnswered(status: string) {
  return { kind: "not-answered", origin: "renderer", status };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("selectChatAgentIr: the call (B-T3)", () => {
  it("passes exactly the five keys of the request to invoke", async () => {
    invokeMock.mockResolvedValue(
      native({
        eventIds: { "rev-1": "event-1" },
        excludedEventIds: ["event-2"],
      }),
    );
    const outcome = await selectChatAgentIr(REQUEST);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0]!;
    expect(command).toBe("chat_agent_ir_select");
    expect(Object.keys(args as object).sort()).toEqual([
      "chronicleEventIds",
      "currentSceneId",
      "expectedWorkspacePath",
      "projectId",
      "query",
    ]);
    expect(args).toEqual(REQUEST);
    // A copy of the list, not the caller's array.
    expect((args as { chronicleEventIds: unknown }).chronicleEventIds).not.toBe(
      REQUEST.chronicleEventIds,
    );
    expect(outcome).toEqual({
      kind: "answered",
      origin: "native",
      status: "available",
      success: true,
      items: [ITEM],
      eventIds: { "rev-1": "event-1" },
      excludedEventIds: ["event-2"],
    });
  });

  it("passes no extra key even when the caller's object has some", async () => {
    invokeMock.mockResolvedValue(
      native({ status: "busy", success: false, items: [] }),
    );
    await selectChatAgentIr({
      ...REQUEST,
      limit: 8,
      readingOrder: ["s1"],
    } as typeof REQUEST);
    const [, args] = invokeMock.mock.calls[0]!;
    expect(Object.keys(args as object)).toHaveLength(5);
  });

  it("returns the items of Native's answer as they are (same objects)", async () => {
    const answer = native({ eventIds: { "rev-1": "event-1" } });
    invokeMock.mockResolvedValue(answer);
    const outcome = await selectChatAgentIr(REQUEST);
    expect(outcome.kind).toBe("answered");
    if (outcome.kind === "answered") {
      expect(outcome.items[0]).toBe(ITEM);
      expect(outcome.eventIds).toBe(answer.eventIds);
    }
  });

  it("keeps a Native failure status as an answer of Native", async () => {
    invokeMock.mockResolvedValue(
      native({ status: "embedder-cold", success: false, items: [] }),
    );
    expect(await selectChatAgentIr(REQUEST)).toEqual({
      kind: "answered",
      origin: "native",
      status: "embedder-cold",
      success: false,
      items: [],
      eventIds: {},
      // Not judged: `null`, never an empty list.
      excludedEventIds: null,
    });
  });

  it("reports an answer that fails the check as invalid-response", async () => {
    for (const raw of [
      null,
      "text",
      native({ items: [{ ...ITEM, generation: 1 }] }),
      { ...native({ items: [] }), extra: 1 },
      // The two keys of the answer are required.
      { status: "available", success: true, items: [] },
    ]) {
      invokeMock.mockResolvedValueOnce(raw);
      expect(await selectChatAgentIr(REQUEST)).toEqual(
        notAnswered("invalid-response"),
      );
    }
  });
});

describe("selectChatAgentIr: preflight (B-T3)", () => {
  const cases: [string, Partial<typeof REQUEST>, string][] = [
    ["empty query", { query: "" }, "query-invalid"],
    ["white-space query", { query: " \n\t　 " }, "query-invalid"],
    ["query of 501 UTF-16 units", { query: "a".repeat(501) }, "query-invalid"],
    ["no current Scene", { currentSceneId: "" }, "no-current-scene"],
    ["no workspace path", { expectedWorkspacePath: "" }, "no-workspace"],
    ["no project", { projectId: "" }, "no-workspace"],
  ];
  for (const [name, override, status] of cases) {
    it(`does not call Native: ${name}`, async () => {
      const outcome = await selectChatAgentIr({ ...REQUEST, ...override });
      expect(outcome).toEqual(notAnswered(status));
      expect(invokeMock).not.toHaveBeenCalled();
    });
  }

  it("counts the query bound in UTF-16 code units", async () => {
    invokeMock.mockResolvedValue(
      native({ status: "busy", success: false, items: [] }),
    );
    // 500 units is accepted; an astral character counts as two.
    await selectChatAgentIr({ ...REQUEST, query: "a".repeat(500) });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const outcome = await selectChatAgentIr({
      ...REQUEST,
      query: "a".repeat(499) + "\u{1F600}",
    });
    expect(outcome).toEqual(notAnswered("query-invalid"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("applies one status when several inputs are bad, in a fixed order", async () => {
    expect(
      await selectChatAgentIr({
        query: "",
        projectId: "",
        expectedWorkspacePath: "",
        currentSceneId: "",
        chronicleEventIds: [],
      }),
    ).toEqual(notAnswered("no-current-scene"));
    expect(
      await selectChatAgentIr({
        query: "",
        projectId: "",
        expectedWorkspacePath: "",
        currentSceneId: "s",
        chronicleEventIds: [],
      }),
    ).toEqual(notAnswered("query-invalid"));
  });

  // The candidate list is checked with the bounds of Main and Native. A bad
  // list is a programming error of the caller: `ipc-error`, no IPC call.
  it.each([
    ["31 IDs", Array.from({ length: 31 }, (_, index) => `event-${index}`)],
    ["an empty ID", [""]],
    ["a white-space ID", ["  "]],
    ["201 units", ["a".repeat(201)]],
    ["a repeated ID", ["e", "e"]],
    ["a non-string", [1]],
    ["not an array", "event-1"],
    ["a missing list", undefined],
  ])("does not call Native: %s", async (_name, chronicleEventIds) => {
    const outcome = await selectChatAgentIr({
      ...REQUEST,
      chronicleEventIds,
    } as unknown as typeof REQUEST);
    expect(outcome).toEqual(notAnswered("ipc-error"));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("sends no candidate as an empty list and 30 IDs of 200 units as they are", async () => {
    invokeMock.mockResolvedValue(native({ items: [] }));
    await selectChatAgentIr({ ...REQUEST, chronicleEventIds: [] });
    const thirty = Array.from({ length: 30 }, (_, index) =>
      `${index}`.padEnd(200, "x"),
    );
    await selectChatAgentIr({ ...REQUEST, chronicleEventIds: thirty });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(
      (invokeMock.mock.calls[0]![1] as { chronicleEventIds: unknown })
        .chronicleEventIds,
    ).toEqual([]);
    expect(
      (invokeMock.mock.calls[1]![1] as { chronicleEventIds: unknown })
        .chronicleEventIds,
    ).toEqual(thirty);
  });
});

// W3 (S1-A2): what Native excludes is a part of what was sent.
describe("selectChatAgentIr: the exclusions are a subset of the candidates", () => {
  it("accepts a subset, an empty list and the whole list", async () => {
    for (const excludedEventIds of [
      [],
      ["event-3"],
      ["event-2", "event-1"],
      ["event-1", "event-2", "event-3"],
    ]) {
      invokeMock.mockResolvedValueOnce(native({ excludedEventIds }));
      const outcome = await selectChatAgentIr(REQUEST);
      expect(outcome.kind, JSON.stringify(excludedEventIds)).toBe("answered");
      if (outcome.kind === "answered") {
        expect(outcome.excludedEventIds).toEqual(excludedEventIds);
      }
    }
  });

  it("reports an ID that was not sent as invalid-response, on both successes", async () => {
    for (const answer of [
      native({ excludedEventIds: ["event-9"] }),
      native({ excludedEventIds: ["event-1", "event-9"] }),
      native({
        status: "none-above-threshold",
        items: [],
        excludedEventIds: ["other"],
      }),
    ]) {
      invokeMock.mockResolvedValueOnce(answer);
      expect(await selectChatAgentIr(REQUEST)).toEqual(
        notAnswered("invalid-response"),
      );
    }
    // With no candidate sent, nothing can be excluded.
    invokeMock.mockResolvedValueOnce(native({ excludedEventIds: ["event-1"] }));
    expect(
      await selectChatAgentIr({ ...REQUEST, chronicleEventIds: [] }),
    ).toEqual(notAnswered("invalid-response"));
  });
});

describe("selectChatAgentIr: the error map (B-T3)", () => {
  async function statusOf(rejection: unknown) {
    invokeMock.mockRejectedValueOnce(rejection);
    return selectChatAgentIr(REQUEST);
  }

  it("maps IPC_TIMEOUT to caller-timeout", async () => {
    expect(
      await statusOf(
        ipcError(
          "IPC_TIMEOUT",
          "IPC timeout after 20000ms: chat_agent_ir_select",
        ),
      ),
    ).toEqual(notAnswered("caller-timeout"));
  });

  it("maps the gate's message, from Main and from Native, to gate-closed", async () => {
    expect(
      await statusOf(
        ipcError("UNKNOWN", "CHAT_IR_GATE_CLOSED: the chat IR route is closed"),
      ),
    ).toEqual(notAnswered("gate-closed"));
    expect(await statusOf(new Error("Error: CHAT_IR_GATE_CLOSED"))).toEqual(
      notAnswered("gate-closed"),
    );
    expect(await statusOf("CHAT_IR_GATE_CLOSED")).toEqual(
      notAnswered("gate-closed"),
    );
  });

  it("maps a restricted denial, also behind a cause chain, to egress-denied", async () => {
    expect(
      await statusOf(
        ipcError("UNKNOWN", "D2A_EGRESS_DENIED: chat_agent_ir_select"),
      ),
    ).toEqual(notAnswered("egress-denied"));
    const wrapped = new Error("query failed", {
      cause: new Error("D2A_EGRESS_DENIED: chat_agent_ir_select"),
    });
    expect(await statusOf(wrapped)).toEqual(notAnswered("egress-denied"));
  });

  it("maps lifecycle cancellations and workspace switches to ipc-cancelled", async () => {
    for (const code of [
      "IPC_READ_CANCELLED",
      "IPC_DERIVED_CANCELLED",
      "IPC_MUTATION_CANCELLED",
      "WORKSPACE_SWITCHING",
      "NO_WORKSPACE_OPEN",
    ] as const) {
      expect(await statusOf(ipcError(code, `${code}: x`)), code).toEqual(
        notAnswered("ipc-cancelled"),
      );
    }
  });

  it("maps everything else, including a bad-request error, to ipc-error", async () => {
    expect(
      await statusOf(
        ipcError("UNKNOWN", "IPC_INVALID_REQUEST: chat_agent_ir_select query"),
      ),
    ).toEqual(notAnswered("ipc-error"));
    expect(
      await statusOf(ipcError("UNKNOWN", "CHAT_IR_INVALID_REQUEST")),
    ).toEqual(notAnswered("ipc-error"));
    expect(await statusOf(ipcError("IPC_BACKEND_UNAVAILABLE", "x"))).toEqual(
      notAnswered("ipc-error"),
    );
    expect(await statusOf(new Error("boom"))).toEqual(notAnswered("ipc-error"));
  });

  it("never throws, whatever is rejected", async () => {
    const hostile = {
      get message(): string {
        throw new Error("getter");
      },
    };
    for (const rejection of [
      undefined,
      null,
      42,
      { code: 7 },
      { type: "x", data: {} },
      hostile,
    ]) {
      const outcome = await statusOf(rejection);
      expect(outcome.kind).toBe("not-answered");
    }
  });
});

describe("selectChatAgentIr: no query in the log (B-T3)", () => {
  it("writes the query, summaries and quotes to no console method, success or failure", async () => {
    const spies = (["log", "debug", "info", "warn", "error"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      invokeMock.mockResolvedValueOnce(native());
      await selectChatAgentIr(REQUEST);
      invokeMock.mockRejectedValueOnce(new Error("boom"));
      await selectChatAgentIr(REQUEST);
      invokeMock.mockResolvedValueOnce({ junk: REQUEST.query });
      await selectChatAgentIr(REQUEST);
      await selectChatAgentIr({ ...REQUEST, query: "" });
      await selectChatAgentIr({
        ...REQUEST,
        chronicleEventIds: ["CANDIDATE-ID", "CANDIDATE-ID"],
      });
      invokeMock.mockResolvedValueOnce(
        native({ excludedEventIds: ["CANDIDATE-OTHER"] }),
      );
      await selectChatAgentIr({
        ...REQUEST,
        chronicleEventIds: ["CANDIDATE-ID"],
      });
      const written = spies
        .flatMap((spy) => spy.mock.calls)
        .map((args) => JSON.stringify(args))
        .join("\n");
      expect(written).not.toContain("SECRET-QUERY-TEXT");
      expect(written).not.toContain("要約");
      expect(written).not.toContain("引用");
      expect(written).not.toContain("CANDIDATE-");
      expect(written).not.toContain("event-1");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
