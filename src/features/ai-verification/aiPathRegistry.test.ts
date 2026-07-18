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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  AI_PATHS,
  AI_RUNTIME_ROUTES,
  GENERATION_LAYERS,
  type AiPathLayer,
  type AiPathVerifier,
} from "./aiPathRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/features/ai-verification → リポジトリルートまで 3 階層上がる。
const REPO_ROOT = resolve(HERE, "../../..");
const SRC_ROOT = resolve(HERE, "../..");

const REAL_VERIFIERS: AiPathVerifier[] = [
  "js-live",
  "rust-live",
  "covered-by-agent-loop",
];

/**
 * JS から observable な「AI トランスポート」Tauri command と、それを網羅すべき
 * レジストリ側 transport のマッピング。
 *
 * なぜ command→registry のマップが要るか: レジストリの transport フィールドは
 * 常に JS の invoke command 名と一致しない。post-effect は JS からは
 * start_post_effect_run(_multi) で起動し Rust 内部で call_post_effect_api を叩く。
 * CLI は registry 上 "subprocess (cli:stream-*)" だが実 invoke は send_cli_chat_stream。
 * そこでここで「本番 src/ に現れたら、この registry transport が最低 1 つ必要」を宣言する。
 */
const AI_TRANSPORT_COMMANDS: Record<string, string[]> = {
  send_agent_message: ["send_agent_message"],
  send_chat_message: ["send_chat_message"],
  send_chat_message_stream: ["send_chat_message_stream"],
  send_inline_ai_stream: ["send_inline_ai_stream"],
  // CLI: JS invoke は send_cli_chat_stream、registry は subprocess 表記。
  send_cli_chat_stream: ["subprocess (cli:stream-*)"],
  // post-effect: JS は start_post_effect_run(_multi) で起動 → Rust 内 call_post_effect_api。
  start_post_effect_run: ["call_post_effect_api"],
  start_post_effect_run_multi: ["call_post_effect_api"],
  // 埋め込み / 全文検索（LLM 生成ではないが AI サーフェスとして網羅対象）。
  semantic_search: ["semantic_search (Rust ONNX)"],
  fts_search: ["fts_search (Rust SQLite)"],
};

/**
 * src/ を再帰走査し、本番コードで実際に invoke されている AI transport command を集める。
 * - test ファイル（*.test.ts(x), *.live.test.ts）と本レジストリ自身は除外。
 * - 行コメント（//）は雑に除去してコメント内の文字列マッチを減らす（ブロック
 *   コメント等は完璧でないが、誤検出は「過剰に網羅扱い」側＝安全側に倒れる）。
 */
