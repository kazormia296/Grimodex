# 設計検討: 埋め込みモデルの非同梱・オンデマンドDL機構

ステータス: 検討資料（実装ではない）
対象: semantic 機能の配布形態
日付: 2026-06-19

> **【2026-07-04 追記 / 実装後の現状】** 本書の提案は PR#240 でオンデマンドDL機構（Strategy A: int8 非同梱・tokenizer のみ git-tracked・初回利用時に GitHub Release `semantic-models-v1` から DL）として実装済み。それに伴い、以下の §0・付録で「現状のバンドル定義」として参照している `src-tauri/tauri.release.conf.json` は **PR#253 で削除済み**（release ビルドから参照されておらず dead だったため）。したがって §0 以降の「前提となる現状」は 2026-06-19 時点のスナップショットであり、現行の配布形態ではない点に注意。現行の同梱定義は `src-tauri/tauri.conf.json` の `bundle.resources`（tokenizer のみ）を参照のこと。

本書は「埋め込みモデルをアプリに同梱せず、執筆言語に応じて初回利用時にダウンロード（DL）する」機構の設計検討である。将来の大型モデル化（ruri-130m / 310m 等、同梱が現実的でないサイズ）への接続も視野に入れる。実装計画ではなく、採否判断とアーキ方針を固めるための資料。

---

## 0. 前提となる現状（実測・コード根拠）

同梱モデルは int8 量子化版のみがリリースバンドルに入る。tokenizer.json も同梱される（`src-tauri/tauri.release.conf.json:4-9`）。

| モデル | dir_name | int8 onnx | tokenizer.json | dim | 言語判定 |
|---|---|---|---|---|---|
| ruri-v3-30m (JA) | `ruri-v3-30m` | 37,074,051 B (≈35.4 MiB) | 6,724,873 B (≈6.4 MiB) | 256 | 既定（"en" 以外すべて） |
| bge-small-en-v1.5 (EN) | `bge-small-en-v15` | 34,041,756 B (≈32.5 MiB) | 711,396 B (≈0.7 MiB) | 384 | `language.starts_with("en")` |

- 実測サイズは `du` および `ls` による（resources/semantic 配下）。fp32 `model.onnx`（133MB/147MB）はリリースバンドルには含まれない（`tauri.release.conf.json` に列挙が無い）。
- 言語→spec の確定は `spec_for_language()`（`src-tauri/src/semantic/spec.rs:151-157`）。"en" prefix のみ EN、他はすべて JA フォールバック。
- ローダはバンドル resource を解決し、無ければ `CARGO_MANIFEST_DIR` にフォールバック。判定は `model_int8.onnx` の存在で行う（`src-tauri/src/commands/semantic.rs:86-96`）。
- Embedder は spec.dir_name ごとに lazy load・HashMap キャッシュ（`semantic.rs:111-123`）。不在時は `load_embedder` → `Embedder::load`（`embedding.rs:53-84`）が ENOENT で Err を返し、コマンドはエラー文字列を返す。
- staleness は `scene_chunks.model_id` / `embedding_dim` / `chunker_version` と現行 spec の不一致で検出（`semantic/index.rs:170-225`、`full_model_id()` は `spec.rs:80-82`）。

### 確定済みの現実制約（誇張禁止・必ず整合させること）

1. **byte-stability**: JA の `model_id` / `dir_name` / `embedding_dim` / `chunker_version` / `model_id_suffix` は regression-lock されており（`spec.rs:159-205` の `ja_spec_is_byte_stable`）、変更すると既存 ja `scene_chunks` が全 stale 化し全再インデックスを誘発する。DL 化はこれらの識別子を一切変えてはならない。
2. **ホスト専用 calibration**: EN の閾値（SEMANTIC_RECALL_MIN_SCORE_EN=0.51）と bge 採用は host calibration（36-pair corpus）で確定済み（`spec.rs:124-131`）。**DL 元が配るバイナリは、calibration を取った時の量子化済み int8 と byte 一致していなければならない**。HF 上の同名モデルを別量子化で取ってくると閾値が無効になる。→ DL は「我々が calibration した正確な int8 artifact」を sha256 で固定して取る。
3. **firewall allowlist**: devcontainer は egress allowlist 方式（`.devcontainer/init-firewall.sh:95-108`）。`huggingface.co` / `cdn-lfs.huggingface.co` / `hf.co` は既に許可済み。GitHub Release を使う場合は別途追加が必要。
4. CSP の `connect-src` はリリースで `'self' ipc: http://ipc.localhost` のみ（`tauri.conf.json:28`）。外部 HTTP は不許可。

