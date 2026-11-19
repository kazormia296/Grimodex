/**
 * @mastra/core の ee 由来のコードを、bundle に入れずに stub へ差し替える esbuild plugin
 * （Mastra 移行 MP-1、脅威モデル D8／T8、計画書の第 4.3 節・第 11 節）。
 *
 * 対象は `@mastra/core/dist` 配下の `ee-<hash>.js`（_internals/auth の共有 chunk）と
 * `**\/ee/*.js`（`auth/ee`、`agent-builder/ee`）。実物の chunk は読み込まず、
 * `export { local as Exported }` などの「公開名」だけを text から取って、同名の stub を生成する。
 * Mastra Enterprise License の実装は bundle にも repo にも複製しない。
 *
 * 振る舞い（FGA を使わない Grimodex では、ee の機能は使わない）。
 * - `requireFGA`／`checkFGA`：fgaProvider が無ければ no-op、あれば黙って通さず throw する。
 * - `StaticRBACProvider`：構築で throw する。
 * - 判定系（`isEEEnabled` など）：false。
 * - それ以外：undefined を返す。呼び手が増えたら版を上げる検査（計画書の第 11 節）で見つける（R-11）。
 *
 * この plugin の対象は `.js`（ESM）の ee chunk だけ。`.cjs` や他の package の ee は stub にせず、
 * 検査（mastra-ee-check.mjs）が「stub を通っていない ee の input」として落とす（黙って通さない）。
 */

import fs from "node:fs";

/** stub が出力に残す目印。実物と stub を取り違えないために検査が使う。 */
export const EE_STUB_MARK = "__EE_STUB__";

/**
 * stub にする file。esbuild の filter（Go の正規表現）にもそのまま使うので、先読みは使わない。
 * `.cjs` は意図して含めない（上の説明のとおり、検査が落とす）。
 */
export const EE_STUB_FILE =
  /[\\/]@mastra[\\/]core[\\/]dist[\\/](ee-[A-Za-z0-9_-]+\.m?js|(?:[^\\/]+[\\/])*ee[\\/][^\\/]+\.m?js)$/;

/**
 * 実物の chunk の export 文から (local, exported) の組を取る。
 * 対応する形は `export { a, b as c }`（`from "..."` つきの再 export を含む）と
 * `export const|let|var|function|class NAME`。
 * それ以外の export（`export default`、`export *`）は、公開名の取りこぼしを黙って許さないために throw する。
 */
export function exportedPairs(source) {
  const pairs = [];
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      pairs.push({
        local: as[0].trim(),
        exported: (as[1] ?? as[0]).trim(),
      });
    }
  }
  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    pairs.push({ local: m[1], exported: m[1] });
  }
  const other = source.match(/^export\s+(?:default\b|\*)/m);
  if (other) throw new Error(`ee stub: 未対応の export の形: ${other[0]}`);
  return pairs;
}

/** 名前ごとの stub の宣言。`n` は意味のある名前、`id` は stub 内で衝突しない識別子。 */
function declFor(n, id) {
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
  pairs.forEach(({ local, exported }, i) => {
    if (exported === "__eeStub") return;
    const id = `__ee_${i}_${local.replace(/[^A-Za-z0-9_$]/g, "_")}`;
    const meaningful = local.length > 2 ? local : exported;
    lines.push(declFor(meaningful, id));
    specs.push(`${id} as ${exported}`);
  });
  lines.push(`export { ${specs.join(", ")} };`);
  return lines.join("\n") + "\n";
}

/**
 * esbuild plugin。`log` には stub にした file ごとの { path, names, stubBytes } を積む
 * （検査が、metafile の ee の input と突き合わせる）。
 */
export function eeStubPlugin(log = []) {
  return {
    name: "mastra-ee-stub",
    setup(build) {
      build.onLoad({ filter: EE_STUB_FILE }, (args) => {
        const pairs = exportedPairs(fs.readFileSync(args.path, "utf8"));
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
