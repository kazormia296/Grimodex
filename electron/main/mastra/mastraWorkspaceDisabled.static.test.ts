/**
 * Mastra の workspace／skills を有効にしないことの静的検査（Mastra 移行 MP-3a、DR-MP3-14／15）。
 *
 * picomatch（GHSA-fc5q の期限つきの例外）は `@mastra/core` の workspace-skills の chunk だけが import する。
 * 例外は「workspace を有効にしない」ことを前提にするので、製品 code に、Mastra の workspace・skills を
 * 有効にする呼出しが無いことを固定する。bundle 側の固定（importer が workspace-skills の chunk だけ）は
 * electron/scripts/mastra-ee-check.mjs の `--dist`。実行時の tool 名の許可リストは MP-3c。
 *
 * 検査は TypeScript の AST で行う（comment と文字列の中身を取り違えず、shorthand・引用符・computed・spread を拾う）。
 * - 走査：`electron/{main,shared,preload}` と `src/`（試験・spec・stories 以外）。
 * - `@mastra` を含む文字列（import・require・動的 import・template 文字列・型の import）は、全部が module 指定の位置にあり、
 *   許可リスト（MASTRA_IMPORT_ALLOWLIST の完全一致）に載っていて、`electron/main/mastra/` の下の file にある。renderer（`src/`）は 0。
 *   許可リスト外（`workspace`・`skills`・`coding-agent`・`tool-loop-agent` ほか）は落ちる。
 * - 全ての製品 code：`__registerMastra`・`__setWorkspace`・`addWorkspace`・`new Workspace(`・`new Mastra(` と、3 つ目の bundle の参照（MP-3c まで）が無い。
 * - `@mastra` を import する file：`workspace`・`skills`・`skillPaths`・`mcp` 系・`browser` の欄を、設定の object に渡さない
 *   （shorthand・引用符つき・computed・代入・`defineProperty`・new の引数の spread を拾う）。`memory` は MP-9a の `createAgent` に限り許す。
 * - 陰性対照：合成した違反の source を、同じ検査が検出する。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MASTRA_DIR = path.join("electron", "main", "mastra");
/** 3 つ目の bundle の名前を持ってよい唯一の file（MP-3c の lazy loader）。 */
const LOADER_FILE = path.join("electron", "main", "mastraAgentLoader.ts");

/**
 * `@mastra` の module 指定の許可リスト（完全一致）。agentRuntime と MP-8 の main adapters が使う subpath だけ。
 * 型だけの import も含める。足すときは、この試験を意図して改訂する（workspace 系を持ち込まないことを確かめてから）。
 */
const MASTRA_IMPORT_ALLOWLIST: readonly string[] = Object.freeze([
  "@mastra/core/agent",
  "@mastra/memory",
  "@mastra/core/llm",
  // storage・vector の import の閉包の picomatch と workspace の chunk は agent と同じで、到達を防ぐのはこの静的検査と mastra-ee-check の importer の pin（DR-MP3-14・15）。
  "@mastra/core/storage",
  "@mastra/core/tools",
  "@mastra/core/vector",
  "@mastra/memory",
]);