---

## 1. 目的と効果

### 配布サイズ削減の見積り

リリースバンドルの semantic 寄与は **両モデルの int8 + 両 tokenizer** = 37.0 + 34.0 + 6.7 + 0.7 ≈ **78.5 MiB**。

| 方針 | バンドル semantic 寄与 | 現状比 削減 |
|---|---|---|
| 現状（両モデル同梱） | ≈ 78.5 MiB | — |
| EN を非同梱 DL（JA 同梱維持） | ≈ 42.1 MiB（ruri int8 + ruri tok のみ） | **−36.4 MiB** |
| 両モデル非同梱 DL | ≈ 0 MiB | **−78.5 MiB** |

注: tokenizer.json は小さくても同梱したまま DL を onnx のみにする選択も可能（後述）。EN tokenizer が 6.4MB と大きいので、tokenizer も DL に回すと EN 側でさらに効く。

### 大型化との相乗（本設計の最大の動機）

現状の同梱は int8 30m クラスだから「78.5 MiB を削れる」程度の話に見える。しかし ruri-130m / 310m への移行を見据えると話が変わる:

- 30m int8 が ≈35 MiB。パラメータ比で素朴に見積もると 130m int8 ≈ 130–160 MiB、310m int8 ≈ 300–400 MiB 規模になりうる（正確値は要量子化実測。ここは見積りであり確定値ではない）。
- これらを **複数言語ぶん同梱すると、アプリインストーラが数百 MiB 級**に膨らむ。NSIS/dmg/AppImage の配布・更新コストが非現実的。
- オンデマンド DL 機構を**今のうちに入れておけば、大型モデルは「同梱不能だから DL するしかない」状況にそのまま乗る**。つまり本設計は小型モデルのサイズ削減策であると同時に、大型モデル投入の前提インフラである。

**結論**: 30m 段階での削減効果（−36〜78 MiB）単独では「やってもいい」程度だが、大型化の前提インフラとしての価値が主目的。

---

## 2. 推奨アーキテクチャ（全体図）

```
                 ┌──────────────────────────────────────────────┐
                 │ spec.rs (正本)                               │
                 │  EmbeddingModelSpec に DL メタを追加:        │
                 │   artifact_url, artifact_sha256,             │
                 │   artifact_size, tokenizer_url/sha256/size   │
                 │  ※ model_id/dir_name/dim/chunker_version は  │
                 │    一切変更しない（byte-stability）          │
                 └───────────────┬──────────────────────────────┘
                                 │ spec_for_language(lang)
                                 ▼
   open_workspace / 初回 semantic 利用
                                 │
                 ┌───────────────▼──────────────────────────────┐
                 │ resolve_model_dir (改修)                     │
                 │  1) bundle resource_dir                      │
                 │  2) DL 済み dir (app_data_dir/models/...)    │ ← 追加
                 │  3) CARGO_MANIFEST_DIR (dev/test 救済)       │
                 └───────────────┬──────────────────────────────┘
                  存在しない      │ 存在する → Embedder::load (現状のまま)
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │ ModelDownloader (新規 Rust)                  │
                 │  tmp DL → sha256 検証 → atomic rename        │
                 │  進捗 emit (REINDEX_PROGRESS と同型)          │
                 │  失敗 → Err（degrade は呼び出し側で）         │
                 └──────────────────────────────────────────────┘
```

### 2.1 モデルレジストリ（spec.rs を正本に拡張）

