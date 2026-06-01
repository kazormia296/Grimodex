// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

// db / schema / drizzle / prosemirror のみモック。computeInputHash は実物を使い、
// persona がキャッシュキー (input_hash) に効くという契約を実際のハッシュで検証する。
const { mockDb } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
}));

vi.mock("@/db/client", () => ({ db: mockDb }));
vi.mock("@/db/schema", () => ({ treeNodes: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})) }));
vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: (s: string) => s,
}));

import { buildPseudoCommentPayload } from "./pseudoCommentPayloadBuilder";

function mockScene(content: string) {
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => Promise.resolve([{ content }]) }),
  });
}

describe("buildPseudoCommentPayload input_hash", () => {
  it("同じ persona・同じ本文なら同じ input_hash (キャッシュ短絡が効く)", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s1", "m", "一般読者");
    expect(a.inputHash).toBe(b.inputHash);
  });

  it("persona が違えば input_hash が変わる (ペルソナ別 run になる)", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s1", "m", "批評家");
    expect(a.inputHash).not.toBe(b.inputHash);
  });

  it("本文が違えば input_hash が変わる", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者");
    mockScene("本文B");
    const b = await buildPseudoCommentPayload("s1", "m", "一般読者");
    expect(a.inputHash).not.toBe(b.inputHash);
  });

  it("scene が違えば input_hash が変わる", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s2", "m", "一般読者");
    expect(a.inputHash).not.toBe(b.inputHash);
  });
});