/** 許可リストに載せてはならない subpath（許可リストが誤って広がったときの 2 重の止め）。 */
const FORBIDDEN_SUBPATH =
  /@mastra\/[^/"'`]+\/(?:workspace|skills|coding-agent|tool-loop-agent)(?:\/|$|["'`])/;

/** どの製品 code にも出てはならない識別子・文字列。 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  "__registerMastra",
  "__setWorkspace",
  "addWorkspace",
]);

/** `@mastra` を import する file の設定に渡してはならない欄。 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "workspace",
  "skills",
  "skillPaths",
  "memory",
  "mcp",
  "mcpClients",
  "mcpServers",
  "browser",
]);

const SCAN_FILE = /\.(?:ts|tsx|mts|cts)$/;
const SKIP_FILE = /\.(?:test|spec|stories)\.tsx?$|\.d\.ts$/;

const SCAN_DIRS = [
  path.join("electron", "main"),
  path.join("electron", "shared"),
  path.join("electron", "preload"),
  "src",
];

let cachedSources: Record<string, string> | undefined;

/** 製品 code の全 file。走査は 1 回だけで、全 it が使い回す（Windows では 1 回の走査が長い）。 */
function productSources(): Record<string, string> {
  if (cachedSources !== undefined) return cachedSources;
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (SCAN_FILE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
        out[path.relative(repoRoot, full)] = fs.readFileSync(full, "utf8");
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(path.join(repoRoot, dir));
  cachedSources = out;
  return out;
}

/** 文字列として読める literal の中身（template の head も含む）。 */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

/** import／export from／`import("x")`／`require("x")`／`typeof import("x")`／`import x = require("x")` の指定の位置か。 */
function isSpecifierPosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  ) {
    return true;
  }
  if (
    ts.isExternalModuleReference(parent) ||
    (ts.isLiteralTypeNode(parent) &&
      parent.parent !== undefined &&
      ts.isImportTypeNode(parent.parent))
  ) {
    return true;
  }
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    return (
      parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(parent.expression) &&
        parent.expression.text === "require")
    );
  }
  return false;
}

/** 識別子・文字列・数値の literal から取れる名前（取れなければ undefined）。 */
function nameOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function isNewExpressionArgument(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isNewExpression(parent) &&
    (parent.arguments ?? ([] as ts.Expression[])).some((arg) => arg === node)
  );
}

/** 1 file の違反。 */
function fileViolations(file: string, text: string): string[] {
  const found: string[] = [];
  const inMastraDir = file.startsWith(MASTRA_DIR + path.sep);
  const inRenderer = file.startsWith("src" + path.sep);
  const quick =
    text.includes("@mastra") ||
    /__registerMastra|__setWorkspace|addWorkspace|new\s+Workspace|new\s+Mastra|mastra-agent/.test(
      text,
    );
  if (!quick) return found;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const mastraLiterals: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    const value = literalText(node);
    if (value !== undefined && value.includes("@mastra")) {
      mastraLiterals.push(node);
    }
    if (value !== undefined && /mastra-agent(?:\.cjs)?/.test(value)) {
      // 3 つ目の bundle の名前を持ってよいのは lazy loader の 1 file だけで、そこでも定数（変数の初期値）としてだけ。
      // `require("…mastra-agent…")` のように literal を直に渡すと、esbuild が main.cjs に bundle してしまう。
      const isLoaderConstant =
        file === LOADER_FILE &&
        node.parent !== undefined &&
        ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node;
      if (!isLoaderConstant) found.push(`${file}: mastra-agent の参照`);
    }
    if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text)) {
      found.push(`${file}: ${node.text}`);
    }
    if (
      ts.isStringLiteralLike(node) &&
      FORBIDDEN_NAMES.has(node.text) &&
      !isSpecifierPosition(node)
    ) {
      found.push(`${file}: ${node.text}（文字列）`);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "Workspace" ||
        node.expression.text === "Mastra")
    ) {
      found.push(`${file}: new ${node.expression.text}(`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // `@mastra` を含む literal は、全部が module 指定の位置にあり、許可リストの完全一致で、置いてよい場所にある。
  for (const node of mastraLiterals) {
    const value = literalText(node) ?? "";
    if (!isSpecifierPosition(node)) {
      found.push(
        `${file}: @mastra を含む文字列が module 指定の位置にない（${value}）`,
      );
      continue;
    }
    if (ts.isTemplateExpression(node)) {
      found.push(`${file}: @mastra の動的な module 指定（template 文字列）`);
      continue;
    }
    if (FORBIDDEN_SUBPATH.test(value)) {
      found.push(`${file}: 禁止の subpath を import している（${value}）`);
    }
    if (!MASTRA_IMPORT_ALLOWLIST.includes(value)) {
      found.push(`${file}: 許可リスト外の @mastra の import（${value}）`);
    }
    if (inRenderer) {
      found.push(`${file}: renderer が @mastra を import している`);
    } else if (!inMastraDir) {
      found.push(
        `${file}: @mastra の import が electron/main/mastra/ の外にある`,
      );
    }
  }
  if (mastraLiterals.length === 0) return found;

  // `@mastra` を import する file：設定に workspace などの欄を渡さない。
  const keyViolation = (label: string, name: string) =>
    found.push(`${file}: Mastra の設定に ${name} を渡している（${label}）`);
  const isForbiddenKey = (name: string, node: ts.Node): boolean => {
    if (!FORBIDDEN_KEYS.has(name)) return false;
    if (
      name !== "memory" ||
      file !== path.join("electron", "main", "mastra", "agentRuntime.ts")
    ) {
      return true;
    }
    for (
      let parent: ts.Node | undefined = node.parent;
      parent;
      parent = parent.parent
    ) {
      if (
        ts.isFunctionDeclaration(parent) &&
        parent.name?.text === "createAgent"
      ) {
        return false;
      }
    }
    return true;
  };
  const visitKeys = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
      const nameNode = node.name;
      if (ts.isComputedPropertyName(nameNode)) {
        const computed = nameOf(nameNode.expression);
        if (computed === undefined) {
          found.push(`${file}: 動的な computed key がある`);
        } else if (isForbiddenKey(computed, nameNode)) {
          keyViolation("computed", computed);
        }
      } else {
        const name = nameOf(nameNode);
        if (name !== undefined && isForbiddenKey(name, nameNode)) {
          keyViolation("key", name);
        }
      }
    } else if (
      ts.isShorthandPropertyAssignment(node) &&
      isForbiddenKey(node.name.text, node)
    ) {
      keyViolation("shorthand", node.name.text);
    } else if (
      ts.isSpreadAssignment(node) &&
      isNewExpressionArgument(node.parent)
    ) {
      found.push(
        `${file}: new の引数の object に spread がある（欄を検査できない）`,
      );
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = node.left;
      let name: string | undefined;
      if (ts.isPropertyAccessExpression(left)) name = left.name.text;
      else if (ts.isElementAccessExpression(left)) {
        name = nameOf(left.argumentExpression);
        if (name === undefined)
          found.push(`${file}: 動的な key への代入がある`);
      }
      if (name !== undefined && isForbiddenKey(name, left)) {
        keyViolation("代入", name);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (
        /^(?:Object\.(?:defineProperty|defineProperties)|Reflect\.(?:set|defineProperty))$/.test(
          callee,
        )
      ) {
        const name = nameOf(node.arguments[1]);
        if (name !== undefined && isForbiddenKey(name, node)) {
          keyViolation(callee, name);
        }
      }
    }
    ts.forEachChild(node, visitKeys);
  };
  visitKeys(source);
  return found;
}