`EmbeddingModelSpec` に DL メタを足す。**既存フィールドは触らない**（byte-stability）。追加するのは純粋な付随情報:

```rust
// 追加候補（既存フィールドの後ろに足すだけ）
pub artifact_url: &'static str,      // 我々が calibration した int8 の固定URL
pub artifact_sha256: &'static str,   // 必須: DL 物が calibration 対象と byte 一致するか
pub artifact_size: u64,              // 事前サイズ（DoS guard・進捗分母）
// tokenizer も DL に回すなら同様の3点を追加
```

レジストリを spec.rs に置く理由: 言語→spec→DL メタが 1 箇所で閉じ、`full_model_id()` の識別子と DL artifact の対応がコードレビューで一目で取れる。**sha256 を spec に焼く＝「この識別子の chunk はこの正確な artifact で作られた」を不変条件として固定**できる。

### 2.2 DL 先（writable app dir）

`app.path().app_data_dir()`（`lib.rs:74-77`、起動時に `create_dir_all`）配下に `models/{dir_name}/` を置く。例: `<app_data>/models/bge-small-en-v15/{model_int8.onnx,tokenizer.json}`。

- resource_dir は read-only（インストール先）なのでここには書けない。app_data_dir が唯一の確実な writable。
- `app_cache_dir` も候補だが、cache は OS により消去されうる。**モデルは「消えたら再 DL すればいい」性質なので cache でも成立する**。ただし大型モデルの再 DL コストを嫌うなら app_data_dir（永続）を推奨。本書は **app_data_dir 推奨**。

### 2.3 整合性検証（sha256 必須・署名要否）

- **sha256 は必須**。理由は破損検知だけでなく **calibration 整合**（§0 制約2）。`external_mount/hash.rs:10-14` に既存の Sha256→hex パターンがあるので流用。
- DL 後、rename 前に必ず検証。不一致なら tmp を破棄し Err。
- **署名（コード署名/GPG）は当面不要**と判断する。理由: (a) sha256 を**アプリバイナリ内に焼く**ので、改ざんするには配布物（署名済みインストーラ）自体を改ざんする必要があり、DL artifact 単独の差し替えは sha256 で弾ける。(b) HTTPS で取得元を保証。署名を足すのは「sha256 を後から OTA で差し替えたい」要件が出た時に再検討（その時は署名付きマニフェストが要る）。現状は spec に焼くので不要。

### 2.4 atomic install（tmp → rename）

```
1. <app_data>/models/.tmp/{dir_name}-{rand}.onnx.part に streaming DL
   （reqwest stream・8MiB 級の上限チェックでなく artifact_size + 余裕で hard cap）
2. DL 完走後に sha256 検証
3. 検証 OK → 最終パス <app_data>/models/{dir_name}/model_int8.onnx へ std::fs::rename
   （同一ファイルシステム内 rename は atomic）
4. tokenizer も同様。両方揃って初めて「インストール完了」とみなす
```

- rename は同一 FS でないと atomic にならない。.tmp は最終 dir と同じ `<app_data>/models/` 配下に置く（FS 跨ぎ回避）。
- 中断・クラッシュで `.part` が残っても、`resolve_model_dir` は最終パスの `model_int8.onnx` 存在のみ見る（現状判定流用）ので、未完了 DL が誤って load されることはない。`.part` は次回起動時に掃除。

### 2.5 バージョニング（既存 scene_chunks 機構と整合）

新しい staleness 機構は作らない。**`scene_chunks.model_id` に書く `full_model_id()` が既にバージョン識別子**（`spec.rs:80-82`、`@local/model_int8.onnx/en-v1` のような suffix 付き）。

- DL 化しても `full_model_id()` の文字列を変えなければ、既存の `collect_index_status`（`index.rs:170-225`）がそのまま stale 検出に働く。
- モデルを本当に更新する（例: ruri-130m へ移行）場合は、`model_id_suffix` か `model_id` を変える→`full_model_id()` が変わる→既存 chunk が全 stale→reindex、という**既存の経路に自然に乗る**。同時に spec の `artifact_url`/`artifact_sha256` も更新する。
- suffix に `model_int8.onnx` という artifact 種別が既に入っているのは好都合。DL artifact の種別と staleness キーが一致する。

