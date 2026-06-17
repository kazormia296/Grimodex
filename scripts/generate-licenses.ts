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
    // 通常は LICENSE/LICENCE を優先。無ければ OFL.txt / COPYING にフォールバック
    // する（一部のフォントは LICENSE を置かず SIL OFL を OFL.txt で配布する。例:
    // gen-interface-jp）。これが無いと同梱フォントのライセンス本文と上流の帰属
    // (Inter / Source Han Sans 等) が脱落し、OFL-1.1 §2 に違反する。
    const licenseFile =
      files.find((f) => /^licen[cs]e/i.test(f)) ??
      files.find((f) => /^(ofl|copying)/i.test(f));
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

/**
 * `cargo metadata` の workspace_members の ID を `name@version` に正規化する。
 * cargo のバージョンで形式が異なる:
 *   - 新形式: `path+file:///abs/path#name@version`
 *   - 新形式(別): `path+file:///abs/path/name#version`（末尾ディレクトリ名 = crate 名）
 *   - 旧形式: `name version (path+file://...)`
 */
function parseWorkspaceMemberId(id: string): string | undefined {
  const hashIdx = id.indexOf("#");
  if (hashIdx !== -1) {
    const beforeHash = id.slice(0, hashIdx);
    const afterHash = id.slice(hashIdx + 1);
    if (afterHash.includes("@")) return afterHash;
    const name = beforeHash.split("/").pop();
    return name ? `${name}@${afterHash}` : undefined;
  }
  const parts = id.split(" ");
  if (parts.length >= 2) return `${parts[0]}@${parts[1]}`;
  return undefined;
}

