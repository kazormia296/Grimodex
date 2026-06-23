import { describe, it, expect } from "vitest";
import {
  buildModelCatalog,
  filterCatalog,
  groupCatalogByDeveloper,
} from "./chatModelCatalog";
import type { AiModel } from "./types";

const m = (id: string, name?: string): AiModel => ({ id, name: name ?? id });

describe("buildModelCatalog", () => {
  it("active プロバイダのセクションを先頭に置く", () => {
    const sections = buildModelCatalog({
      activeProvider: "openai",
      providerModels: [
        { provider: "anthropic", models: [m("claude-opus-4.8")] },
        { provider: "openai", models: [m("gpt-5.5")] },
      ],
    });
    expect(sections[0].provider).toBe("openai");
    expect(sections.map((s) => s.provider)).toEqual(["openai", "anthropic"]);
  });

  it("モデル 0 件のプロバイダはセクションごと落とす", () => {
    const sections = buildModelCatalog({
      activeProvider: "openrouter",
      providerModels: [
        { provider: "openrouter", models: [m("anthropic/claude-opus-4.8")] },
        { provider: "ollama", models: [] },
      ],
    });
    expect(sections.map((s) => s.provider)).toEqual(["openrouter"]);
  });

  it("sakana の variant は responses、他は null(backend 既定解決)", () => {
    const sections = buildModelCatalog({
      activeProvider: "openai",
      providerModels: [
        { provider: "openai", models: [m("gpt-5.5")] },
        { provider: "sakana", models: [m("fugu")] },
        { provider: "ai-novelist", models: [m("spiko_ultra")] },
      ],
    });
    const variantOf = (p: string) =>
      sections.find((s) => s.provider === p)?.models[0].variant;
    expect(variantOf("sakana")).toBe("responses");
    expect(variantOf("openai")).toBeNull();
    // ai のべりすと は null を渡して Rust に v1/legacy を既定解決させる。
    expect(variantOf("ai-novelist")).toBeNull();
  });

  it("name 欠落時は id をラベルにする", () => {
    const sections = buildModelCatalog({
      activeProvider: "openai",
      providerModels: [
        { provider: "openai", models: [{ id: "raw-id", name: "" }] },
      ],
    });
    expect(sections[0].models[0].name).toBe("raw-id");
  });
});

describe("filterCatalog", () => {
  const sections = buildModelCatalog({
    activeProvider: "openrouter",
    providerModels: [
      {
        provider: "openrouter",
        models: [m("anthropic/claude-opus-4.8"), m("openai/gpt-5.5")],
      },
      { provider: "anthropic", models: [m("claude-opus-4.8")] },
    ],
  });

  it("空クエリは全件返す", () => {
    expect(filterCatalog(sections, "")).toEqual(sections);
    expect(filterCatalog(sections, "   ")).toEqual(sections);
  });

  it("モデル名/id の部分一致(大小無視)で絞り、マッチ 0 のセクションは落とす", () => {
    const out = filterCatalog(sections, "OPUS");
    // openrouter の claude-opus と anthropic の claude-opus がマッチ、gpt-5.5 は脱落。
    expect(out.map((s) => s.provider)).toEqual(["openrouter", "anthropic"]);
    expect(out[0].models.map((x) => x.id)).toEqual([
      "anthropic/claude-opus-4.8",
    ]);
  });

  it("どのモデルにもマッチしないクエリは空配列", () => {
    expect(filterCatalog(sections, "nonexistent-zzz")).toEqual([]);
  });
});

describe("groupCatalogByDeveloper", () => {
  it("デベロッパー(スラッシュ前)で分け、名前昇順・空は末尾、variant を保持する", () => {
    const orSection = buildModelCatalog({
      activeProvider: "openrouter",
      providerModels: [
        {
          provider: "openrouter",
          models: [
            { id: "openai/gpt-5.5", name: "GPT-5.5" },
            { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" },
            { id: "barebones", name: "Barebones" },
          ],
        },
      ],
    })[0];
    const groups = groupCatalogByDeveloper(orSection.models);
    expect(groups.map(([dev]) => dev)).toEqual(["anthropic", "openai", ""]);
    // CatalogModel の型情報(provider/variant)が保持される。
    expect(groups[0][1][0].provider).toBe("openrouter");
    expect(groups[0][1][0].variant).toBeNull();
  });
});
