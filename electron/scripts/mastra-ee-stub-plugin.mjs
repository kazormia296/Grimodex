/**
 * @mastra/core の ee 由来のコードを、bundle に入れずに stub へ差し替える esbuild plugin
 * （Mastra 移行 MP-1、脅威モデル D8／T8、計画書の第 4.3 節・第 11 節）。
 *
 * 対象は `@mastra/core/dist` 配下の `ee-<hash>.{js,cjs}`（_internals/auth の共有 chunk）と、
 * `ee/` ディレクトリ以下の `.js`／`.cjs`（`auth/ee`、`agent-builder/ee`。ee/ の下は深さを問わない）。
 * 実物の chunk は実行せず、export の「公開名」と「配列か」だけを text から取って、同名の stub を生成する。
 * Mastra Enterprise License の実装は bundle にも repo にも複製しない。
 *
 * 振る舞い（FGA を使わない Grimodex では、ee の機能は使わない）。
 * - `requireFGA`／`checkFGA`：fgaProvider が無ければ no-op、あれば黙って通さず throw する。
 * - `StaticRBACProvider`：構築で throw する。
 * - 判定系（`isEEEnabled` など）：false。
 * - 実物で配列として宣言された export（`ACTIONS`、`PERMISSIONS` など）：空の配列（`.map` で壊れない）。
 * - それ以外：undefined を返す。呼び手が増えたら版を上げる検査（計画書の第 11 節）で見つける（R-11）。
 *
 * `.cjs`（`require()` で解決される経路）にも当てる。stub は ESM の形で生成し、esbuild が require 側の
 * 形に包む。他の package の ee は stub にせず、検査（mastra-ee-check.mjs）が
 * 「stub を通っていない ee の input」として落とす（黙って通さない）。
 */

import fs from "node:fs";
import path from "node:path";

/** stub が出力に残す目印。実物と stub を取り違えないために検査が使う。 */
export const EE_STUB_MARK = "__EE_STUB__";

/**
 * stub にする file。esbuild の filter（Go の正規表現）にもそのまま使うので、先読みは使わない。
 * `ee/` の下は深さを問わない。
 */
export const EE_STUB_FILE =
  /[\\/]@mastra[\\/]core[\\/]dist[\\/](?:ee-[A-Za-z0-9_-]+\.[cm]?js|(?:[^\\/]+[\\/])*ee[\\/](?:[^\\/]+[\\/])*[^\\/]+\.[cm]?js)$/;

/** `const|let|var NAME = [` の形で配列として宣言されているか。 */
function isArrayDeclaration(source, local) {
  return new RegExp(
    `(?:^|[\\s;])(?:const|let|var)\\s+${local.replace(/[$]/g, "\\$")}\\s*=\\s*\\[`,
  ).test(source);
}

/**
 * export 文から { local, exported, from? } を取る（ESM と CJS）。
 * - ESM：`export { a, b as c }`（`from "..."` つきの再 export を含む）、`export const|let|var|function|class NAME`。
 * - CJS：`Object.defineProperty(exports, "N", { get() { return L; } })`、`exports.N = L;`、
 *   `exports.N = require_x.M;`（`const require_x = require("...")` を `from` に解決する）。
 * それ以外（`export default`、`export *`、`module.exports`）は、公開名の取りこぼしを黙って許さないために throw する。
 */
function parseExports(source) {
  const out = [];
  for (const m of source.matchAll(
    /^export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/gm,
  )) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      out.push({
        local: as[0].trim(),
        exported: (as[1] ?? as[0]).trim(),
        from: m[2],
      });
    }
  }
  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    out.push({ local: m[1], exported: m[1] });
  }
  const requires = new Map(
    [
      ...source.matchAll(
        /^const\s+([\w$]+)\s*=\s*require\(["']([^"']+)["']\)/gm,
      ),
    ].map((m) => [m[1], m[2]]),
  );
  for (const m of source.matchAll(
    /^Object\.defineProperty\(exports,\s*"([^"]+)",\s*\{[^}]*?return\s+([A-Za-z_$][\w$]*)\s*;/gm,
  )) {
    out.push({ local: m[2], exported: m[1] });
  }
  for (const m of source.matchAll(
    /^exports\.([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);/gm,
  )) {
    const via = m[2].trim().match(/^([\w$]+)\.([A-Za-z_$][\w$]*)$/);
    if (via && requires.has(via[1])) {
      out.push({ local: via[2], exported: m[1], from: requires.get(via[1]) });
    } else if (/^[A-Za-z_$][\w$]*$/.test(m[2].trim())) {
      out.push({ local: m[2].trim(), exported: m[1] });
    } else {
      out.push({ local: m[1], exported: m[1] });
    }
  }
  const other = source.match(
    /^(?:export\s+(?:default\b|\*)|module\.exports\b)/m,
  );
  if (other) throw new Error(`ee stub: 未対応の export の形: ${other[0]}`);
  return out;
}