function scanInvokedAiCommands(): Set<string> {
  const found = new Set<string>();
  const commandNames = Object.keys(AI_TRANSPORT_COMMANDS);
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(ent.name)) continue;
      if (/\.test\.tsx?$/.test(ent.name)) continue;
      if (full === resolve(HERE, "aiPathRegistry.ts")) continue;
      const text = readFileSync(full, "utf8");
      for (const rawLine of text.split("\n")) {
        // 行コメントを除去（文字列内の // は雑だが安全側）。
        const line = rawLine.replace(/\/\/.*$/, "");
        for (const cmd of commandNames) {
          // invoke("cmd" / invoke<T>("cmd" の形のみを AI 呼び出しとみなす。
          // [^(]* は <T> ジェネリクス（括弧を含まない）も飲み込むため両形を網羅。
          if (new RegExp(`invoke[^(]*\\(\\s*"${cmd}"`).test(line)) {
            found.add(cmd);
          }
        }
      }
    }
  };
  walk(SRC_ROOT);
  return found;
}

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

  // ── FINDING A: 本番ツリー走査でレジストリ追加漏れを落とす ──────────────────
  //
  // これまでのメタテストは AI_PATHS の自己整合性しか見ておらず、新しい AI サーフェスを
  // 足してレジストリ登録を忘れても全部 green のままだった（ハーネスが「追加漏れを
  // 捕まえる」と謳う当の case）。ここで本番 src/ を実走査し、実際に invoke されている
  // AI transport が必ずレジストリのどれかにマップされることを assert する。
  it("本番 src/ で invoke される AI transport は全てレジストリに登録済み", () => {
    const used = scanInvokedAiCommands();
    // 自明な健全性: 少なくとも主要 transport が拾えていること（走査自体が壊れて
    // 空集合になり常に green になる退行を防ぐ）。
    expect(
      used.size,
      "AI transport を 1 つも検出できなかった（走査が壊れている可能性）",
    ).toBeGreaterThan(0);

    const registeredTransports = new Set(AI_PATHS.map((p) => p.transport));
    for (const cmd of used) {
      const acceptable = AI_TRANSPORT_COMMANDS[cmd] ?? [];
      const covered = acceptable.some((t) => registeredTransports.has(t));
      expect(
        covered,
        `本番で invoke される AI transport "${cmd}" を網羅するレジストリ ` +
          `エントリが無い（transport=${acceptable.join("|")} のいずれかを ` +
          `AI_PATHS に登録すること）`,
      ).toBe(true);
    }
  }, 30_000); // src/ 全走査は数秒かかるため既定 5s を引き上げる

  // ── FINDING B: testName 指定エントリは参照先テストに当該テストが実在する ──────
  //
  // existsSync だけだと「ファイルはあるが、その経路のテストは無い」を見逃す。
  // testName を持つエントリは testRef を読み込み、テスト名（it/describe 文字列、
  // または Rust の fn 名）が含まれることまで照合する。testName は任意（後方互換）。
  it("testName 指定エントリは参照先ファイルに当該テスト名が実在する", () => {
    const withName = AI_PATHS.filter((p) => p.testName);
    expect(
      withName.length,
      "testName を持つエントリが 1 つも無い（FINDING B の照合が無効）",
    ).toBeGreaterThan(0);
    for (const p of withName) {
      expect(
        p.testRef,
        `${p.id} testName 指定なら testRef 必須`,
      ).not.toBeNull();
      const abs = join(REPO_ROOT, p.testRef as string);
      expect(existsSync(abs), `${p.id} の testRef が存在しない`).toBe(true);
      const content = readFileSync(abs, "utf8");
      expect(
        content.includes(p.testName as string),
        `${p.id} の testRef (${p.testRef}) に testName "${p.testName}" が見つからない`,
      ).toBe(true);
    }
  }, 30_000); // testRef ファイル読み込みのため既定 5s を引き上げる
});

describe("AI runtime route registry — web and hosted transports", () => {
  it("registers Scan upload, Hosted Editor, and standalone browser BYOK exactly once", () => {
    expect(AI_RUNTIME_ROUTES.map((route) => route.consentRoute).sort()).toEqual(
      ["byok", "hosted-editor", "scan"],
    );
    const ids = AI_RUNTIME_ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("assigns every runtime route a capability decision and executable contract verifier", () => {
    for (const route of AI_RUNTIME_ROUTES) {
      expect(route.surface.length, `${route.id} surface`).toBeGreaterThan(0);
      expect(route.transport.length, `${route.id} transport`).toBeGreaterThan(
        0,
      );
      expect(
        route.capabilityGate.length,
        `${route.id} capabilityGate`,
      ).toBeGreaterThan(0);
      expect(route.verifier, `${route.id} verifier`).toBe("contract");
      const abs = join(REPO_ROOT, route.testRef);
      expect(existsSync(abs), `${route.id} testRef が存在しない`).toBe(true);
      expect(
        readFileSync(abs, "utf8").includes(route.testName),
        `${route.id} の testRef に testName "${route.testName}" が無い`,
      ).toBe(true);
    }
  });

  it("proves every runtime route fails closed at its consent boundary", () => {
    for (const route of AI_RUNTIME_ROUTES) {
      const abs = join(REPO_ROOT, route.consentTestRef);
      expect(existsSync(abs), `${route.id} consentTestRef が存在しない`).toBe(
        true,
      );
      expect(
        readFileSync(abs, "utf8").includes(route.consentTestName),
        `${route.id} の consentTestRef に consentTestName "${route.consentTestName}" が無い`,
      ).toBe(true);
      expect(route.note.length, `${route.id} note`).toBeGreaterThan(20);
    }
  });

  it("keeps provider authority explicit for hosted and BYOK paths", () => {
    for (const route of AI_RUNTIME_ROUTES) {
      expect(route.providerAuthority).toBe(
        route.consentRoute === "byok" ? "user-selection" : "server-runtime",
      );
    }
  });
});
