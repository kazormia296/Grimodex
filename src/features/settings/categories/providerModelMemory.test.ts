import { describe, it, expect } from "vitest";
import {
  readModelByProvider,
  applyProviderSwitch,
  rememberModel,
  type ModelByProvider,
} from "./providerModelMemory";

describe("readModelByProvider", () => {
  it("空/未設定は空マップ", () => {
    expect(readModelByProvider("")).toEqual({});
    expect(readModelByProvider("{}")).toEqual({});
  });

  it("壊れた JSON は空マップにフォールバック", () => {
    expect(readModelByProvider("not json")).toEqual({});
    expect(readModelByProvider("[1,2,3]")).toEqual({});
  });

  it("{model, variant} エントリをパースする", () => {
    const raw = JSON.stringify({
      openrouter: { model: "anthropic/claude", variant: null },
      openai: { model: "gpt-4o", variant: "responses" },
      sakana: { model: "fugu", variant: "responses" },
    });
    expect(readModelByProvider(raw)).toEqual({
      openrouter: { model: "anthropic/claude", variant: null },
      openai: { model: "gpt-4o", variant: "responses" },
      sakana: { model: "fugu", variant: "responses" },
    });
  });

  it("不正なエントリ(model欠落/空/非オブジェクト)と未知 variant を弾く", () => {
    const raw = JSON.stringify({
      openrouter: { model: "ok/model", variant: "bogus" }, // variant→null
      openai: { variant: "responses" }, // model 欠落→除外
      anthropic: "string-form", // 旧文字列形式→除外
      ollama: { model: "", variant: null }, // 空 model→除外
    });
    expect(readModelByProvider(raw)).toEqual({
      openrouter: { model: "ok/model", variant: null },
    });
  });
});

describe("applyProviderSwitch", () => {
  it("切替元の(モデル+variant)を焼き込み、切替先の前回記憶を返す", () => {
    const map: ModelByProvider = { openai: { model: "gpt-4o", variant: null } };
    const { map: next, restored } = applyProviderSwitch(
      map,
      "openrouter",
      { model: "anthropic/claude-opus", variant: null },
      "openai",
    );
    expect(next.openrouter).toEqual({
      model: "anthropic/claude-opus",
      variant: null,
    });
    expect(restored).toEqual({ model: "gpt-4o", variant: null });
  });

  it("variant も含めて復元する(Responses トグル状態の保持)", () => {
    const map: ModelByProvider = {
      openai: { model: "gpt-5", variant: "responses" },
    };
    const { restored } = applyProviderSwitch(
      map,
      "anthropic",
      { model: "claude", variant: null },
      "openai",
    );
    expect(restored).toEqual({ model: "gpt-5", variant: "responses" });
  });

  it("切替先に履歴が無ければ restored は undefined", () => {
    const { restored } = applyProviderSwitch(
      {},
      "openrouter",
      { model: "x-ai/grok", variant: null },
      "anthropic",
    );
    expect(restored).toBeUndefined();
  });

  it("切替元モデルが空なら焼き込まない(stale な空上書きを避ける)", () => {
    const map: ModelByProvider = {
      openrouter: { model: "kept/model", variant: null },
    };
    const { map: next } = applyProviderSwitch(
      map,
      "openrouter",
      { model: "", variant: null },
      "openai",
    );
    expect(next.openrouter).toEqual({ model: "kept/model", variant: null });
  });

  it("元マップを破壊しない(イミュータブル)", () => {
    const map: ModelByProvider = { openai: { model: "gpt-4o", variant: null } };
    applyProviderSwitch(
      map,
      "openai",
      { model: "gpt-4o", variant: null },
      "anthropic",
    );
    expect(map).toEqual({ openai: { model: "gpt-4o", variant: null } });
  });

  it("往復(A→B→A)で A のモデル+variant が復元される", () => {
    let map: ModelByProvider = {};
    let r = applyProviderSwitch(
      map,
      "openrouter",
      { model: "or/model", variant: null },
      "openai",
    );
    map = r.map;
    expect(r.restored).toBeUndefined(); // openai は初回
    r = applyProviderSwitch(
      map,
      "openai",
      { model: "oa/model", variant: "responses" },
      "openrouter",
    );
    map = r.map;
    expect(r.restored).toEqual({ model: "or/model", variant: null });
    r = applyProviderSwitch(
      map,
      "openrouter",
      { model: "or/model", variant: null },
      "openai",
    );
    expect(r.restored).toEqual({ model: "oa/model", variant: "responses" });
  });
});

describe("rememberModel", () => {
  it("非空モデルは現在プロバイダに(モデル+variant)を記録する", () => {
    expect(rememberModel({}, "openai", "gpt-4o", "responses")).toEqual({
      openai: { model: "gpt-4o", variant: "responses" },
    });
  });

  it("空モデルはエントリを削除する(既定に戻す→stale 復元しない)", () => {
    expect(
      rememberModel(
        { openai: { model: "gpt-4o", variant: null } },
        "openai",
        "",
        null,
      ),
    ).toEqual({});
  });

  it("元マップを破壊しない(イミュータブル)", () => {
    const map: ModelByProvider = { openai: { model: "gpt-4o", variant: null } };
    rememberModel(map, "anthropic", "claude", null);
    expect(map).toEqual({ openai: { model: "gpt-4o", variant: null } });
  });
});