---

## 3. ローダ改修（最小変更点）

`resolve_model_dir`（`semantic.rs:86-96`）に **DL 済み dir を探索順 2 番目として挿入**するだけが本質的変更:

```rust
fn resolve_model_dir(app, spec) -> PathBuf {
    let rel = PathBuf::from("resources/semantic").join(spec.dir_name);
    // 1) bundle（同梱したモデルがある場合・方針 B/C）
    if let Ok(base) = app.path().resource_dir() {
        let c = base.join(&rel);
        if c.join("model_int8.onnx").exists() { return c; }
    }
    // 2) DL 済み dir（新規）
    if let Ok(data) = app.path().app_data_dir() {
        let c = data.join("models").join(spec.dir_name);
        if c.join("model_int8.onnx").exists() { return c; }
    }
    // 3) dev/test 救済（現状維持）
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}
```

- `Embedder::load`（`embedding.rs:53-84`）は**一切変更不要**。受け取った path から読むだけ。
- `ensure_embedder` / `load_embedder` も**そのまま**。違いは「resolve が DL dir も見る」だけ。
- 同梱されていれば 1 で当たり DL は走らない（方針 B の JA など）。同梱が無ければ 2 を見て、そこにも無ければ 3（dev）か Err。
- **重要**: tokenizer も DL する方針なら、tokenizer の探索も同じ dir に揃える（`load_embedder` が `dir.join("tokenizer.json")` で組むので、resolve が返す dir に両方揃っていればよい）。

この最小変更により「同梱 or DL 済み or dev」の三択が透過的に成立し、§4 のトリガは「2 の場所に置く」役だけ担えばよい。

---

## 4. トリガ & UX

### 4.1 いつ DL するか

二段構え:

1. **早期トリガ（プロアクティブ）**: `open_workspace`（`workspace.rs:128-171`、既に semantic cache clear をしている）で project.language を読み、`spec_for_language` の dir が DL dir/bundle に無ければ**バックグラウンド DL を開始**。ユーザーが最初の検索に到達する前に揃えにいく。
   - 言語の正本: `projects.language`（`migrate.rs` default 'ja'）、`project_language`（`index.rs:349-360`）。
2. **遅延トリガ（フォールバック）**: 早期 DL が間に合わない／未完の状態で semantic コマンドが呼ばれ、`ensure_embedder` が「model 不在」を検出したら、Err を返す前に DL job をスケジュールし、呼び出し側は今回は degrade（§4.3）。

プロジェクト作成時（CreateProjectDialog で language 確定）も自然なトリガだが、open_workspace に集約すれば作成/既存の両方をカバーできるので、まずは open_workspace 一点を推奨。

### 4.2 進捗 / 失敗 / オフライン

既存の進捗基盤を流用する。`ReindexProgressToast` と `REINDEX_PROGRESS_EVENT`（`semantic.rs:66`、scene_index/total/done のペイロード）と同型で `MODEL_DOWNLOAD_PROGRESS` イベントを足し、`DownloadProgressToast` を新設。sonner の toast.error / toast.success も既存（App.tsx）。

- **進捗**: `artifact_size` を分母にバイト進捗を emit（reqwest stream で受信バイト累計）。トーストに「英語モデルをダウンロード中… 12/34 MiB」。
- **失敗**: sha256 不一致 or HTTP エラー → toast.error「モデルのダウンロードに失敗しました。FTS（全文検索）で続行します」。`.part` は破棄。リトライ手段（設定画面の「再ダウンロード」ボタン）を用意。
- **オフライン**: connect timeout（license.rs:149-180 の 5s connect / 15s total パターンを流用）で早期に諦め、degrade。トーストで「オフラインのため意味検索は無効。FTS で動作中」。再接続時の自動リトライは後続フェーズ。

### 4.3 degrade（FTS sparse への退避）— 経路別の可否

