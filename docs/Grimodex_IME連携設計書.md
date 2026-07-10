# Grimodex IME連携設計書 — プロジェクトCodex語彙の変換辞書注入

## 1. 目的

執筆中プロジェクトのCodex項目（キャラクター名・地名・造語などの固有名詞）を、システムIMEの変換辞書へ優先的に注入し、創作固有名詞の変換を一発で通せるようにする。

第一想定の消費者は開発予定のzenz系IME（azooKeyフォーク）だが、**プロトコルはIME非依存**とし、mozc系（mozkey等）や他のIMEも同じファイルを取り込めるようにする。

対象OS: macOS / Windows / Linux（Grimodex本体がTauri v2で3OS対応のため、プロトコルも3OS対応を必須とする）。iOSキーボード拡張はApp Group等の共有境界が別問題のためスコープ外。

## 2. 全体アーキテクチャ

```
┌─────────────── Grimodex (Tauri) ───────────────┐
│ codex_entries (+readings)                       │
│   └→ mutation イベント (debounce)               │
│        └→ [Rust] ime_export: 辞書スナップ生成    │
│             └→ <app_data_dir>/ime/ へ atomic 書出│
└─────────────────────────────────────────────────┘
                       │ ファイル watch（OS別API）
┌─────────────── IME側アダプタ（OS別） ────────────┐
│ macOS: azooKey-Desktop fork (IMKit)             │
│ Linux: fcitx5-hazkey fork (fcitx5)              │
│ Windows: mozkey fork / TSF (要選定)             │
│   └→ 動的ユーザ辞書へ差替 + zenzプロフィール注入 │
└─────────────────────────────────────────────────┘
```

設計原則:

- **疎結合**: 連携は「辞書スナップショットファイル + 状態ファイル」のみ。IME側からGrimodexのSQLiteを直読みすることは禁止（スキーマ進化への追随不能、WAL並行アクセスの複雑化のため）。
- **二層分離**: プロトコル（ファイル形式・配置規約・正規化規則）はOS共通。ファイル監視・品詞マップ・スコープ判定などの取り込み実装のみOS別アダプタに置く。
- **方向はv1では一方向**（Grimodex→IME）。IME確定ログからの還流はv2（§10）。

## 3. データモデル変更（Grimodex側）

### 3.1 `codex_entries.readings` 列の追加

変換辞書は読みがキーであり、現行スキーマには読み情報が存在しないため追加する。

- 型: `TEXT`（JSON、`Record<string, string[]>` = 表記→読みの配列）。同一表記の複数読み（ルビ揺れ・呼び分け）を許容する。`aliases` / `excludedAliases` と同じJSON文字列カラムの流儀。
- キーは `name` および `aliases[]` の各表記。並列配列にしない（aliases編集で対応関係が壊れるため、表記をキーにしたマップとする）。
- マイグレーション: `src-tauri/src/database/migrate.rs` の `add_column_if_missing` 流儀（`version` 列の前例に従う）+ `src/db/schema.ts` への宣言。
- 改名・別名変更時は `readings` のキーを追随させる（改名波及はGrimodex_Codex改名波及設計書の機構に載せる）。

### 3.2 読みの解決順序（エクスポート時）

1. `readings[surface]` があれば全読みを使用（複数読みは複数辞書エントリに展開）
2. 表記が ひらがな/カタカナ/ASCII のみ → 読みを自動導出（カタカナ→ひらがな正規化）
3. どちらもなければ**注入スキップ**（§3.3の自動推定により原則発生しない。推定失敗時のフォールバック）

### 3.3 読みの入力・推定フロー

- エントリ編集UIに読みフィールドを追加（表記ごと、複数読み可）。読みはIME連携以外にもルビ振り・五十音ソート（codexSort）・検索の将来利用を想定した汎用データとする。
- 漢字を含む表記は、エントリ作成時・表記追加/変更時にAIが読みを**自動推定して即保存する**（承認フローは設けない）。誤推定はUIでの修正を訂正経路とする。既存エントリへの一括推定バックフィルもPhase 1で提供。

## 4. エクスポート先パスとファイル構成

Tauri v2 の `app_data_dir`（identifier: `com.miyakey.grimodex`）配下に `ime/` を切る。