/**
 * 実物の chunk の export 文から (local, exported, array) の組を取る（file を読まない版）。
 * `array` は、同じ source の中で配列として宣言されているか（再 export の先は見ない）。
 */
export function exportedPairs(source) {
  return parseExports(source).map(({ local, exported }) => ({
    local,
    exported,
    array: isArrayDeclaration(source, local),
  }));
}

/**
 * file を読み、再 export の先も辿って (local, exported, array) の組を取る。
 * 再 export の file（auth/ee/index.js など）の配列かどうかは、再 export の元の chunk の宣言で判定する。
 */
export function analyzeEeFile(file, depth = 0) {
  const source = fs.readFileSync(file, "utf8");
  return parseExports(source).map(({ local, exported, from }) => {
    let array = isArrayDeclaration(source, local);
    if (!array && from?.startsWith(".") && depth < 4) {
      const target = path.resolve(path.dirname(file), from);
      const hit = analyzeEeFile(target, depth + 1).find(
        (pair) => pair.exported === local,
      );
      array = hit?.array ?? false;
    }
    return { local, exported, array };
  });
}

/** 名前ごとの stub の宣言。`n` は意味のある名前、`id` は stub 内で衝突しない識別子。 */
function declFor(n, id, array = false) {
  if (array) return `const ${id} = [];`;
  if (n === "MastraFGAPermissions")
    return `const ${id} = new Proxy({}, { get: (_t, p) => String(p) });`;
  if (n === "requireFGA" || n === "checkFGA")
    return `async function ${id}(options) { if (options && options.fgaProvider) throw new Error('ee stub: FGA provider is not supported in this build'); }`;
  if (n === "FGADeniedError" || /Error$/.test(n))
    return `class ${id} extends Error {}`;
  if (n === "StaticRBACProvider")
    return `class ${id} { constructor() { throw new Error('ee stub: RBAC is not supported'); } }`;
  if (/^get[A-Za-z]*FGAResourceId$/.test(n))
    return `function ${id}(id) { return String(id); }`;
  if (
    /^(isEEEnabled|isEELicenseValid|isLicenseValid|isFeatureEnabled|isAuthenticated|isDevEnvironment|hasPermission|matchesPermission|isValidPermissionPattern)$/.test(
      n,
    )
  )
    return `function ${id}() { return false; }`;
  if (/^[A-Z][A-Z_]+$/.test(n)) return `const ${id} = {};`;
  return `function ${id}() { return undefined; }`;
}

/**
 * (local, exported) の組から stub の source を作る。
 * 実装の chunk は「意味のある local 名 as 1 文字の別名」、再 export の file（auth/ee/index.js など）は
 * 「1 文字の local 名 as 意味のある名前」の形なので、長い方（2 文字を超える方）で振る舞いを分類し、
 * 公開は exported の名前で行う。別名側だけで分類すると全部が undefined を返す stub になる
 * （spike の S2 追補で直した欠陥）。
 */
export function stubSource(pairs) {
  const lines = [
    "// ee stub。Mastra Enterprise License の実装は含めない。",
    `const MARK = '${EE_STUB_MARK}';`,
  ];
  const specs = ["MARK as __eeStub"];
  pairs.forEach(({ local, exported, array }, i) => {
    if (exported === "__eeStub") return;
    const id = `__ee_${i}_${local.replace(/[^A-Za-z0-9_$]/g, "_")}`;
    const meaningful = local.length > 2 ? local : exported;
    lines.push(declFor(meaningful, id, array));
    specs.push(`${id} as ${exported}`);
  });
  lines.push(`export { ${specs.join(", ")} };`);
  return lines.join("\n") + "\n";
}

/**
 * esbuild plugin。`log` には stub にした file ごとの { path, names, stubBytes } を積む
 * （検査が、metafile の ee の input と突き合わせる）。`filter` は試験が「当たらない経路」の対照を作るために
 * 差し替える（既定は EE_STUB_FILE）。
 */
export function eeStubPlugin(log = [], { filter = EE_STUB_FILE } = {}) {
  return {
    name: "mastra-ee-stub",
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const pairs = analyzeEeFile(args.path);
        if (pairs.length === 0) {
          throw new Error(`ee stub: 公開名を 1 つも取れない: ${args.path}`);
        }
        const contents = stubSource(pairs);
        log.push({
          path: args.path,
          names: pairs.length,
          stubBytes: Buffer.byteLength(contents),
        });
        return { contents, loader: "js" };
      });
    },
  };
}