モデル不在時、各消費経路は**既に無音フォールバック**を持つ。DL 化で重要なのは「degrade 可/不可」の明示:

| 経路 | コード | モデル不在時の現状 | sparse(FTS) degrade |
|---|---|---|---|
| Chat 自動注入 (semanticRecall) | `chat/semanticRecall.ts:352-426`（fetchSemanticRecall） | `[]` 無音フォールバック | hybrid 時に sparse 退避あり（381-393）。**degrade 可** |
| Related-Scenes パネル | `related-scenes/fetchRelatedScenes.ts:53-105`（fetchRelatedPastScenes） | `.catch(()=>[])` 無音 | hybrid（dense=`semanticSearch` + sparse=FTS5/bm25 を RRF 融合）。dense 失敗→空、sparse 失敗→dense 単独へグレースフル退避（67-89）。**degrade 可** |
| CommandCenter 検索 | `commandCenter/providers/semanticSearchProvider.ts:73-99`（provider）, `hooks/useCommandCenterSearch.ts:55-58`（fetch 配線） | provider が `[]`（error は section.state.error） | **degrade 不可（dense 単独）**。semantic provider は `semanticSearch` を呼ぶだけで sparse/RRF 融合を持たない（lexical provider が別 section の独立 sparse arm）。モデル不在＝意味検索 section が空 ← 改善余地 |
| Agent search_codex | `commands/semantic.rs:351-393`（dense arm）, `chat/agent/toolExecutors.ts:127-221`（searchCodex）, `chat/agent/codexHybridSearch.ts`（fuseCodexHybrid） | dense は Embedder load 失敗→Err→JS catch | **degrade 可**。JS 側 `searchCodex` が dense(`codexSemanticSearch`)+sparse(FTS5/LIKE) を RRF 融合し、dense reject 時は sparse 単独へグレースフル退避（`toolExecutors.ts:199-213`）。FTS5 codex 本文 index は既存（PR#109） |
| Impact Review | `commands/post_effect.rs` | semantic を直接呼ばない | **影響なし**（degrade 不要） |

設計指針:
- **degrade 可の経路（Chat / Related-Scenes / Agent search_codex）**: モデル DL 中・失敗でも sparse で実用最低限を返す。ユーザー体験の劣化は「固有名詞リコールは効くが意味的近接は出ない」。Related-Scenes パネルは `fetchRelatedPastScenes` が dense(`semanticSearch`)+sparse(FTS5/bm25) を RRF 融合し、sparse reject 時は dense 単独へグレースフル退避する（chat の semanticRecall と同契約）。search_codex は `toolExecutors.ts` の searchCodex が RRF 融合と sparse 単独退避を持つため degrade 可と確定済み。
- **degrade 不可の経路（CommandCenter）**: モデル不在時に意味検索 section が空表示になる。DL 化を機に、**モデル不在時は sparse へ退避するか、明示的に「英語モデル未取得」を表示**する設計を入れるべき（無音で空表示は「壊れている」と誤認させる）。CommandCenter は semantic provider が dense 単独（sparse/RRF 未実装）なので、RRF 追加 vs 明示表示のどちらを採るかを別タスクで敲定する（CommandCenter RRF 対応は別タスク）。
  - 注（2026-06-20 追記）: 旧版の「要確認 2 件（CommandCenter / search_codex の RRF 実装箇所）」はコード照合で確定済み。search_codex=degrade 可（RRF 融合あり）、CommandCenter=degrade 不可（dense 単独）。

「FTS は model 不在でも動く」という graceful 契約は `semantic-search/autoIndex.ts:15-21` に明記があり、全経路の degrade の足場になる。

---

## 5. ネットワーク / セキュリティ / 規約

### 5.1 ホスト選定