| OS | 既定パス |
|---|---|
| macOS | `~/Library/Application Support/com.miyakey.grimodex/ime/` |
| Windows | `%APPDATA%\com.miyakey.grimodex\ime\` |
| Linux | `$XDG_DATA_HOME/com.miyakey.grimodex/ime/`（既定 `~/.local/share/...`） |

IME側アダプタはこの既定パスをOS別に持ち、設定で上書き可能にする（ポータブル運用・テスト用）。

```
ime/
  state.json                 # アクティブプロジェクトのポインタ
  projects/<project_id>.json # プロジェクト別辞書スナップショット
  consumers/<consumer_id>.json # IME側が書くハンドシェイク（§5.4）
```

## 5. プロトコル仕様（format_version: 1）

### 5.1 state.json

```json
{
  "format_version": 1,
  "active_project_id": "prj_xxx",
  "updated_at": "2026-07-10T12:00:00.000Z"
}
```

- `active_project_id` は「最後にフォーカスされたGrimodexウィンドウのプロジェクト」。マルチウィンドウ（codexWindowSync等で複数ウィンドウ運用が前提）ではウィンドウフォーカスイベントで更新する。全プロジェクトを閉じたら `null`。
- IME側は state.json が指す辞書**のみ**をロードする（全プロジェクト常時ロードはv1ではしない）。

### 5.2 projects/&lt;project_id&gt;.json

```json
{
  "format_version": 1,
  "project_id": "prj_xxx",
  "project_name": "溶鉄の…",
  "generated_at": "2026-07-10T12:00:00.000Z",
  "entries": [
    { "yomi": "せつな", "surface": "刹那", "category": "person", "priority": 2, "entry_id": "cdx_xxx" }
  ],
  "profile": "軍事SF。主要人物: 刹那、…（zenz条件付け用の要約文字列）"
}
```

フィールド仕様:

- `yomi`: **ひらがな正規化済み**（カタカナ→ひらがな、NFKC、前後空白除去）。正規化はGrimodex側の責務とし、IME側は正規化済みを前提してよい。
- `surface`: 表記そのまま。name と aliases、および複数読みを**展開済みのフラット配列**にする（1エントリ=1読み1表記）。
- `category`: `person`（type slug `character`）/ `place`（`location`）/ `noun`（`item`・`lore`・カスタムtype）。IME側で品詞（人名/地名/固有名詞一般）にマップする。
- `priority`: `1`=通常、`2`=優先（`contextMode: "always"` のエントリ等）、`3`=予約。IME側のコスト調整の**目安**であり、絶対値の意味は持たせない。
- `profile`: zenz-v3のプロフィール条件付け用文字列（optional、zenz非搭載IMEは無視してよい）。生成材料は `projects.genre`（英語slugのため日本語ラベルへ変換して埋め込む）+ `projects.outline`（物語の意図・テーマの正本。AIコンテキストL2常時注入と同じ位置づけのため材料として最適）+ 主要エントリ名（`priority` 降順）。この順で連結し400字目安に切り詰める。genre/outline が空ならエントリ名のみで生成する。
- `entry_id`: 還流（v2）とデバッグ用のトレーサビリティ。

エントリ数の上限はプロトコルとしては設けない。実効上限はIME側の動的辞書ロードと変換レイテンシに依存するため、Phase 3のベンチマークで実測して決める（必要になればIME側が `priority` 降順で間引く）。

注入対象の選別:

- `excludedAliases` は**注入しない**（メンション検出から除外された語 = 一般語衝突をユーザが既に宣言している語であり、変換誤爆源になる）。
- `contextMode: "hidden" / "suppress"` のエントリは既定では**含める**（書くのは本人でありネタバレ概念は変換には無害）。ただし設定で除外可能にする（§8のプライバシー整合）。

### 5.3 互換性ポリシー

- 後方互換の追加はフィールド追加で行い、`format_version` は破壊的変更時のみ上げる。
- IME側は未知フィールドを無視する（must-ignore）。

### 5.4 consumers/&lt;consumer_id&gt;.json（IME→Grimodexハンドシェイク）

IME側がインストール時・起動時に作成/touchし、アンインストーラが削除する。

```json
{
  "format_version": 1,
  "consumer_id": "azookey-grimodex",
  "name": "…",
  "version": "…",
  "capabilities": { "profile": true },
  "last_seen": "2026-07-10T12:00:00.000Z"
}
```

- Grimodexはこのファイルの存在で「IMEインストール済み」を判定し、連携を自動ONにする（§8）。OS別のインストール痕跡探索はしない。
- `capabilities` は還流（v2）等の将来のネゴシエーション用に予約。v1ではGrimodex側は参照しない（profileは常に書き出す）。

## 6. 書き出し実装（Grimodex側）

- **有効判定**: 連携モードは `auto`（既定。`consumers/` の検出でON、IME不在なら何も書き出さない）/ `on` / `off` の3値設定。`off` が常に最優先。
- **トリガ**:
  - state.json — プロジェクトopen/close、ウィンドウフォーカス変化
  - projects/*.json — codex mutation のうち name / aliases / excludedAliases / readings / type / エントリ削除（`content` 等の本文変更では書き出さない）
- **debounce**: 1〜2秒。連続編集で書き出しが暴れないようにする。
- **atomic write**: 一時ファイル→`rename`。IME側が中途半端なJSONを読まないための必須要件。
- **実装位置**: フロントの `features/codex/api.ts` 層のmutation後イベント→Tauriコマンド `ime_export_refresh(project_id)` をdebounce呼び出し。JSON生成とファイルI/OはRust側に一元化する（マルチウィンドウでも書き手はTauriメインプロセス1つなので、プロセス内mutexで直列化すれば競合しない）。
- **クリーンアップ**: プロジェクト削除時に対応する `projects/<id>.json` を削除。設定画面に「書き出し済み辞書をすべて削除」を用意。

## 7. IME側アダプタ（参考実装ガイド）

各OSアダプタの共通ロジック:

1. インストール時・起動時に `consumers/<consumer_id>.json` を作成・touch（§5.4）。アンインストーラで削除
2. `state.json` をファイル監視（macOS: FSEvents/DispatchSource、Linux: inotify、Windows: ReadDirectoryChangesW）
3. `active_project_id` の変化 or 辞書ファイル更新 → パース → **動的ユーザ辞書を差し替え**
4. 静的な辞書コストブーストは**控えめ**にする（強すぎると一般語を食う。「刹那」「先生」型の一般語衝突は文脈側=zenzの判断に委ねる）
5. `profile` をzenz-v3のプロフィール条件付けに渡し、文脈バイアスで勝たせる（これがzenz系での本命の優先機構）
6. スコープ: フォーカス中アプリがGrimodex（`com.miyakey.grimodex`）のとき自動有効化 + 「全アプリで有効」トグル

OS別の注意点:

| OS | ベース | 備考 |
|---|---|---|
| macOS | azooKey-Desktop フォーク | AzooKeyKanaKanjiConverterに動的ユーザ辞書追加機構あり。IMKitクライアントの bundleIdentifier でスコープ判定可能 |
| Linux | fcitx5-hazkey フォーク | エンジンが同じAzooKeyKanaKanjiConverterのためmacOSと同等機能。ただしWaylandではフォーカスアプリ判定に制約 → 「全アプリで有効」トグル運用を既定とする |
| Windows | mozkey フォーク or TSF自作 | mozc系のユーザ辞書機構へ注入。zenzプロフィール相当の有無は要調査（なければ辞書コストのみで運用） |

## 8. セキュリティ・プライバシー

- 通信は発生しない。すべてローカルファイル。
- 連携モードの既定は `auto`: 同梱IMEのインストールをハンドシェイク（§5.4）で検出したときのみ書き出しが始まる。IME不在の環境ではファイルを一切作らない。設定で `off` に固定可能（常に最優先）。
- Codexにはネタバレ・未公開設定が含まれ、辞書ファイルは**平文**で書かれる。設定画面に書き出し先パスと書き出される内容の説明を明示する。
- 除外オプション: `hidden` / `suppress` エントリの除外、`profile` の書き出し停止（語彙リストのみ）を設定で選べるようにする。

IME側実装のセキュリティ要件（フォーク側リポジトリへの申し送り）:

- IMEは全アプリの打鍵を見られる特権コンポーネントであるため、IMEプロセスは**ネットワーク権限ゼロ**を設計原則とする（Zenzai系はローカル完結で成立する。更新はインストーラ/Grimodex側の責務に寄せる）
- 辞書JSON（§5）は**信頼しない入力**として扱う: サイズ上限・堅牢パース・パース失敗時は無視して継続
- セキュアインプット（パスワード欄等）では変換・学習を停止する
- Windows（TSF）はIMEコードが各アプリのプロセス内にロードされるモデルのため、アプリ内コードを極薄クライアントに留め変換・学習を別プロセスに分離するmozc系のプロセス分離を**フォーク後も維持する**
- 学習データ・辞書キャッシュのファイル権限はユーザ専用（0600相当）とする

## 9. 配布・インストール

Grimodexのインストール時にIMEを同時インストールし、インストール済み環境では連携が自動で有効になる（§8）。「IMEなしでもGrimodexは完全動作する」を不変条件とし、IMEは追加コンポーネントの位置づけとする。

| OS | 同梱方法 | 備考 |
|---|---|---|
| macOS | 初回起動アシスタントがIME .app を `~/Library/Input Methods/` へ配置（ユーザ権限で可、管理者不要） | 入力ソースの有効化はOS仕様上ユーザ操作が必要になり得るため、TIS APIでの登録を試み、不可ならシステム設定へ誘導 |
| Windows | Grimodexインストーラ（NSIS）のオプションコンポーネントとしてIMEインストーラをチェーン実行 | TSFのDLL登録に管理者権限が必要なため初回起動アシスタント方式は不可 |
| Linux | IMEはパッケージ（deb/rpm/AUR）として別途提供。Grimodexのdebは `Recommends` 指定 | fcitx5アドオンはシステムパス配置が必要でアプリからの直接インストール不可。初回起動時に fcitx5/ibus 環境を検出して導線を表示 |

Grimodex本体とIMEの更新サイクルは独立とし、バージョンずれは§5.3の互換性ポリシーで吸収する。

## 10. 還流（v2、将来）

IME側の確定ログから未登録固有名詞候補をGrimodexへ戻し、`candidateExtractor` / CodexCandidates の候補として提示する（コア体験「抽出→構造化」への合流）。プロトコル上は `ime/feedback/` ディレクトリを予約するに留め、v1では実装しない。

**セキュリティ制約（v2仕様の前提として先に固定する）**: 確定ログのファイル書き出しは、設計を誤るとキーロガーのログファイルと等価になる。還流を実装する場合は以下を必須要件とする。

- 収集対象は**Grimodexウィンドウフォーカス中の入力のみ**（§7のスコープ判定を流用）。「全アプリで有効」トグルがONでも、他アプリでの入力は収集しない
- 生の確定文字列を永続化しない。IMEプロセス内で未知語抽出まで行い、**固有名詞候補のみ**を書き出す
- セキュアインプット由来の入力は収集経路に乗せない（§8のIME側要件と整合）

## 11. テスト方針

- Rust（エクスポータ）: スナップショット生成・読み正規化・atomic write の単体テスト（`cargo test --no-default-features`）
- フロント: mutation→debounce→invoke 呼び出しの単体テスト（Vitest、ソース同階層）
- 読み正規化（カタカナ/半角カナ/濁点合成）は表駆動でケースを固定
- レイアウト非関与のためbrowser testは不要

## 12. 実装フェーズ

1. **Phase 1**: `readings` 列 + 編集UI + 自動導出 + AI読み推定（Grimodex単体で完結、ルビ等にも転用可）
2. **Phase 2**: エクスポータ（state.json / projects/*.json）+ 連携モード設定（auto/on/off）+ consumer検出
3. **Phase 3**: macOSアダプタ（azooKey-Desktopフォーク側の取り込み・スコープ判定・profile注入）+ macOS同梱インストール（§9）
4. **Phase 4**: Linux（fcitx5-hazkey）/ Windows（mozkey）+ 各OSインストーラ同梱、還流の検討

Phase 1-2 と Phase 3-4 はリポジトリが分かれる（本体 vs IMEフォーク）。本設計書はプロトコル仕様（§4-5）を両者の契約とする。

## 13. 未決事項

- mozc系エンジンでの `profile` 相当機能の有無（Windowsアダプタ選定時に調査）

## 関連文書

- Grimodex_Codexパネル設計書.md（Codexデータモデル）
- Grimodex_Codex改名波及設計書.md（改名時の波及機構 — readings追随はここに載せる）
- CONTEXT_INJECTION.md（AIコンテキスト注入 — profile生成の材料）
