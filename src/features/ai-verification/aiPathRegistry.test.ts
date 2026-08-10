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
import ts from "typescript";
import {
  AI_AUDIT_RENDERER_CALLSITES,
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
  "contract",
];

/**
 * Same-transport surfaces are deliberately listed separately.  Scanning only
 * the raw IPC command cannot distinguish (for example) a synopsis from a
 * Chronicle extraction, so this list is the regression boundary for the
 * production inventory that must remain auditable.
 */
const REQUIRED_AUDITED_PATH_IDS = [
  "chat_agent_main",
  "agent_research_subagent",
  "context_creator",
  "synopsis",
  "session_title",
  "summarization",
  "foreshadow_audit_chapter",
  "foreshadow_propose_past_setups",
  "foreshadow_evaluate_setup_strength",
  "plot_thread_propose",
  "chronicle_extract",
  "narrative_observation_extract",
  "narrative_event_synthesize",
  "narrative_entity_resolve",
  "narrative_relation_synthesize",
  "narrative_structured_repair",
  "beat_role",
  "codex_judgment",
  "codex_yomi",
  "map_branch",
  "tree_scaffold",
  "ai_connection_test",
  "ab_chat",
  "ab_inline",
  "chat_stream_non_agent",
  "inline_ai_stream",
  "beat_generation",
  "beat_alternative",
  "beats_from_synopsis",
  "synopsis_from_beats",
  "codex_app_server",
  "codex_app_cli_fallback",
  "cli_chat_stream",
  "post_effect_intent_drift",
  "post_effect_review",
  "post_effect_consistency",
  "post_effect_intra_scene_consistency",
  "post_effect_typo_detection",
  "post_effect_meta_structure",
  "post_effect_timeline_consistency",
  "post_effect_pseudo_comment",
  "post_effect_live_pseudo_comment",
  "post_effect_impact_review",
  "semantic_search",
  "semantic_embedding_index",
  "semantic_reranker",
  "semantic_reranker_shadow",
] as const;

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
  codex_app_start_turn: ["codex_app_start_turn"],
  test_ai_connection: ["test_ai_connection"],
  // post-effect: JS は start_post_effect_run(_multi) で起動 → Rust 内 call_post_effect_api。
  start_post_effect_run: ["call_post_effect_api"],
  start_post_effect_run_multi: ["call_post_effect_api"],
  // 埋め込み / 全文検索（LLM 生成ではないが AI サーフェスとして網羅対象）。
  semantic_search: ["semantic_search (Rust ONNX)"],
  codex_semantic_search: ["semantic_search (Rust ONNX)"],
  events_semantic_search: ["semantic_search (Rust ONNX)"],
  chat_message_search: ["semantic_search (Rust ONNX)"],
  semantic_index_scene: ["semantic_index_* (Rust ONNX)"],
  semantic_reindex_all: ["semantic_index_* (Rust ONNX)"],
  codex_index_entry: ["semantic_index_* (Rust ONNX)"],
  codex_reindex_all: ["semantic_index_* (Rust ONNX)"],
  events_index_entry: ["semantic_index_* (Rust ONNX)"],
  events_reindex_all: ["semantic_index_* (Rust ONNX)"],
  chat_index_message: ["semantic_index_* (Rust ONNX)"],
  chat_reindex_all: ["semantic_index_* (Rust ONNX)"],
  fts_search: ["fts_search (Rust SQLite)"],
  semantic_reranker_shadow_score: ["semantic_reranker_score (Rust ONNX)"],
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