| 選択肢 | 長所 | 短所 | 判定 |
|---|---|---|---|
| HuggingFace Hub | firewall に既許可（`init-firewall.sh:100-102`）。CDN（cdn-lfs）あり。reqwest で素直に取れる | **量子化版の byte 一致を我々が管理できない**（HF の同名モデルは別量子化のことがある→calibration 無効化リスク） | 条件付き可 |
| GitHub Release | 我々が作った正確な int8 artifact をそのまま置ける（calibration 整合が確実）。版管理＝Release tag で staleness と対応 | firewall に未許可（追加要）。LFS/帯域上限の注意 | **推奨** |
| 自前 CDN (S3+CloudFront) | 帯域・URL 完全制御。署名 URL も可 | 運用コスト・コスト負担。firewall 追加要 | 将来（大型・高 DL 量時） |

**推奨: GitHub Release**。決め手は §0 制約2（calibration 整合）。我々が calibrate した正確な int8 を自分のリリース資産として置き、sha256 を spec に焼く運用が最も安全。HF を使うなら「我々のリポジトリ namespace 配下に、calibrate 済み int8 を自分でアップした版」を pin する形なら可（HF 公式モデルを直接引くのは calibration がずれるので不可）。

### 5.2 CSP connect-src 追記

リリース CSP は外部 HTTP 不許可（`tauri.conf.json:28`）。ただし **DL を Rust 側 reqwest で行えば WebView の CSP は無関係**（CSP は WebView の fetch を縛るもの。Rust の reqwest はブラウザ外）。ai.rs / license.rs が既に reqwest で外部叩いている前例どおり。

→ **CSP の connect-src 追記は原則不要**。DL は Rust コマンドに閉じる。WebView から直接 DL する設計は採らない（CSP 緩めたくない＋ §0 のセキュリティ方針）。

### 5.3 devcontainer firewall allowlist 追記

- HF を使うなら **追加不要**（`huggingface.co` / `cdn-lfs.huggingface.co` / `hf.co` は既許可、`init-firewall.sh:100-102`）。
- **GitHub Release を使うなら `objects.githubusercontent.com`（Release/LFS 実体配信先）と GitHub API range の追加が要る**。
- ⚠️ **`.github/` とは異なり `.devcontainer/init-firewall.sh` は通常の Edit/Write が可能**（MEMORY の編集制約は `.github/` 配下の話）。よって firewall への allowlist 追加は patch 手渡し不要・通常編集でよい。ただし lindera.dev / cdn.pyke.io 追加（2026-05-23）の前例どおり、追加後は postStartCommand の再 init が必要。

### 5.4 ライセンス再配布の可否

- ruri-v3-30m: ライセンス要確認（cl-nagoya/ruri-v3-30m）。再配布可否を確認した上で GitHub Release に置く。
- bge-small-en-v1.5: **MIT**（`spec.rs:127` に明記）→再配布可。
- 既に同梱して配布しているので、DL に切り替えても**再配布の法的性質は同じ**（配布チャネルが変わるだけ）。ただし `THIRD_PARTY_LICENSES.md`（/update-licenses の管轄、ONNX モデルも収録対象）は DL モデルも引き続き収録する。「同梱しなくなったから消す」は不可—配布している事実は変わらない。

---

## 6. 配布戦略の選択肢比較

| 軸 | (A) 全モデル非同梱 DL | (B) 既定 JA 同梱 + EN/大型 DL | (C) 現状維持（同梱） |
|---|---|---|---|
| バンドル semantic 寄与 | ≈ 0 MiB（−78.5） | ≈ 42 MiB（−36.4、JA int8+tok） | ≈ 78.5 MiB |
| 初回 UX（多数派 JA ユーザー） | **初回 DL 必須**（35MB DL 待ち） | **即動作**（同梱） | 即動作 |
| 初回 UX（EN ユーザー） | 初回 DL（32MB） | 初回 DL（32MB） | 即動作 |
| オフライン耐性 | **弱**（初回 DL 必須・未取得なら semantic 全滅→FTS のみ） | 中（JA はオフラインでも動く、EN は FTS degrade） | **強**（完全オフライン） |
| 実装コスト | 中（DL 必須経路・全言語の degrade を堅牢に） | 中（同左だが JA fallback が安全網） | なし |
| リスク | 多数派 JA ユーザーまで DL 失敗の影響を受ける。calibration/firewall/sha256 を全言語で完璧に | EN/大型のみがリスク面。JA は従来どおり安全 | 大型化でインストーラ肥大・配布不能 |

