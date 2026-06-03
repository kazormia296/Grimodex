// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

// db / schema / drizzle / prosemirror のみモック。computeInputHash は実物を使い、
// persona / brief がキャッシュキー (input_hash) に効くという契約を実際のハッシュで検証する。
const { mockDb } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
}));

vi.mock("@/db/client", () => ({ db: mockDb }));
vi.mock("@/db/schema", () => ({ treeNodes: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})) }));
vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: (s: string) => s,
}));

import {
  buildPseudoCommentPayload,
  buildPseudoCommentSystemPrompt,
  personaRequiresTargetProfile,
  PSEUDO_PERSONAS,
  resolvePersonaBrief,
} from "./pseudoCommentPayloadBuilder";

function mockScene(content: string) {
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => Promise.resolve([{ content }]) }),
  });
}

describe("buildPseudoCommentPayload input_hash", () => {
  it("同じ persona・brief・本文なら同じ input_hash (キャッシュ短絡が効く)", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者", "brief-x");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s1", "m", "一般読者", "brief-x");
    expect(a.inputHash).toBe(b.inputHash);
  });

  it("persona が違えば input_hash が変わる (ペルソナ別 run になる)", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者", "b");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s1", "m", "辛口の批評家", "b");
    expect(a.inputHash).not.toBe(b.inputHash);
  });

  it("brief が違えば input_hash が変わる (genre/読者プロフィール変更でキャッシュが切れる)", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者", "brief-A");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s1", "m", "一般読者", "brief-B");
    expect(a.inputHash).not.toBe(b.inputHash);
  });

  it("本文が違えば input_hash が変わる", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者", "b");
    mockScene("本文B");
    const b = await buildPseudoCommentPayload("s1", "m", "一般読者", "b");
    expect(a.inputHash).not.toBe(b.inputHash);
  });

  it("scene が違えば input_hash が変わる", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者", "b");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s2", "m", "一般読者", "b");
    expect(a.inputHash).not.toBe(b.inputHash);
  });

  it("custom 空なら custom 未指定と同じ input_hash (既存キャッシュ非破壊)", async () => {
    mockScene("本文A");
    const a = await buildPseudoCommentPayload("s1", "m", "一般読者", "b");
    mockScene("本文A");
    const b = await buildPseudoCommentPayload("s1", "m", "一般読者", "b", "");
    mockScene("本文A");
    const c = await buildPseudoCommentPayload(
      "s1",
      "m",
      "一般読者",
      "b",
      "   \n ",
    );
    expect(b.inputHash).toBe(a.inputHash);
    expect(c.inputHash).toBe(a.inputHash);
  });

  it("custom が非空なら input_hash が変わる / 内容が違えば別ハッシュ", async () => {
    mockScene("本文A");
    const base = await buildPseudoCommentPayload("s1", "m", "一般読者", "b");
    mockScene("本文A");
    const x = await buildPseudoCommentPayload(
      "s1",
      "m",
      "一般読者",
      "b",
      "戦闘描写を重点的に",
    );
    mockScene("本文A");
    const y = await buildPseudoCommentPayload(
      "s1",
      "m",
      "一般読者",
      "b",
      "会話のテンポを見て",
    );
    expect(x.inputHash).not.toBe(base.inputHash);
    expect(y.inputHash).not.toBe(base.inputHash);
    expect(x.inputHash).not.toBe(y.inputHash);
  });
});

describe("resolvePersonaBrief", () => {
  it("genre を全ペルソナ brief に織り込む", () => {
    const withGenre = resolvePersonaBrief("一般読者", { genre: "Romance" });
    const without = resolvePersonaBrief("一般読者", { genre: null });
    expect(withGenre).toContain("Romance");
    expect(withGenre).not.toBe(without);
  });

  it("ターゲット読者層は targetReaders プロフィールを本文に注入する", () => {
    const profile = "20代の社会人女性";
    const brief = resolvePersonaBrief("ターゲット読者層", {
      targetReaders: profile,
    });
    expect(brief).toContain(profile);
  });

  it("ターゲット読者層は profile 未設定でも一般読者向けにフォールバックする", () => {
    const brief = resolvePersonaBrief("ターゲット読者層", {
      targetReaders: "",
    });
    expect(brief).toContain("想定する読者層");
    expect(brief).not.toContain("人物像は次の通り");
  });

  it("未知 persona はラベルだけ注入する後方互換経路", () => {
    const brief = resolvePersonaBrief("編集者", {});
    expect(brief).toContain("「編集者」");
  });
});

describe("persona registry", () => {
  it("編集者は読者ペルソナから除外されている (レビューと重複のため)", () => {
    expect(PSEUDO_PERSONAS).not.toContain("編集者");
  });

  it("ターゲット読者層のみ想定読者プロフィールを必須とする", () => {
    expect(personaRequiresTargetProfile("ターゲット読者層")).toBe(true);
    expect(personaRequiresTargetProfile("一般読者")).toBe(false);
  });
});

describe("buildPseudoCommentSystemPrompt", () => {
  it("brief を READER PERSONA として base prompt の末尾に付ける", () => {
    const out = buildPseudoCommentSystemPrompt("BASE", "この作品を読む読者…");
    expect(out.startsWith("BASE")).toBe(true);
    expect(out).toContain("READER PERSONA: この作品を読む読者…");
  });
});
