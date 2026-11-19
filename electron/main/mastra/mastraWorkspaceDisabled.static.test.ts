/**
 * Mastra の workspace／skills を有効にしないことの静的検査（Mastra 移行 MP-3a、DR-MP3-14／15）。
 *
 * picomatch（GHSA-fc5q の期限つきの例外）は `@mastra/core` の workspace-skills の chunk だけが import する。
 * 例外は「workspace を有効にしない」ことを前提にするので、`electron/` の製品 code に、Mastra の workspace・skills を
 * 有効にする呼出しが無いことを固定する。bundle 側の固定（importer が workspace-skills の chunk だけ）は
 * electron/scripts/mastra-ee-check.mjs の `--dist`。実行時の tool 名の許可リストは MP-3c。
 *
 * - `@mastra/` を import してよい file は `electron/main/mastra/` の下だけ（その下に何が増えても、場所の規則だけを固定する）。
 * - 全ての製品 code：`addWorkspace`、`__setWorkspace`、`new Workspace(`、`new Mastra(`、`@mastra/core/workspace` が無い。
 * - `@mastra/` を import する file：`workspace`・`skills`・`memory`・`mcp` 系・`browser` の欄を設定に渡さない
 *   （memory は MP-7 以降の MP が、この試験を意図して改訂する）。
 * - 3 つ目の bundle（`mastra-agent.cjs`）は、MP-3a では製品のどこからも参照しない。
 * - 陰性対照：合成した違反の source を、同じ検査が検出する。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MASTRA_DIR = path.join("electron", "main", "mastra");

/** コメントを除く（コメントと説明の言及は違反にしない）。文字列の中の `//` を壊さない。 */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function productSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(?:ts|tsx|mts|cts)$/.test(entry.name) &&
        !/\.(?:test|spec)\.tsx?$/.test(entry.name) &&
        !/\.d\.ts$/.test(entry.name)
      ) {
        out[path.relative(repoRoot, full)] = fs.readFileSync(full, "utf8");
      }
    }
  };
  for (const sub of ["main", "shared", "preload"]) {
    walk(path.join(repoRoot, "electron", sub));
  }
  return out;
}

const MASTRA_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']@mastra\//;