### 推奨: **(B) 既定 JA 同梱 + EN/大型 DL**

理由:
1. 多数派が JA（既定言語、`migrate.rs` default 'ja'）。彼らの初回 UX とオフライン耐性を**一切犠牲にしない**。
2. EN は元々少数派想定（probe D）かつ既に 32MB を DL するコストは許容範囲。EN の degrade（FTS）も §4.3 で成立。
3. 削減効果 −36 MiB を取りつつ、**大型モデル（ruri-130m 等）は「DL 専用」枠に自然に乗る**（同梱は 30m JA のみ据え置き、大型は DL）。
4. (A) は「JA ユーザーまで初回 DL のリスクに晒す」割に、削減差は (B) との比で −42 MiB 追加でしかなく、リスク/便益が見合わない。
5. (C) は大型化で詰む。

§3 のローダ改修は (B) を自然に表現する: JA は探索順 1（bundle）で当たり DL 不要、EN/大型は 1 で外れ 2（DL dir）を見る。

---

## 7. 段階的実装プラン

### Phase 0: 確認（実装前ゲート）
- ~~search_codex / CommandCenter の RRF 実装箇所を特定し、degrade 可否を確定~~（**2026-06-20 完了**: §4.3 表で確定。search_codex=degrade 可、CommandCenter=degrade 不可）。CommandCenter の不可をどう扱うか（RRF 追加 vs 明示表示）を別タスクで敲定（CommandCenter RRF 対応は別タスク）。
- ruri-v3-30m のライセンス再配布可否確認。
- 我々の calibrate 済み int8 artifact の sha256 を採取。
- 受け入れ条件: degrade 可否が全 5 経路で表に確定（済）。CommandCenter の改修方針が確定。再配布可。sha256 確定。

### Phase 1: ローダの DL-dir 対応（DL 機構なし）
- `resolve_model_dir` に DL dir 探索（探索順 2）を追加（§3）。`spec.rs` に DL メタフィールド追加（値は埋めるが未使用）。
- **手動で** `<app_data>/models/` にモデルを置けば EN が同梱なしで動くことを確認。EN を release bundle から外す準備（まだ外さない）。
- 計測: byte-stability test（`ja_spec_is_byte_stable`）が green のまま。golden test（cos ≥0.99 int8）が DL dir 経由でも green。
- 受け入れ条件: 手置きモデルで semantic 全経路動作。既存テスト全 green。tsc/clippy/cargo test green。

### Phase 2: ModelDownloader（tmp→sha256→rename）
- 新規 Rust モジュール: streaming DL、artifact_size hard cap（DoS guard、master-audit の size-limit 流儀）、connect 5s/total はサイズに応じ延長、sha256 検証、atomic rename、`.part` 掃除。
- 進捗イベント `MODEL_DOWNLOAD_PROGRESS` emit。
- firewall allowlist 追加（GitHub Release 採用時、§5.3）。
- 計測: sha256 不一致を**意図的に注入して Err になる**こと。中断後に `.part` が残っても次回 load されないこと。
- 受け入れ条件: DL→検証→install が atomic。破損/中断で壊れた状態にならない。実 DL の E2E（firewall 内）green。

### Phase 3: トリガ & UX & degrade 堅牢化
- open_workspace 早期トリガ + ensure_embedder 遅延トリガ（§4.1）。
- DownloadProgressToast、失敗/オフライン toast、設定画面の再 DL ボタン。
- **degrade 不可経路（CommandCenter）を sparse 退避 or 明示表示に改修**（§4.3）。
- 計測: オフラインで起動→FTS で全経路が「壊れず」動く。DL 中の検索が degrade で返る。
- 受け入れ条件: オフライン/DL 失敗時に semantic 依存全経路が graceful。空表示で「壊れた」誤認させない。