/** 違反の一覧（昇順）。 */
function violations(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .flatMap(([file, text]) => fileViolations(file, text))
    .sort();
}

// 全 file の読込みと AST の解析をする it があるので、試験の timeout を長くする（試験の timeout で、製品の閾値ではない）。
describe(
  "Mastra の workspace／skills を有効にしない（picomatch の例外の前提）",
  { timeout: 60_000 },
  () => {
    it("製品 code（electron と src）に、workspace・skills を有効にする呼出しも、許可リスト外・場所外の @mastra の import も無い", () => {
      const sources = productSources();
      // 走査が何も見ていないわけではない。renderer も含み、最小の entry（3 つ目の bundle の入口）が対象に入っている。
      expect(Object.keys(sources).length).toBeGreaterThan(1000);
      expect(
        Object.keys(sources).some((file) => file.startsWith("src" + path.sep)),
      ).toBe(true);
      const entry = path.join(MASTRA_DIR, "agentRuntime.ts");
      expect(Object.keys(sources)).toContain(entry);
      // entry は `@mastra` を import し、それ自体が違反ではない（陽性の確認。違反 0 が「何も見ていない」の結果でない）。
      expect(sources[entry]).toContain('from "@mastra/core/agent"');
      expect(violations({ [entry]: sources[entry] })).toEqual([]);
      expect(violations(sources)).toEqual([]);
    });

    it("3 つ目の bundle を名前で読むのは lazy loader の 1 file だけで、literal でなく変数の `require` で読む（main.cjs に bundle されない）", () => {
      const sources = productSources();
      const holders = Object.entries(sources)
        .filter(([, text]) => {
          const source = ts.createSourceFile(
            "x.ts",
            text,
            ts.ScriptTarget.Latest,
            true,
          );
          let found = false;
          const walk = (node: ts.Node) => {
            const value = literalText(node);
            if (value !== undefined && /mastra-agent/.test(value)) found = true;
            ts.forEachChild(node, walk);
          };
          walk(source);
          return found;
        })
        .map(([file]) => file);
      expect(holders).toEqual([LOADER_FILE]);
      const loader = sources[LOADER_FILE] ?? "";
      // 名前は定数の初期値で、`require` は createRequire の戻り値を変数の引数で呼ぶ。
      expect(loader).toMatch(/const BUNDLE_FILE = "mastra-agent\.cjs"/);
      expect(loader).toMatch(/createRequire\(__filename\)\(target\)/);
      expect(loader).not.toMatch(/require\(\s*["'`]/);
      expect(loader).not.toMatch(/import\s*\(/);
    });

    it("`@mastra` の import は electron/main/mastra/ の下だけ（agentRuntime.ts を含む）で、renderer（src/）からは 0 件", () => {
      const importers = Object.entries(productSources())
        .filter(([, text]) => text.includes("@mastra"))
        .filter(([file, text]) => {
          const source = ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            true,
          );
          let found = false;
          const walk = (node: ts.Node) => {
            const value = literalText(node);
            if (
              value !== undefined &&
              value.includes("@mastra") &&
              isSpecifierPosition(node)
            ) {
              found = true;
            }
            ts.forEachChild(node, walk);
          };
          walk(source);
          return found;
        })
        .map(([file]) => file);
      expect(importers).toContain(path.join(MASTRA_DIR, "agentRuntime.ts"));
      for (const file of importers) {
        expect(file.startsWith(MASTRA_DIR + path.sep), file).toBe(true);
        expect(file.startsWith("src" + path.sep), file).toBe(false);
      }
    });

    it("許可リストは実装済み main adapter の subpath だけで、workspace 系を含まない", () => {
      expect([...MASTRA_IMPORT_ALLOWLIST]).toEqual([
        "@mastra/core/agent",
        "@mastra/memory",
        "@mastra/core/llm",
        "@mastra/core/storage",
        "@mastra/core/tools",
        "@mastra/core/vector",
        "@mastra/memory",
      ]);
      for (const specifier of MASTRA_IMPORT_ALLOWLIST) {
        expect(FORBIDDEN_SUBPATH.test(specifier), specifier).toBe(false);
      }
    });

    it("陰性対照：合成した違反の source を、同じ検査が全部検出する", () => {
      const base = 'import { Agent } from "@mastra/core/agent";\n';
      const inMastra = (name: string) => path.join(MASTRA_DIR, name);
      const cases: Record<string, string> = {
        // import の場所・許可リスト
        "electron/main/a.ts": 'import { Agent } from "@mastra/core/agent";',
        "electron/main/b.ts": 'const m = require("@mastra/core");',
        "electron/main/c.ts": 'const m = await import("@mastra/memory");',
        "src/lib/r.ts": 'import { Agent } from "@mastra/core/agent";',
        [inMastra("i1.ts")]:
          'import { createCodingAgent } from "@mastra/core/coding-agent";',
        [inMastra("i2.ts")]: 'import { x } from "@mastra/core/skills";',
        [inMastra("i3.ts")]: 'import { W } from "@mastra/core/workspace";',
        [inMastra("i4.ts")]:
          'import { T } from "@mastra/core/tool-loop-agent";',
        [inMastra("i5.ts")]: 'import type { E } from "@mastra/core/evals";',
        [inMastra("i6.ts")]: 'export * from "@mastra/core/skills";',
        [inMastra("i7.ts")]:
          'type X = typeof import("@mastra/core/workspace");',
        [inMastra("i8.ts")]:
          'const m = require("@mastra/core/tool-loop-agent");',
        [inMastra("i9.ts")]: "const m = await import(`@mastra/core/${name}`);",
        [inMastra("i10.ts")]:
          "const m = await import(`@mastra/core/workspace`);",
        [inMastra("i11.ts")]:
          'const n = "@mastra/core/" + sub; const m = await import(n);',
        [inMastra("i12.ts")]: 'import x = require("@mastra/core/skills");',
        // 識別子・new・3 つ目の bundle
        "electron/main/d.ts": "x.addWorkspace(w);",
        "electron/main/e.ts": "agent.__setWorkspace(w);",
        "electron/main/e2.ts": "mastra.__registerMastra(m);",
        "electron/main/e3.ts": 'x["addWorkspace"](w);',
        "electron/main/f.ts": "const w = new Workspace({});",
        "electron/main/g.ts": "const m = new Mastra({});",
        "electron/main/i.ts":
          'const p = require(path.join(dir, "mastra-agent.cjs"));',
        // loader でも、literal を呼出しに直に渡す・loader 以外が定数に持つのは違反
        // 文字列を分けて書く（CI の変更範囲の import 走査が、この fixture を本物の require と読まないように）。
        [LOADER_FILE]: "const p = require(" + '"./mastra-agent.cjs"' + ");",
        "electron/main/i2.ts": 'const BUNDLE_FILE = "mastra-agent.cjs";',
        // key（shorthand・引用符・computed・代入・spread・assign・defineProperty）
        [inMastra("w.ts")]: `${base}new Agent({ workspace: w });`,
        [inMastra("w2.ts")]: `${base}new Agent({ id, workspace });`,
        [inMastra("w3.ts")]: `${base}new Agent({ "workspace": w });`,
        [inMastra("w4.ts")]: `${base}agent["workspace"] = w;`,
        [inMastra("w5.ts")]: `${base}new Agent({ ...cfg });`,
        [inMastra("w6.ts")]: `${base}Object.assign(cfg, { skills });`,
        [inMastra("w7.ts")]: `${base}new Agent({ ["work" + "space"]: w });`,
        [inMastra("w8.ts")]: `${base}new Agent({ ['workspace']: w });`,
        [inMastra("w9.ts")]:
          `${base}Object.defineProperty(cfg, "skills", { value: s });`,
        [inMastra("s.ts")]: `${base}new Agent({ skills: ["x"] });`,
        [inMastra("m.ts")]: `${base}new Agent({ memory: m });`,
        [inMastra("p.ts")]: `${base}const o = { skillPaths: [] };`,
        [inMastra("q.ts")]: `${base}new Agent({ mcpClients: {} });`,
        [inMastra("r.ts")]: `${base}new Agent({ browser: b });`,
        [inMastra("t.ts")]: `${base}agent.workspace = w;`,
        // 同じ行に `//` を含む文字列があっても隠れない（正規表現で comment を消す方式の穴）
        [inMastra("u.ts")]:
          `${base}const u = "http://x"; new Agent({ workspace: w });`,
        [inMastra("u2.ts")]:
          `${base}const u = 'a//b'; const w = { skills: s };`,
        // `@mastra` を含む文字列が module 指定の位置にない
        "electron/main/v.ts": 'const note = "@mastra/core/agent";',
      };
      const found = violations(cases);
      for (const file of Object.keys(cases)) {
        expect(
          found.some((line) => line.startsWith(`${file}:`)),
          `${file} を検出する`,
        ).toBe(true);
      }
      // comment の言及、許可リストの import、他の欄、electron の workspace の通常の使い方は違反にしない。
      // loader の定数（変数の初期値）は 3 つ目の bundle の名前を持ってよい。
      expect(
        violations({
          [LOADER_FILE]: 'const BUNDLE_FILE = "mastra-agent.cjs";',
          [inMastra("ok.ts")]:
            `${base}import type { MastraModelConfig } from "@mastra/core/llm";\nimport { createTool } from "@mastra/core/tools";\n// workspace: skills: addWorkspace @mastra/core/skills\n/* new Mastra( */\nnew Agent({ id: "a", name: "n", instructions: "i", model });`,
          "electron/main/ok2.ts":
            "/* addWorkspace */ const workspace: string = 'x'; // new Mastra(\nconst o = { workspace, skills: 1, memory: 2 };",
        }),
      ).toEqual([]);
    });
  },
);