function gatherCargoLicenses(): LicenseEntry[] {
  const cargoDir = join(ROOT, "src-tauri");
  if (!existsSync(join(cargoDir, "Cargo.toml"))) {
    console.warn(
      "Warning: src-tauri/Cargo.toml not found, skipping Cargo licenses",
    );
    return [];
  }

  // workspace member の `name@version` 集合を取得（ワークスペース自身の crate を除外するため）
  let workspaceMemberIds = new Set<string>();
  try {
    const wsJson = execSync("cargo metadata --format-version 1 --no-deps", {
      cwd: cargoDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const wsMetadata = JSON.parse(wsJson);
    const rawIds: string[] = wsMetadata.workspace_members ?? [];
    workspaceMemberIds = new Set<string>(
      rawIds
        .map(parseWorkspaceMemberId)
        .filter((id): id is string => id !== undefined),
    );
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
    if (workspaceMemberIds.has(pkgId)) {
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

const APACHE_2_0_LICENSE_TEXT = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute
          must include a readable copy of the attribution notices
          contained within such NOTICE file, excluding those notices
          that do not pertain to any part of the Derivative Works, in
          at least one of the following places: within a NOTICE text
          file distributed as part of the Derivative Works; within the
          Source form or documentation, if provided along with the
          Derivative Works; or, within a display generated by the
          Derivative Works, if and wherever such third-party notices
          normally appear. The contents of the NOTICE file are for
          informational purposes only and do not modify the License.
          You may add Your own attribution notices within Derivative
          Works that You distribute, alongside or as an addendum to the
          NOTICE text from the Work, provided that such additional
          attribution notices cannot be construed as modifying the
          License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.`;

const BGE_MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2022 staoxiao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const TOARU_EKI_SIGN_LICENSE_TEXT = `「とある駅の案内板っぽい？フォント」 (修正版)
作者: 栃木那須・ユズノカ

Codex 詳細パネルの名称入力欄の表示用に .ttf を Grimodex へ同梱している。
作者より同梱・再配布について明示の許諾を得ている (2026年6月、作者回答に基づく)。

許諾内容:
- 商用利用: 可
- ソフトウェアへの同梱・再配布: 可
- 有償ソフトウェアでの配布: 可
- クレジット表記: 任意 (必須ではない)

制約:
- 反社会的利用の禁止 (平和な活動での利用に限る)`;

const TEX_GYRE_HEROS_LICENSE_TEXT = `TeX Gyre Heros
Authors: Bogusław Jackowski and Janusz M. Nowacki (on behalf of TeX Users Groups)
Version: 2.004 (30 X 2009)
Source: http://www.gust.org.pl/projects/e-foundry/tex-gyre/heros

Copyright 2007--2009 for TeX Gyre extensions by B. Jackowski and J.M. Nowacki
(on behalf of TeX Users Groups). Vietnamese characters were added by Han The
Thanh. TeX Gyre Heros is based on the URW Nimbus Sans L kindly released by
URW++ Design and Development Inc. under the GUST Font License (independently of
the GPL release accompanying Ghostscript). It can be used as a replacement for
Helvetica.

This work can be freely used and distributed under the GUST Font License
(GFL), which is actually an instance of the LaTeX Project Public License
(LPPL — see http://www.latex-project.org/lppl.txt).

------------------------------------------------------------------------------
GUST Font License
------------------------------------------------------------------------------

% This is a preliminary version (2006-09-30), barring acceptance from
% the LaTeX Project Team and other feedback, of the GUST Font License.
% (GUST is the Polish TeX Users Group, http://www.gust.org.pl)
%
% For the most recent version of this license see
% http://www.gust.org.pl/fonts/licenses/GUST-FONT-LICENSE.txt
% or
% http://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt
%
% This work may be distributed and/or modified under the conditions
% of the LaTeX Project Public License, either version 1.3c of this
% license or (at your option) any later version.
%
% Please also observe the following clause:
% 1) it is requested, but not legally required, that derived works be
%    distributed only after changing the names of the fonts comprising this
%    work and given in an accompanying "manifest", and that the
%    files comprising the Work, as listed in the manifest, also be given
%    new names. Any exceptions to this request are also given in the
%    manifest.
%
%    We recommend the manifest be given in a separate file named
%    MANIFEST-<fontid>.txt, where <fontid> is some unique identification
%    of the font family. If a separate "readme" file accompanies the Work,
%    we recommend a name of the form README-<fontid>.txt.
%
% The latest version of the LaTeX Project Public License is in
% http://www.latex-project.org/lppl.txt and version 1.3c or later
% is part of all distributions of LaTeX version 2006/05/20 or later.`;

function gatherAssetLicenses(): LicenseEntry[] {
  return [
    {
      // Codex 詳細パネルの名称入力欄 (codex-detail-name) の表示用フォント。
      // src/assets/fonts/toaru-eki-sign.ttf として同梱し、index.css の
      // @font-face ("Toaru Eki Sign") から参照している。作者(栃木那須・ユズノカ氏)
      // より同梱・再配布・有償配布いずれも許諾済み。クレジットは任意だが出典明示の
      // ために掲載する。SPDX 識別子は存在しないため Custom 表記。
      name: "とある駅の案内板っぽい？フォント (Toaru Eki Sign — station-sign style display font, bundled for the Codex name field)",
      version: "修正版",
      license:
        "Custom (author-granted — free commercial, bundling & redistribution OK; credit optional)",
      licenseText: TOARU_EKI_SIGN_LICENSE_TEXT,
    },
    {
      // 英語プロジェクト時の Codex 名称欄の表示用フォント (Toaru Eki Sign の Latin 版)。
      // Bold ウェイト src/assets/fonts/texgyreheros-bold.otf を同梱し、index.css の
      // @font-face ("TeX Gyre Heros") から codexNameFont.ts が英語時のみ参照する。
      // GUST Font License (GFL) — LPPL 1.3c のインスタンスで、同梱・再配布・改変が
      // 許諾されている (GPL ではない)。URW Nimbus Sans L ベースの Helvetica 代替。
      name: "TeX Gyre Heros (Helvetica-style display font, bundled for the English Codex name field)",
      version: "2.004",
      license: "GUST Font License (GFL — an instance of LPPL-1.3c)",
      repository: "http://www.gust.org.pl/projects/e-foundry/tex-gyre/heros",
      licenseText: TEX_GYRE_HEROS_LICENSE_TEXT,
    },
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
    {
      // Semantic Search 用の日本語テキスト埋め込みモデル。リリースビルドに
      // ONNX (model_int8.onnx) と tokenizer.json を Tauri リソースとして同梱
      // している (src-tauri/tauri.release.conf.json)。
      // Authors: Hayato Tsukagoshi and Ryohei Sasano (arXiv:2409.07737)。
      name: "Ruri v3 (cl-nagoya/ruri-v3-30m, Japanese text embedding model, embedded as ONNX for semantic search)",
      version: "ruri-v3-30m",
      license: "Apache-2.0",
      repository: "https://huggingface.co/cl-nagoya/ruri-v3-30m",
      licenseText: APACHE_2_0_LICENSE_TEXT,
    },
    {
      // Semantic Search 用の英語テキスト埋め込みモデル。日本語の Ruri v3 と対になる
      // 言語別モデルで、英語プロジェクトの semantic search に使う。リリースビルドに
      // ONNX (model_int8.onnx) と tokenizer.json を Tauri リソースとして同梱している
      // (src-tauri/tauri.release.conf.json / dir_name: bge-small-en-v15)。
      // BAAI (Beijing Academy of Artificial Intelligence) の FlagEmbedding プロジェクト
      // として MIT ライセンスで公開されている (商用利用可)。
      name: "BGE small en v1.5 (BAAI/bge-small-en-v1.5, English text embedding model, embedded as ONNX for semantic search)",
      version: "bge-small-en-v1.5",
      license: "MIT",
      repository: "https://huggingface.co/BAAI/bge-small-en-v1.5",
      licenseText: BGE_MIT_LICENSE_TEXT,
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

const REACT_IDE_WORKSPACE_LAYOUT_LICENSE_TEXT = `MIT License

Copyright (c) 2026-present, leoweyr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

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
    {
      // Stripe DnD UX pattern (long-press drag, insert indicator, gap hysteresis) を
      // src/features/layout/ へ移植。GlobalSideBar / Workspace の挙動を参考に
      // Grimodex の LayoutState モデル上で独立実装した。
      name: "react-ide-workspace-layout (DnD UX pattern reference for layout stripe drag)",
      version: "develop branch",
      license: "MIT",
      repository: "https://github.com/leoweyr/react-ide-workspace-layout",
      licenseText: REACT_IDE_WORKSPACE_LAYOUT_LICENSE_TEXT,
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