### Phase 4: EN を release bundle から外す（方針 B 確定）
- `tauri.release.conf.json` から `bge-small-en-v15/*` を削除（−36 MiB 実現）。tokenizer を DL に回すか同梱維持かはここで決定（EN tok 6.4MB を DL に回すと追加削減）。
- THIRD_PARTY_LICENSES は DL モデルも収録維持（/update-licenses、§5.4）。
- 計測: 実インストーラサイズの before/after を実測（見積り −36 MiB の裏取り）。EN ユーザーのクリーンインストール→初回 DL→semantic 動作の手動 QA。
- 受け入れ条件: バンドルサイズ削減を実測で確認。EN クリーン環境で初回 DL が成功。

### Phase 5（将来）: 大型モデル投入
- ruri-130m/310m の int8 を export→calibrate→sha256→spec に `model_id`/suffix 変更で登録（既存 staleness 経路で旧 chunk が stale→reindex）。GitHub Release に artifact。
- 受け入れ条件: 大型モデルが DL 経路のみで動く。閾値の再 calibration 完了（ホスト専用 calibration の原則）。

### リスクと未解決点
- **calibration 整合（最重要）**: DL artifact が calibrate 対象と byte 一致しないと EN/将来モデルの閾値が無効化。sha256 spec 焼きで守るが、HF を取得元にする場合は「自分でアップした版」限定（公式直引き禁止）。
- **byte-stability**: JA 識別子を DL 化のついでに触らない。regression test が gate。
- **degrade 可否の未確定 2 経路**（CommandCenter / search_codex）。Phase 0 で潰す。
- **オフライン初回 UX**: 方針 B でも EN/大型ユーザーの初回はネット必須。これは仕様として受容（FTS degrade で最低限担保）。
- **GitHub Release の帯域/可用性**: DL 量が増えたら自前 CDN へ移行（§5.1）。その時は取得元 URL 差し替え＋sha256 据え置きで spec を更新するだけで済む設計。
- **app_data 肥大**: 複数言語/大型を溜めると数百 MiB。未使用モデルの GC（最終利用日で削除）は後続課題。

---

## 付録: 参照 file:line

- 同梱定義: `src-tauri/tauri.release.conf.json:4-9`、`src-tauri/tauri.conf.json:32-46`
- spec 正本/byte-stability: `src-tauri/src/semantic/spec.rs:104-147`（SPEC_JA/EN）, `:80-82`（full_model_id）, `:151-157`（spec_for_language）, `:159-205`（regression test）, `:124-131`（EN calibration/MIT）
- ローダ: `src-tauri/src/commands/semantic.rs:86-96`（resolve_model_dir）, `:100-123`（load/ensure_embedder）, `src-tauri/src/semantic/embedding.rs:53-84`（Embedder::load）
- staleness: `src-tauri/src/semantic/index.rs:170-225`（collect_index_status）
- 言語: `src-tauri/crates/grimodex-db/src/migrate.rs`（projects.language default 'ja'）, `src-tauri/src/semantic/index.rs:349-376`
- DL 基盤: `src-tauri/Cargo.toml:55`（reqwest）, `src-tauri/src/license.rs:149-180`（timeout 例）, `src-tauri/src/ai.rs:2309-2326`（stream 例）, `src-tauri/src/external_mount/hash.rs:10-14`（sha256）, `src-tauri/src/lib.rs:74-77`（app_data_dir）
- CSP/firewall: `src-tauri/tauri.conf.json:28`, `.devcontainer/init-firewall.sh:95-108`
- degrade 経路: `src/features/chat/semanticRecall.ts:352-426`（fetchSemanticRecall）, `src/features/related-scenes/fetchRelatedScenes.ts:53-105`（fetchRelatedPastScenes）, `src/features/commandCenter/hooks/useCommandCenterSearch.ts:55-58`, `src-tauri/src/commands/semantic.rs:351-393`, `src/features/semantic-search/autoIndex.ts:15-21`
- 進捗基盤: `src/features/semantic-search/ReindexProgressToast.tsx`, `src-tauri/src/commands/semantic.rs:66`
- トリガ: `src-tauri/src/commands/workspace.rs:128-171`