/** どの製品 code にも出てはならない、workspace を有効にする呼出し。 */
const GLOBAL_FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["addWorkspace", /\baddWorkspace\b/],
  ["__setWorkspace", /\b__setWorkspace\b/],
  ["new Workspace(", /\bnew\s+Workspace\s*\(/],
  ["new Mastra(", /\bnew\s+Mastra\s*\(/],
  ["@mastra/core/workspace", /@mastra\/core\/workspace/],
  ["mastra-agent の参照", /mastra-agent(?:\.cjs)?/],
];

/** `@mastra/` を import する file の設定に渡してはならない欄（object の key か property の代入）。 */
const MASTRA_FILE_FORBIDDEN_KEYS: ReadonlyArray<readonly [string, RegExp]> = [
  ["workspace", /(?:^|[\s{,(])workspace\s*:/m],
  ["skills", /(?:^|[\s{,(])skills\s*:/m],
  ["skillPaths", /\bskillPaths\b/],
  ["memory", /(?:^|[\s{,(])memory\s*:/m],
  ["mcp", /(?:^|[\s{,(])(?:mcp|mcpClients|mcpServers)\s*:/m],
  ["browser", /(?:^|[\s{,(])browser\s*:/m],
  [".workspace =", /\.workspace\s*=[^=]/],
];

/** 違反の一覧。`allowMastraImport` はその file が `@mastra/` を import してよいか。 */
function violations(sources: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const code = codeOf(text);
    const inMastraDir = file.startsWith(MASTRA_DIR + path.sep);
    const importsMastra = MASTRA_IMPORT.test(code);
    if (importsMastra && !inMastraDir) {
      found.push(
        `${file}: @mastra/ の import が electron/main/mastra/ の外にある`,
      );
    }
    for (const [label, pattern] of GLOBAL_FORBIDDEN) {
      if (pattern.test(code)) found.push(`${file}: ${label}`);
    }
    if (importsMastra) {
      for (const [label, pattern] of MASTRA_FILE_FORBIDDEN_KEYS) {
        if (pattern.test(code)) {
          found.push(`${file}: Mastra の設定に ${label} を渡している`);
        }
      }
    }
  }
  return found.sort();
}

describe("Mastra の workspace／skills を有効にしない（picomatch の例外の前提）", () => {
  it("electron/ の製品 code に、workspace・skills を有効にする呼出しも、electron/main/mastra/ の外の @mastra/ の import も無い", () => {
    const sources = productSources();
    // 走査が何も見ていないわけではない。最小の entry（3 つ目の bundle の入口）が対象に入っている。
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const entry = path.join(MASTRA_DIR, "agentRuntime.ts");
    expect(Object.keys(sources)).toContain(entry);
    expect(MASTRA_IMPORT.test(codeOf(sources[entry]))).toBe(true);
    expect(violations(sources)).toEqual([]);
  });

  it("`@mastra/` を import する製品 code は electron/main/mastra/ の下だけ（agentRuntime.ts を含む。MP-2 の adapter などの追加は、この下なら許す）", () => {
    const importers = Object.entries(productSources())
      .filter(([, text]) => MASTRA_IMPORT.test(codeOf(text)))
      .map(([file]) => file);
    expect(importers).toContain(path.join(MASTRA_DIR, "agentRuntime.ts"));
    for (const file of importers) {
      expect(file.startsWith(MASTRA_DIR + path.sep), file).toBe(true);
    }
  });

  it("陰性対照：合成した違反の source を、同じ検査が全部検出する", () => {
    const base = 'import { Agent } from "@mastra/core/agent";\n';
    const cases: Record<string, string> = {
      "electron/main/a.ts": 'import { Agent } from "@mastra/core/agent";',
      "electron/main/b.ts": 'const m = require("@mastra/core");',
      "electron/main/c.ts": 'const m = await import("@mastra/memory");',
      "electron/main/d.ts": "x.addWorkspace(w);",
      "electron/main/e.ts": "agent.__setWorkspace(w);",
      "electron/main/f.ts": "const w = new Workspace({});",
      "electron/main/g.ts": "const m = new Mastra({});",
      "electron/main/h.ts": 'import { W } from "@mastra/core/workspace";',
      "electron/main/i.ts":
        'const p = require(path.join(dir, "mastra-agent.cjs"));',
      [path.join(MASTRA_DIR, "w.ts")]: `${base}new Agent({ workspace: w });`,
      [path.join(MASTRA_DIR, "s.ts")]: `${base}new Agent({ skills: ["x"] });`,
      [path.join(MASTRA_DIR, "m.ts")]: `${base}new Agent({ memory: m });`,
      [path.join(MASTRA_DIR, "p.ts")]: `${base}const o = { skillPaths: [] };`,
      [path.join(MASTRA_DIR, "q.ts")]: `${base}new Agent({ mcpClients: {} });`,
      [path.join(MASTRA_DIR, "r.ts")]: `${base}new Agent({ browser: b });`,
      [path.join(MASTRA_DIR, "t.ts")]: `${base}agent.workspace = w;`,
    };
    const found = violations(cases);
    for (const file of Object.keys(cases)) {
      expect(
        found.some((line) => line.startsWith(`${file}:`)),
        `${file} を検出する`,
      ).toBe(true);
    }
    // コメントの言及、mastra/ の中の正当な import、他の欄は違反にしない。
    expect(
      violations({
        [path.join(MASTRA_DIR, "ok.ts")]:
          `${base}// workspace: skills: addWorkspace\nnew Agent({ id: "a", name: "n", instructions: "i", model });`,
        "electron/main/ok2.ts":
          "/* addWorkspace */ const workspace: string = 'x'; // new Mastra(",
      }),
    ).toEqual([]);
  });
});
