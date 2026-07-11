---
name: update-licenses
description: >
  THIRD_PARTY_LICENSES.md を再生成して依存・同梱アセットの最新状態に揃える。
  scripts/generate-licenses.ts を正本に root + public/ を生成し、新規バンドル
  アセット(ONNX モデル/独自フォント/画像)の収録と branch + PR での commit まで行う。
  Use when: 「ThirdPartyLicense 更新」「サードパーティライセンス更新」
  「ライセンス一覧を再生成」「third party license を更新」と言われたとき。
allowed-tools: Read, Edit, Grep, Bash, WebFetch
---

`THIRD_PARTY_LICENSES.md`（root + `public/`、同一内容）を再生成する。

## 正本は1つ — `scripts/generate-licenses.ts`

`.md` は生成物。**手編集は次回再生成で消える**。常にスクリプトを直してから
`pnpm generate:licenses` で生成する。出力は root と `public/` の2箇所（byte 一致）。
`dist/THIRD_PARTY_LICENSES.md` は **gitignore のビルド生成物 → 触らない・コミットしない**。

## 自動収集 vs 手追加（ここを取り違えない）

| 種別                                     | ソース                           | 追加方法                                       |
| ---------------------------------------- | -------------------------------- | ---------------------------------------------- |
| npm パッケージ                           | `package.json` の `dependencies` | **自動収集**（node_modules の各 package.json） |
| Rust crate                               | `src-tauri` + Electron N-API の `cargo metadata`（推移依存含む） | **自動収集**                |
| **@fontsource/\* 等のフォント**          | npm 依存                         | **自動収集 → 手追加禁止**（二重になる）        |
| 同梱 ONNX モデル / 独自 `.ttf` / 画像    | npm 外のバンドルアセット         | **`gatherAssetLicenses()` に手追加**           |
| 参考実装（コード非コピー・仕様参照のみ） | —                                | `gatherReferenceImplementations()` に手追加    |

つまり手追加が要るのは **npm 経由でない同梱アセットだけ**。フォントを足したくても
それが `package.json` の依存（`@fontsource/*`）なら何もしなくてよい。

## 手順

1. **新規同梱・再配布アセットの洗い出し**（手追加対象が増えていないか）:
   - 埋め込みモデル (ONNX) は同梱せずオンデマンド DL（GitHub Release
     `semantic-models-v1` から app_data へ取得）方式に移行済みだが、int8 モデルを
     我々が再配布している以上ライセンス収録は必要。`gatherAssetLicenses()` に
     未収録のモデルが無いか（例: ruri-v3-30m / bge-small-en-v15）。
   - `electron-builder.yml` の `extraResources` に、未収録の同梱アセット
     （git-tracked の tokenizer.json 等）が無いか。
   - `src/index.css` の `@font-face` と `src/assets/` 配下に、未収録の独自フォント/画像が無いか。
   ```
   grep -nE "@font-face|font-family" src/index.css
   cat electron-builder.yml
   find src-tauri/resources -maxdepth 2 -type d
   ```
2. **新規アセットがあれば `gatherAssetLicenses()` に追加**:
   - `license` は **upstream で SPDX を確認**（ML モデル=HuggingFace モデルカード、
     OSS=repo の LICENSE）。不確かなら `WebFetch` で確認してから書く。推測で書かない。
   - `licenseText` は **script 内の定数**として verbatim 定義（既存の `APACHE_2_0_LICENSE_TEXT`
     等に倣う）。テンプレートリテラルの空白を削らない（code block の整形が崩れる）。
   - エントリ形状は直上の既存アセット（ruri-v3 等）をコピーして埋める。
3. **再生成**:

   ```
   pnpm generate:licenses
   ```

   - **`pnpm install` / `cargo update` を走らせない**。再生成は installed/resolved 版を読むだけ。
     依存を bump すると巨大 churn diff が混入する（依存更新は dependabot/リリース前の別タスク）。

4. **差分検証**:
   generator は上流 LICENSE の改行と行末空白を正規化し、`src-tauri/Cargo.toml` と
   `electron/native/grimodex-node/Cargo.toml` の dependency graph を union する。
   自前 workspace crate の混入、`name@version` 重複、N-API runtime の欠落を回帰テストで確認する:

   ```
   node --test scripts/generate-licenses.test.mjs
   cmp -s THIRD_PARTY_LICENSES.md public/THIRD_PARTY_LICENSES.md
   rg '^### grimodex-' THIRD_PARTY_LICENSES.md  # 0件であること
   git diff --check
   ```

   - lock/package更新が同じブランチにある場合はversion置換による見出し削除も正常。
     `git diff` の増減と両Cargo lockを照合し、説明できない消失だけを調査する。

5. **ブランチを切ってコミット**（master へ直接 commit しない）:
   - `git switch -c chore/update-licenses`（既に作業ブランチ上ならそのまま使ってよい）。
   - `git status` を確認。
   - **作業ツリーに無関係な変更が混ざっていることがある**。`git add -A` は使わず、
     ライセンス系ファイルだけを**明示パスで個別に** add する
     （`THIRD_PARTY_LICENSES.md` / `public/THIRD_PARTY_LICENSES.md` /
     generatorを変えた場合は `scripts/generate-licenses.ts` と回帰テスト）。
   - メッセージ例: `chore(licenses): THIRD_PARTY_LICENSES を再生成 (<追加物> を収録)`
   - 末尾に Co-Authored-By trailer を付ける。
6. **push + PR**（push 前にユーザー確認・独断で push しない）:
   `git push origin chore/update-licenses` → `gh pr create`。CI green を確認してマージする。

## 罠（過去に踏んだもの）

| 罠                                                      | 対策                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `cargo update` / `pnpm install` で依存を bump           | 走らせない。再生成は `pnpm generate:licenses` だけ                    |
| N-API固有crateが一覧から落ちる                           | root workspaceと`electron/native/grimodex-node`の両metadataをunionする |
| 自前`grimodex-*` crateをthird-party扱いする              | 全manifestのworkspace memberを先にunion除外し、回帰テストを通す        |
| @fontsource フォントを `gatherAssetLicenses()` に手追加 | npm 依存なので自動収集。手追加は二重になる                            |
| 無関係な作業ツリー変更を巻き込む                        | `git add -A` 禁止・ライセンスファイルを明示パスで個別 add             |
| `dist/` を編集/コミット                                 | gitignore のビルド生成物。生成対象は root + `public/` だけ            |
| 新規 ML モデル/フォントの license 誤記                  | upstream(HF モデルカード/repo LICENSE)で SPDX 確認・verbatim を定数化 |