function callCarriesLiteralAuditPath(input: {
  sourceRef: string;
  dispatchCall: string;
  auditProperty: "pathId" | "auditPathId";
  pathId: string;
}): boolean {
  const absolute = join(REPO_ROOT, input.sourceRef);
  const sourceText = readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(
    absolute,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let matched = false;

  const callHasLiteral = (call: ts.CallExpression): boolean => {
    const callee = call.expression.getText(sourceFile);
    if (callee !== input.dispatchCall) return false;
    let hasLiteral = false;
    const inspect = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(sourceFile) === input.auditProperty &&
        ts.isStringLiteral(node.initializer) &&
        node.initializer.text === input.pathId
      ) {
        hasLiteral = true;
        return;
      }
      ts.forEachChild(node, inspect);
    };
    for (const argument of call.arguments) inspect(argument);
    return hasLiteral;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callHasLiteral(node)) {
      matched = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matched;
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

  it("全production AI経路が監査ownerとcapture levelを持つ", () => {
    for (const path of AI_PATHS) {
      expect(path, `${path.id} auditOwner`).toHaveProperty("auditOwner");
      expect(path, `${path.id} captureLevel`).toHaveProperty("captureLevel");
      expect(
        (path as unknown as { auditOwner?: string }).auditOwner?.length,
        `${path.id} auditOwner`,
      ).toBeGreaterThan(0);
      expect(
        (path as unknown as { captureLevel?: string }).captureLevel,
        `${path.id} captureLevel`,
      ).not.toBe("unassigned");
    }
  });

  it("full/partial-observable 経路は実在する監査contract testへ対応する", () => {
    const observablePaths = AI_PATHS.filter((path) =>
      ["full-observable", "partial-observable"].includes(path.captureLevel),
    );
    expect(observablePaths.length).toBeGreaterThan(0);
    for (const path of observablePaths) {
      const contract = path as unknown as {
        auditTestRef?: string | null;
        auditTestName?: string;
      };
      expect(contract.auditTestRef, `${path.id} auditTestRef`).toBeTruthy();
      expect(contract.auditTestName, `${path.id} auditTestName`).toBeTruthy();
      const absolute = join(REPO_ROOT, contract.auditTestRef as string);
      expect(
        existsSync(absolute),
        `${path.id} の auditTestRef が存在しない: ${contract.auditTestRef}`,
      ).toBe(true);
      expect(
        readFileSync(absolute, "utf8").includes(
          contract.auditTestName as string,
        ),
        `${path.id} の監査contract ${contract.auditTestName} が ${contract.auditTestRef} に無い`,
      ).toBe(true);
    }
  });

  it("classifies the instrumented native connection probe as full-observable", () => {
    const connectionProbe = AI_PATHS.find(
      (path) => path.id === "ai_connection_test",
    );
    expect(connectionProbe).toMatchObject({
      captureLevel: "full-observable",
      auditTestName: "AI audit path: ai_connection_test",
    });
    expect(connectionProbe?.note).toContain("完全なJSON値");
    expect(connectionProbe?.note).toContain("object key orderは非保持");
    expect(connectionProbe?.note).toContain(
      "共通observerを通らないnative HTTP経路",
    );
  });

  it("同一transport上のproduction surfaceも個別の監査経路として登録する", () => {
    const registered = new Set(AI_PATHS.map((path) => path.id));
    for (const id of REQUIRED_AUDITED_PATH_IDS) {
      expect(registered.has(id), `${id} が AI_PATHS に未登録`).toBe(true);
    }
  });

  it("full/partial-observable renderer経路は実production callsiteに結線される", () => {
    const callsitePathIds = new Set(
      AI_AUDIT_RENDERER_CALLSITES.map((callsite) => callsite.pathId),
    );
    const rendererOwners = new Set([
      "renderer-agent",
      "renderer-single-shot",
      "renderer-stream",
      "electron-runtime",
    ]);
    const required = AI_PATHS.filter(
      (path) =>
        ["full-observable", "partial-observable"].includes(path.captureLevel) &&
        rendererOwners.has(path.auditOwner),
    );
    for (const path of required) {
      expect(
        callsitePathIds.has(path.id),
        `${path.id} は実production callsite契約が必要`,
      ).toBe(true);
    }
  });

  it.each(AI_AUDIT_RENDERER_CALLSITES)(
    "renderer audit callsite: $pathId ($sourceRef)",
    (callsite) => {
      const absolute = join(REPO_ROOT, callsite.sourceRef);
      expect(
        existsSync(absolute),
        `${callsite.pathId} sourceRef が存在しない: ${callsite.sourceRef}`,
      ).toBe(true);
      expect(
        callCarriesLiteralAuditPath(callsite),
        `${callsite.sourceRef} の ${callsite.dispatchCall}(...) に ` +
          `${callsite.auditProperty}: "${callsite.pathId}" が無い`,
      ).toBe(true);
    },
  );

  it("実検証エントリ(js-live/rust-live/agent-loop/contract)は実在テストを指す", () => {
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

  it("relation injection evalは製品project ledgerから静的に分離される", () => {
    const relationEval = AI_PATHS.find(
      (path) => path.id === "relation_injection",
    );
    expect(relationEval).toEqual(
      expect.objectContaining({
        auditOwner: "evaluation-harness",
        captureLevel: "control-event",
        transport: "direct-fetch (OpenRouter)",
      }),
    );
    expect(relationEval?.testRef).toMatch(/\.live\.test\.ts$/u);
    expect(relationEval?.surface).not.toMatch(/^src\//u);
    expect(relationEval?.note).toContain("製品bundle");
    expect(relationEval?.note).toContain("到達不可");
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

describe("AI runtime route registry — Web Editor direct transports", () => {
  it("registers every browser consent route exactly once", () => {
    expect(AI_RUNTIME_ROUTES.map((route) => route.consentRoute)).toEqual([
      "byok",
    ]);
    const ids = AI_RUNTIME_ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies the final-body BrowserMock runtime route as full-observable", () => {
    expect(
      AI_RUNTIME_ROUTES.find((route) => route.id === "browser_byok_web"),
    ).toMatchObject({
      auditOwner: "browser-runtime",
      captureLevel: "full-observable",
    });
  });

  it("assigns every runtime route a capability decision and executable contract verifier", () => {
    for (const route of AI_RUNTIME_ROUTES) {
      expect(route, `${route.id} auditOwner`).toHaveProperty("auditOwner");
      expect(route, `${route.id} captureLevel`).toHaveProperty("captureLevel");
      expect(route, `${route.id} auditTestRef`).toHaveProperty("auditTestRef");
      expect(route, `${route.id} auditTestName`).toHaveProperty(
        "auditTestName",
      );
      expect(route.providers.length, `${route.id} providers`).toBeGreaterThan(
        0,
      );
      expect(route.providers).not.toContain("cli");
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

  it("keeps provider authority under user selection", () => {
    for (const route of AI_RUNTIME_ROUTES) {
      expect(route.providerAuthority).toBe("user-selection");
    }
  });
});
