import { describe, expect, it, vi } from "vitest";
import {
  createAssistantRowReservation,
  sendableHistory,
} from "./chatAssistantRowReservation";

type M = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: string | null;
};
const m = (
  id: string,
  role: M["role"],
  content: string,
  metadata?: Record<string, unknown>,
): M => ({
  id,
  role,
  content,
  ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
});

describe("sendableHistory", () => {
  it("keeps normal user/assistant pairs and system rows", () => {
    const messages = [
      m("s", "system", "sys"),
      m("u1", "user", "q1"),
      m("a1", "assistant", "r1"),
      m("u2", "user", "q2"),
      m("a2", "assistant", "r2"),
    ];
    expect(sendableHistory(messages)).toEqual(messages);
  });

  it("drops an empty assistant row left by a stopped or failed turn", () => {
    expect(
      sendableHistory([
        m("u1", "user", "q1"),
        m("a1", "assistant", "r1"),
        m("a2", "assistant", ""),
        m("a3", "assistant", "", { stopped: true }),
        m("u2", "user", "q2"),
      ]).map((x) => x.id),
    ).toEqual(["u1", "a1", "u2"]);
  });

  it("drops a failed or stopped assistant row whose user row was never saved", () => {
    expect(
      sendableHistory([
        m("u1", "user", "q1"),
        m("a1", "assistant", "r1"),
        m("failed", "assistant", "partial", { runtime_error: "down" }),
        m("stopped", "assistant", "partial", { stopped: true }),
        m("u2", "user", "q2"),
        m("a2", "assistant", "r2"),
      ]).map((x) => x.id),
    ).toEqual(["u1", "a1", "u2", "a2"]);
    expect(
      sendableHistory([m("x", "assistant", "partial", { runtime_error: "e" })]),
    ).toEqual([]);
  });

  it("keeps an unmarked assistant row regardless of its position", () => {
    const messages = [
      m("a0", "assistant", "greeting"),
      m("u1", "user", "q1"),
      m("a1", "assistant", "r1"),
      m("a1b", "assistant", "continued"),
      m("u2", "user", "q2"),
      m("ok", "assistant", "r", { runtime_error: "late" }),
    ];
    expect(sendableHistory(messages).map((x) => x.id)).toEqual([
      "a0",
      "u1",
      "a1",
      "a1b",
      "u2",
      "ok",
    ]);
  });

  it("keeps a summary marker without counting it for alternation", () => {
    expect(
      sendableHistory([
        m("u1", "user", "q1"),
        m("a1", "assistant", "r1"),
        m("summary-1", "assistant", "要約", { summary_id: "1" }),
        m("u2", "user", "q2"),
        m("a2", "assistant", "r2"),
        m("summary-2", "assistant", "要約2", { summary_id: "2" }),
        m("failed", "assistant", "partial", { runtime_error: "down" }),
      ]).map((x) => x.id),
    ).toEqual(["u1", "a1", "summary-1", "u2", "a2", "summary-2"]);
  });
});

describe("createAssistantRowReservation", () => {
  const setup = (opts: {
    addMessage: ReturnType<typeof vi.fn>;
    listMessages?: ReturnType<typeof vi.fn>;
    guards?: (() => boolean)[];
    content?: string;
  }) => {
    const warn = vi.fn();
    const reservation = createAssistantRowReservation({
      chatApi: {
        addMessage: opts.addMessage as never,
        listMessages: (opts.listMessages ??
          vi.fn(() => Promise.resolve([]))) as never,
      },
      getSessionId: () => "s1",
      message: { id: "a1", createdAt: "2026-11-18T00:00:00.000Z" },
      getMessages: () =>
        opts.content === undefined ? [] : [{ id: "a1", content: opts.content }],
      assertCurrent: () => {},
      writeGuards: opts.guards ?? [() => true],
      debugLog: { warn },
      errorDetail: (error) => String(error),
    });
    return { reservation, warn };
  };

  it("treats the row as reserved when the write failed after the INSERT", async () => {
    const addMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("session update failed"))
      .mockResolvedValue({});
    const listMessages = vi.fn(() => Promise.resolve([{ id: "a1" }]));
    const { reservation } = setup({ addMessage, listMessages });

    const failed = await reservation.before("create_snippet", "t1", true);
    expect(failed?.error).toContain("session update failed");
    expect(reservation.reserved).toBe(true);

    await reservation.persist("s1", "done", {});
    expect(addMessage).toHaveBeenLastCalledWith(
      "s1",
      "assistant",
      "done",
      expect.objectContaining({ id: "a1", replaceReservedAssistant: true }),
    );
  });

  it("stays unreserved when the failed write left no row", async () => {
    const addMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValue({});
    const { reservation } = setup({ addMessage });

    await reservation.before("create_snippet", "t1", true);
    expect(reservation.reserved).toBe(false);
    await reservation.persist("s1", "done", {});
    expect(addMessage.mock.lastCall?.[3]).not.toHaveProperty(
      "replaceReservedAssistant",
    );
  });

  it("assumes the row may exist when its presence cannot be read", async () => {
    const addMessage = vi.fn().mockRejectedValueOnce(new Error("x"));
    const listMessages = vi.fn(() => Promise.reject(new Error("read failed")));
    const { reservation } = setup({ addMessage, listMessages });

    await reservation.before("create_codex_entry", "t1", true);
    expect(reservation.reserved).toBe(true);
  });

  it("settles an abandoned reserved row as stopped with the observed text", async () => {
    const addMessage = vi.fn().mockResolvedValue({});
    const { reservation } = setup({ addMessage });
    await reservation.before("create_snippet", "t1", true);
    reservation.observeText("途中");
    reservation.observeText("まで");

    await reservation.settleAbandoned("model-x");
    await reservation.settleAbandoned("model-x");

    expect(addMessage).toHaveBeenCalledTimes(2);
    expect(addMessage).toHaveBeenLastCalledWith(
      "s1",
      "assistant",
      "途中まで",
      expect.objectContaining({
        model: "model-x",
        metadata: JSON.stringify({ stopped: true }),
        replaceReservedAssistant: true,
      }),
    );
  });

  it("does not settle an abandoned row once the captured project is gone", async () => {
    const addMessage = vi.fn().mockResolvedValue({});
    const { reservation } = setup({ addMessage, guards: [() => false] });
    await reservation.before("create_snippet", "t1", true);

    await reservation.settleAbandoned("model-x");

    expect(addMessage).toHaveBeenCalledTimes(1);
  });

  it("does nothing on abandon when no row was reserved", async () => {
    const addMessage = vi.fn().mockResolvedValue({});
    const { reservation } = setup({ addMessage });
    await reservation.before("search", "t1", true);

    await reservation.settleAbandoned("model-x");

    expect(addMessage).not.toHaveBeenCalled();
  });
});
