/**
 * AI 経路レジストリの **完全性メタテスト**（非ライブ・キー不要・通常スイートで実行）。
 *
 * 「全ての経路を検証できる」ことの機械チェック可能な保証:
 *   - 生成経路の各層（agent / single-shot / streaming / post-effect / cli）が
 *     レジストリに最低 1 つ存在し、検証手段が割り当たっている（無検証の穴が無い）。
 *   - js-live / rust-live / covered-by-agent-loop の testRef は **実在ファイル**。
 *   - 自動検証不可（cli 等）は stub として **note で gap を明示**（暗黙の取りこぼし禁止）。
 *   - n/a は LLM 生成でない層（embedding）にのみ許す。
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import {
  AI_PATHS,
  GENERATION_LAYERS,
  type AiPathLayer,
  type AiPathVerifier,
} from "./aiPathRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/features/ai-verification → リポジトリルートまで 3 階層上がる。
const REPO_ROOT = resolve(HERE, "../../..");

const REAL_VERIFIERS: AiPathVerifier[] = [
  "js-live",
  "rust-live",
  "covered-by-agent-loop",
];

describe("AI path registry — completeness", () => {
  it("経路 ID は一意", () => {
    const ids = AI_PATHS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("全エントリが label / surface / note を持つ", () => {
    for (const p of AI_PATHS) {
      expect(p.label.length, p.id).toBeGreaterThan(0);
      expect(p.surface.length, p.id).toBeGreaterThan(0);
      expect(p.note.length, p.id).toBeGreaterThan(0);
    }
  });

  it("実検証エントリ(js-live/rust-live/covered-by-agent-loop)は実在テストを指す", () => {
    const real = AI_PATHS.filter((p) => REAL_VERIFIERS.includes(p.verifier));
    expect(real.length).toBeGreaterThan(0);
    for (const p of real) {
      expect(p.testRef, `${p.id} は testRef 必須`).not.toBeNull();
      const abs = join(REPO_ROOT, p.testRef as string);
      expect(
        existsSync(abs),
        `${p.id} の testRef が存在しない: ${p.testRef}`,
      ).toBe(true);
    }
  });

  it("stub は testRef=null かつ gap を note で明示", () => {
    for (const p of AI_PATHS.filter((p) => p.verifier === "stub")) {
      expect(p.testRef, `${p.id} stub は testRef=null`).toBeNull();
      expect(p.note.length, `${p.id} stub は gap を説明`).toBeGreaterThan(10);
    }
  });

  it("n/a は埋め込み層(LLM 生成でない)にのみ許す", () => {
    for (const p of AI_PATHS.filter((p) => p.verifier === "n/a")) {
      expect(p.layer, `${p.id} は生成経路なのに n/a`).toBe("embedding");
    }
  });

  it("生成経路には無検証(n/a)の穴が無い", () => {
    for (const p of AI_PATHS) {
      if (GENERATION_LAYERS.includes(p.layer)) {
        expect(p.verifier, `生成経路 ${p.id} が n/a`).not.toBe("n/a");
      }
    }
  });

  it("全ての生成経路の層が最低 1 つレジストリに存在する", () => {
    const present = new Set<AiPathLayer>(AI_PATHS.map((p) => p.layer));
    for (const layer of GENERATION_LAYERS) {
      expect(present.has(layer), `生成経路の層 "${layer}" が未登録`).toBe(true);
    }
  });
});
