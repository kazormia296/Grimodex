/**
 * サードパーティライセンス一覧 (THIRD_PARTY_LICENSES.md) を生成するスクリプト。
 *
 * Usage: npx tsx scripts/generate-licenses.ts
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatLicensesMarkdown } from "../src/features/licenses/formatter";
import type { LicenseEntry } from "../src/features/licenses/types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/*  npm 依存のライセンス収集                                            */
/* ------------------------------------------------------------------ */

function findLicenseFile(pkgDir: string): string | undefined {
  try {
    const files = readdirSync(pkgDir);
    const licenseFile = files.find((f) => /^licen[cs]e/i.test(f));
    if (licenseFile) {
      return readFileSync(join(pkgDir, licenseFile), "utf-8");
    }
  } catch {
    // directory not readable
  }
  return undefined;
}

function normalizeRepository(repo: unknown): string | undefined {
  if (!repo) return undefined;
  if (typeof repo === "string") return repo;
  if (typeof repo === "object" && repo !== null && "url" in repo) {
    const url = (repo as { url: string }).url;
    return url
      .replace(/^git\+/, "")
      .replace(/\.git$/, "")
      .replace(/^ssh:\/\/git@github\.com/, "https://github.com");
  }
  return undefined;
}

function gatherNpmLicenses(): LicenseEntry[] {
  const pkgJsonPath = join(ROOT, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const depNames = Object.keys(pkgJson.dependencies ?? {});

  const entries: LicenseEntry[] = [];
  for (const name of depNames) {
    // Handle scoped packages: @scope/pkg → node_modules/@scope/pkg
    const pkgDir = join(ROOT, "node_modules", ...name.split("/"));
    const depPkgPath = join(pkgDir, "package.json");
    if (!existsSync(depPkgPath)) continue;

    const depPkg = JSON.parse(readFileSync(depPkgPath, "utf-8"));
    entries.push({
      name,
      version: depPkg.version ?? "unknown",
      license: depPkg.license ?? "UNKNOWN",
      repository: normalizeRepository(depPkg.repository),
      licenseText: findLicenseFile(pkgDir),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  Cargo 依存のライセンス収集                                          */
/* ------------------------------------------------------------------ */

interface CargoMetadataPackage {
  name: string;
  version: string;
  license: string | null;
  repository: string | null;
  manifest_path: string;
}

function gatherCargoLicenses(): LicenseEntry[] {
  const cargoDir = join(ROOT, "src-tauri");
  if (!existsSync(join(cargoDir, "Cargo.toml"))) {
    console.warn(
      "Warning: src-tauri/Cargo.toml not found, skipping Cargo licenses",
    );
    return [];
  }

  // workspace member の id 集合を取得（ワークスペース自身の crate を除外するため）
  let workspaceMemberIds = new Set<string>();
  try {
    const wsJson = execSync("cargo metadata --format-version 1 --no-deps", {
      cwd: cargoDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const wsMetadata = JSON.parse(wsJson);
    workspaceMemberIds = new Set<string>(wsMetadata.workspace_members ?? []);
  } catch {
    console.warn(
      "Warning: cargo metadata --no-deps failed, workspace members may appear in output",
    );
  }

  // フルメタデータで全依存（推移依存含む）を取得。
  // 旧コードは `--no-deps` の結果数で fallback 判定していたが、
  // workspace member が複数あると常に「依存取得済み」と誤判定して
  // 推移依存が漏れる。常にフル取得する方が確実。
  let allPackages: CargoMetadataPackage[];
  try {
    const fullJson = execSync("cargo metadata --format-version 1", {
      cwd: cargoDir,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    allPackages = JSON.parse(fullJson).packages ?? [];
  } catch {
    console.warn(
      "Warning: cargo metadata (full) failed, skipping Cargo licenses",
    );
    return [];
  }

  const entries: LicenseEntry[] = [];
  for (const pkg of allPackages) {
    // workspace member（自分たちのクレート）は除外
    const pkgId = `${pkg.name}@${pkg.version}`;
    if (
      workspaceMemberIds.has(pkgId) ||
      [...workspaceMemberIds].some((id) => id.startsWith(`${pkg.name} `))
    ) {
      continue;
    }

    const manifestDir = dirname(pkg.manifest_path);
    entries.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNKNOWN",
      repository: pkg.repository ?? undefined,
      licenseText: findLicenseFile(manifestDir),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  バンドル済みアセット (画像・フォント等)                              */
/* ------------------------------------------------------------------ */

const CC0_LICENSE_TEXT = `Creative Commons Legal Code

CC0 1.0 Universal

The person who associated a work with this deed has dedicated the work to
the public domain by waiving all of his or her rights to the work worldwide
under copyright law, including all related and neighboring rights, to the
extent allowed by law.

You can copy, modify, distribute and perform the work, even for commercial
purposes, all without asking permission. See https://creativecommons.org/publicdomain/zero/1.0/
for the full legal code.`;

const UNIDIC_BSD_LICENSE_TEXT = `Copyright (c) 2011-2013, The UniDic Consortium
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

 * Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.

 * Neither the name of the UniDic Consortium nor the names of its
   contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

function gatherAssetLicenses(): LicenseEntry[] {
  return [
    {
      name: "Cork001 (cork texture)",
      version: "1K-JPG",
      license: "CC0-1.0",
      repository: "https://ambientcg.com/view?id=Cork001",
      licenseText: CC0_LICENSE_TEXT,
    },
    {
      name: "UniDic (Japanese morphological dictionary, embedded via lindera-unidic)",
      version: "unidic-mecab-2.1.2",
      license: "BSD-3-Clause (also available under GPL/LGPL)",
      repository: "https://clrd.ninjal.ac.jp/unidic/",
      licenseText: UNIDIC_BSD_LICENSE_TEXT,
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  参考実装 (コードコピーではなく仕様・設計を参考にしたプロジェクト)    */
/* ------------------------------------------------------------------ */

const VSCODE_AI_NOVELIST_LICENSE_TEXT = `# The MIT License (MIT)

Copyright (c) 2023 whiteball <whiteball11@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

function gatherReferenceImplementations(): LicenseEntry[] {
  return [
    {
      // AI のべりすと API クライアントの仕様 (エンドポイント、リクエスト/レスポンス
      // フォーマット、認証ヘッダ等) を src-tauri/src/ai.rs の send_chat_ainoverist
      // 実装時に参照した。コード自体はコピーしておらず、API プロトコルの事実情報を
      // 元に独立実装した。MIT は「コピー時に著作権表記を含める」義務であり厳密には
      // 不要だが、出典明示と礼儀のために掲載する。
      name: "vscode-ai-novelist (API protocol reference for AI のべりすと integration)",
      version: "main branch",
      license: "MIT",
      repository: "https://github.com/whiteball/vscode-ai-novelist",
      licenseText: VSCODE_AI_NOVELIST_LICENSE_TEXT,
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  メイン                                                             */
/* ------------------------------------------------------------------ */

function main() {
  console.log("Gathering npm licenses...");
  const npmEntries = gatherNpmLicenses();
  console.log(`  Found ${npmEntries.length} npm packages`);

  console.log("Gathering Cargo licenses...");
  const cargoEntries = gatherCargoLicenses();
  console.log(`  Found ${cargoEntries.length} Cargo crates`);

  console.log("Gathering bundled asset licenses...");
  const assetEntries = gatherAssetLicenses();
  console.log(`  Found ${assetEntries.length} assets`);

  console.log("Gathering reference implementations...");
  const referenceEntries = gatherReferenceImplementations();
  console.log(`  Found ${referenceEntries.length} references`);

  const markdown = formatLicensesMarkdown(
    npmEntries,
    cargoEntries,
    assetEntries,
    referenceEntries,
  );

  const rootOutput = join(ROOT, "THIRD_PARTY_LICENSES.md");
  writeFileSync(rootOutput, markdown, "utf-8");
  console.log(`Written: ${rootOutput}`);

  const publicOutput = join(ROOT, "public", "THIRD_PARTY_LICENSES.md");
  if (existsSync(join(ROOT, "public"))) {
    writeFileSync(publicOutput, markdown, "utf-8");
    console.log(`Written: ${publicOutput}`);
  }

  console.log("Done!");
}

main();
