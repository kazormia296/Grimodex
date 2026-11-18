import { describe, expect, it } from "vitest";
import { sendableHistory } from "./chatAssistantRowReservation";

type M = { id: string; role: "user" | "assistant" | "system"; content: string };
const m = (id: string, role: M["role"], content: string): M => ({
  id,
  role,
  content,
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
        m("u2", "user", "q2"),
      ]).map((x) => x.id),
    ).toEqual(["u1", "a1", "u2"]);
  });

  it("drops an assistant row whose user row was never saved", () => {
    expect(
      sendableHistory([
        m("u1", "user", "q1"),
        m("a1", "assistant", "r1"),
        m("orphan", "assistant", "partial"),
        m("u2", "user", "q2"),
        m("a2", "assistant", "r2"),
      ]).map((x) => x.id),
    ).toEqual(["u1", "a1", "u2", "a2"]);
    expect(sendableHistory([m("orphan", "assistant", "partial")])).toEqual([]);
  });
});
