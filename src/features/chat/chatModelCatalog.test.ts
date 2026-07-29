import { describe, it, expect } from "vitest";
import {
  buildModelCatalog,
  filterCatalog,
  groupCatalogByDeveloper,
  applyModelWhitelist,
  applyModelWhitelistToModels,
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

  it("OpenAI 互換は 1 エンドポイント = 1 セクション、endpointId/label を持つ", () => {
    const sections = buildModelCatalog({
      activeProvider: "openai-compatible",
      activeEndpointId: "ep-local",
      providerModels: [
        {
          provider: "openai-compatible",
          endpointId: "ep-cloud",
          endpointLabel: "Cloud gateway",
          models: [m("gpt-4o")],
        },
        {
          provider: "openai-compatible",
          endpointId: "ep-local",
          endpointLabel: "Local llama",
          models: [m("qwen3")],
        },
      ],
    });
    // active エンドポイント(ep-local)が互換内の先頭。
    expect(sections.map((s) => s.endpointId)).toEqual(["ep-local", "ep-cloud"]);
    expect(sections[0].endpointLabel).toBe("Local llama");
    // モデルに endpointId が伝播する。
    expect(sections[0].models[0].endpointId).toBe("ep-local");
    expect(sections[1].models[0].endpointId).toBe("ep-cloud");
  });

  it("OpenAI 互換エンドポイント既定 variant をモデルへ伝播する", () => {
    const sections = buildModelCatalog({
      activeProvider: "openai-compatible",
      providerModels: [
        {
          provider: "openai-compatible",
          endpointId: "ep-resp",
          endpointLabel: "Responses gateway",
          variant: "responses",
          models: [m("gpt-5.5")],
        },
      ],
    });
    expect(sections[0].models[0].variant).toBe("responses");
  });

  it("同一 endpointId が複数来ても最初の非空を採用(冪等)", () => {
    const sections = buildModelCatalog({
      activeProvider: "openai-compatible",
      providerModels: [
        {
          provider: "openai-compatible",
          endpointId: "ep1",
          models: [m("a")],
        },
        {
          provider: "openai-compatible",
          endpointId: "ep1",
          models: [m("b")],
        },
      ],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].models.map((x) => x.id)).toEqual(["a"]);
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

describe("applyModelWhitelist", () => {
  const sections = buildModelCatalog({
    activeProvider: "openrouter",
    providerModels: [
      {
        provider: "openrouter",
        models: [m("anthropic/claude-opus-4.8"), m("openai/gpt-5.5")],
      },
      { provider: "openai", models: [m("gpt-5.5"), m("gpt-5-mini")] },
      { provider: "anthropic", models: [m("claude-opus-4.8")] },
    ],
  });

  it("空 whitelist は全件そのまま(絞り込み無効)", () => {
    expect(applyModelWhitelist(sections, [])).toEqual(sections);
  });

  it("一致するモデルがあるセクションだけを絞り、未選択プロバイダは全件を保つ", () => {
    // active(openrouter)の1件と、別プロバイダ(openai)の1件をチェック。
    const out = applyModelWhitelist(sections, [
      "anthropic/claude-opus-4.8",
      "gpt-5.5",
    ]);
    expect(out.map((s) => s.provider)).toEqual([
      "openrouter",
      "openai",
      "anthropic",
    ]);
    expect(
      out.find((s) => s.provider === "openrouter")?.models.map((x) => x.id),
    ).toEqual(["anthropic/claude-opus-4.8"]);
    expect(
      out.find((s) => s.provider === "openai")?.models.map((x) => x.id),
    ).toEqual(["gpt-5.5"]);
    // このセクションに一致する保存値はないため「未選択」として全件表示。
    expect(
      out.find((s) => s.provider === "anthropic")?.models.map((x) => x.id),
    ).toEqual(["claude-opus-4.8"]);
  });

  it("ローカルモデルだけの保存値でクラウドの全セクションを消さない(回帰 gate)", () => {
    expect(applyModelWhitelist(sections, ["gemma4:latest"])).toEqual(sections);
  });

  it("アクティブプロバイダに一致がなければ capability 用モデルも全件を保つ", () => {
    const models = [m("claude-opus-4.8"), m("claude-sonnet-4.6")];
    expect(applyModelWhitelistToModels(models, ["gemma4:latest"])).toBe(models);
    expect(
      applyModelWhitelistToModels(models, ["claude-sonnet-4.6"]).map(
        (model) => model.id,
      ),
    ).toEqual(["claude-sonnet-4.6"]);
  });
});
