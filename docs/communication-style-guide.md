# Grimodex 広報・リリースノート文体運用規約

## 1. 目的

本規約は、Grimodexの広報、リリースノート、告知文、README冒頭などに共通する文体と用語を定める。

Grimodexの対外文書は、単なる「AI搭載小説執筆アプリ」の説明ではなく、物語制作を扱う端末の運用通達として記述する。ただし、世界観の演出によって機能、障害、影響範囲、対応方法が分かりにくくなってはならない。

基本原則は次の一文に集約する。

> **製品用語は正確に、周囲の制度だけを奇妙にする。**
>
> **Keep the product terminology literal. Make the surrounding institution strange.**

---

## 2. 適用範囲

### 2.1 適用する文書

- GitHub Releasesのリリースノート
- リリース、延期、障害、保守に関する告知
- X、Bluesky、Mastodonなどに掲載する短文
- READMEのタイトル、タグライン、冒頭紹介
- 公式サイト、配布ページ、紹介動画の見出し
- 開発状況報告

### 2.2 原則として適用しない箇所

以下では、読みやすさ、検索性、法的明確性、技術的正確性を優先し、通常の用語を使う。

- アプリ内のボタン、メニュー、設定項目
- エラーメッセージと復旧手順
- API、IPC、MCP、CLIの仕様
- ソースコード、型名、識別子、データベース名
- 利用規約、ライセンス、プライバシーポリシー
- セキュリティアドバイザリの技術詳細
- 開発者向けセットアップ手順
- Issue、PR、コミットメッセージ

原則は次のとおり。

> **広報では怪しく、操作系と技術文書では正気を保つ。**

---

## 3. 正式呼称

### 3.1 日本語

儀式的な完全呼称は次を使用する。

> **大規模言語モデル統合型物語編纂端末《GRIMODEX》**

用途に応じて次の短縮形を使用する。

| 用途 | 呼称 |
| --- | --- |
| 文書の最初の一回 | 大規模言語モデル統合型物語編纂端末《GRIMODEX》 |
| 以後の本文 | 物語編纂端末《GRIMODEX》 |
| 同一段落内の再言及 | 本端末 |
| 技術説明、機能名、通常文 | Grimodex |

完全呼称を同一文書内で繰り返さない。原則として冒頭の一回だけ使用する。

### 3.2 英語

英語の正式表記は次を使用する。

> **GRIMODEX // LLM-INTEGRATED NARRATIVE AUTHORING TERMINAL**

用途に応じて次の短縮形を使用する。

| 用途 | 呼称 |
| --- | --- |
| タイトル、キービジュアル | GRIMODEX // LLM-INTEGRATED NARRATIVE AUTHORING TERMINAL |
| 本文の最初の一回 | the GRIMODEX terminal |
| 以後の本文 | Grimodex / the terminal |
| 技術説明、機能名 | Grimodex |

`//` はタイトル、見出し、短い識別行にだけ使用する。通常の散文では多用しない。

### 3.3 タグライン

標準タグラインは次を使用できる。

日本語：

> **人間、AI、知識、来歴を、一つの記録系へ。**

英語：

> **Human intent, AI, knowledge, and provenance—within one record system.**

タグラインは必須ではない。説明文と競合する場合は省略する。

---

## 4. ユーザーの呼称

### 4.1 広報上の呼称

日本語では次を使用する。

> **運用者《オペレーター》**

複数の利用者への呼びかけは次を使用する。

> **運用者《オペレーター》各位。**

英語では次を使用する。

> **operator**

見出しでは次を使用する。

> **OPERATOR NOTICE**

本文冒頭では次を使用できる。

> **To all operators:**

### 4.2 `ユーザー` / `user` を使う箇所

以下では演出語を使用せず、`ユーザー` または `user` と記述する。

- 利用規約、プライバシーポリシー、ライセンス
- 権限、認証、アカウント、OSユーザーの説明
- UI研究、アクセシビリティ、ユーザーテスト
- 型名やAPI仕様
- `administrator`、`admin`、`root` など権限概念との区別が必要な箇所

`管理者《オペレーター》` は使用しない。管理者権限との混同を招くためである。

---

## 5. 変更しない製品用語

次の語は、SF的な言い換えをせず、そのまま使用する。

- AI
- LLM / 大規模言語モデル
- AI agent / AIエージェント
- Codex
- MCP / MCP server
- OpenAI、Anthropic、OpenRouter、Ollamaなどのサービス名
- Electron、React、TypeScript、Rust、SQLiteなどの技術名
- semantic search / セマンティック検索
- source attribution / 出所追跡
- chat / AI chat
- editor / エディタ
- project / プロジェクト
- database / データベース
- import / export
- backup / バックアップ

禁止例：

| 使用しない表現 | 使用する表現 |
| --- | --- |
| 補助思考機関 | AI / LLM |
| 自律作業機関 | AIエージェント |
| 局所知識基底 | Codex |
| 外部知性接続門 | MCP server |
| 記録体 | プロジェクト、ファイル、データベース |
| 意味記憶検索系 | セマンティック検索 |

見出しや文書全体の枠組みには演出を加えてよいが、製品内で実際に表示される名称、設定名、機能名は改変しない。

---

## 6. 文体

### 6.1 基本トーン

- 無機質
- 事務的
- 運用通達的
- わずかに過剰な厳粛さ
- 感情を煽らず、事実を淡々と記録する

目標は「宇宙船のシステムログ」そのものではなく、**正体のよく分からない組織が発行した業務通達**である。

### 6.2 情報量の配分

- タイトルと見出し：演出を強くしてよい
- 冒頭の一、二文：端末文体を維持する
- 機能説明、修正内容、影響範囲：通常の技術文として明確に書く
- 復旧手順、バックアップ、互換性：完全に平易な言葉で書く

目安は次のとおり。

> **演出 30%、実務 70%。**

### 6.3 避ける文体

- 意味のない疑似技術用語の連打
- 軍事命令、脅迫、服従を求める表現
- 読み手を世界観上の役職へ過度に固定する表現
- 修正内容を隠すほど遠回しな比喩
- 根拠のない「完全」「絶対」「安全」
- 企業広報でありがちな過剰な自賛
- 何でも大文字にすること
- 本文すべてをシステムログ形式にすること

悪い例：

> 第七記憶層に発生した時間的断裂を封印し、認識位相の恒常性を回復しました。

良い例：

> エディタ初期化時の競合により、古い状態が反映されることがある不具合を修正しました。

見出しだけを演出するなら次のようにする。

```md
## 解消済み異常

- エディタ初期化時の競合により、古い状態が反映されることがある不具合を修正しました。
```

---

## 7. 日本語の標準語彙

| 通常の分類 | 標準表現 | 備考 |
| --- | --- | --- |
| リリースノート | 端末更新通達 / 更新記録 | タイトルで使用 |
| リリース | 配備 / リリース | 本文では検索性のため「リリース」も併記可 |
| バージョン | Revision / バージョン | `v2.0.0` は変更しない |
| 新機能 | 機能系統増設 | 本文では具体的な機能名を書く |
| 改善 | システム改修 | 性能、UI、内部設計など |
| バグ修正 | 解消済み異常 | 原因まで修正済みの場合 |
| 暫定対処 | 封鎖済み異常 | 影響を抑えたが根本原因が残る場合 |
| 既知の問題 | 既知異常 | 未解決であることを明記 |
| 破壊的変更 | 互換性通達 | 移行方法を必ず書く |
| 非推奨 | 系統廃止予告 | 廃止予定時期を記載 |
| セキュリティ修正 | 保安系統改修 | 深刻度と対象バージョンを併記 |
| 更新必須 | 運用者対応必須 | 実施内容と期限を明記 |
| インストール | 配備手順 / インストール | 手順本文では通常語を優先 |
| 延期 | 配備延期通達 | 新しい予定が未定なら未定と書く |
| 実験機能 | 試験運用 | 安定性とデータ互換性を記載 |
| 安定版 | 安定配備 / Stable | チャンネル名は変更しない |

### 7.1 異常分類の意味

#### 解消済み異常

原因を修正し、再発防止を含む恒久対応が完了している。

#### 封鎖済み異常

クラッシュ、データ破損、誤動作などの影響は抑えたが、根本原因または制約が残っている。

#### 既知異常

未解決であり、現在も発生する可能性がある。条件、影響、回避策を可能な限り記載する。

この三分類を雰囲気だけで使い分けてはならない。

---

## 8. 英語の標準語彙

| 通常の分類 | 標準表現 | 備考 |
| --- | --- | --- |
| Release notes | TERMINAL REVISION | 文書タイトル |
| Release announcement | DEPLOYMENT BULLETIN | 告知見出し |
| User notice | OPERATOR NOTICE | 呼びかけ |
| New features | NEW CAPABILITIES | 新機能 |
| Improvements | SYSTEM MODIFICATIONS | 改善、内部改修 |
| Bug fixes | RESOLVED ANOMALIES | 根本修正済み |
| Mitigations | CONTAINED ANOMALIES | 暫定封じ込め |
| Known issues | KNOWN ANOMALIES | 未解決 |
| Breaking changes | COMPATIBILITY NOTICE | 移行手順必須 |
| Deprecations | DECOMMISSIONING NOTICE | 廃止予告 |
| Security fixes | SECURITY CORRECTIONS | 深刻度を隠さない |
| Update required | OPERATOR ACTION REQUIRED | 必須対応 |
| Postponement | DEPLOYMENT DELAY NOTICE | 延期告知 |
| Installation | DEPLOYMENT PROCEDURE | 手順本文では install を使用可 |
| Experimental | EXPERIMENTAL SYSTEMS | 実験機能 |
| Stable | OPERATIONAL / STABLE | 事実に応じて使用 |

### 8.1 `deployed` と `released`

アプリの一般公開には、本文で `is now available` または `has been released` を使用する。

`has been deployed` はサーバー側機能や内部コンポーネントには自然だが、デスクトップアプリの配布に常用すると強制配備のように読める。そのため次のように使い分ける。

- 見出し：`DEPLOYMENT BULLETIN`
- デスクトップアプリ：`is now available`
- サーバー、Workers、バックエンド：`has been deployed`

---

## 9. 重大情報の扱い

演出よりも、運用者の安全と判断を優先する。

以下を含む場合は、通常の用語を必ず併記する。

- データ消失
- データ破損
- セキュリティ脆弱性
- 認証、権限、秘密情報の漏えい
- 破壊的変更
- 起動不能
- 互換性断絶
- バックアップ必須
- 自動移行に失敗する可能性

例：

> **既知異常：プロジェクトの一部が保存されない可能性があります（データ消失バグ）。**

次のような曖昧化は禁止する。

> 記録系の一部に不安定な挙動を確認しています。

重大な影響が生じた場合、世界観を理由に謝罪を避けない。

日本語：

> この問題により作業へ影響を受けた運用者の皆様にお詫びします。

英語：

> We apologize to operators whose work was affected by this issue.

---

## 10. 表記規則

### 10.1 製品名

- 通常表記：`Grimodex`
- 儀式的表記：`GRIMODEX`
- package、repository、CLI、ファイル名は実際の識別子に従う
- `GRIMODEX` を本文全体で連呼しない

### 10.2 バージョン

- `v2.0.0` の形式を基本とする
- `Revision v2.0.0` と記述してよい
- 実際のSemVerと異なる番号を演出目的で付けない
- コードネームを付ける場合もバージョン番号を省略しない

### 10.3 山括弧

日本語の演出呼称には二重山括弧 `《》` を使用する。

- 正：`物語編纂端末《GRIMODEX》`
- 誤：`物語編纂端末（GRIMODEX）`
- 誤：`物語編纂端末「GRIMODEX」`

ただし、検索性やコピー性が重要なタイトルでは `Grimodex` を別途含める。

### 10.4 英語見出し

英語の演出見出しは大文字で統一する。

```md
## NEW CAPABILITIES
## SYSTEM MODIFICATIONS
## RESOLVED ANOMALIES
```

本文は通常のsentence caseで書く。

### 10.5 メタデータブロック

必要に応じて次を使用できる。

```text
STATUS: OPERATIONAL
CHANNEL: STABLE
DISTRIBUTION: PUBLIC
```

事実と一致する項目だけを書く。開発版を `OPERATIONAL`、限定公開を `PUBLIC` と表記してはならない。

---

## 11. 標準テンプレート

### 11.1 デスクトップ GitHub Release リリースノートの必須節

デスクトップ版の GitHub Release 本文では、変更一覧より前に次の節を必ず置く。

| 目的                   | 日本語の必須見出し                         | 英語の必須見出し                      |
| ---------------------- | ------------------------------------------ | ------------------------------------- |
| 対象環境と配布物を選ぶ | `## 配備要領`                              | `## DEPLOYMENT PROCEDURE`             |
| 導入前の判断材料を示す | `## ⚠️ インストール前に必ずお読みください` | `## ⚠️ Please read before installing` |

`配備要領` / `DEPLOYMENT PROCEDURE` には、現行 Assets と一致する対象 OS、CPU
architecture、release channel、配布形式、公式 Release ページへのリンクを記載する。
ブラウザ版 Editor の提供が継続している場合は、そのリンクも併記する。
手動導入用の配布物と、自動更新、署名、検証だけに使用する Assets を区別する。OS や
runtime library の下限がある場合は明記し、AUR など Release 公開後の別工程で更新される
配布経路は、利用可能になる条件を記載する。

導入前の注意には、少なくとも次の事項を平易な通常文で記載する。

1. プラットフォーム別の配備区分
2. 直前の公開版および移行対象となる旧版からの更新方法
3. コード署名と OS が表示しうるセキュリティ警告
4. データ保管、バックアップ、および AI 利用時の外部接続
5. Draft、公開済み Release、外部 package registry の現在状態に応じた利用可能時期

直近の公開済み GitHub Release は節構成と情報粒度の基準として参照する。ただし、version、
公開状態、channel、Assets、署名状態、更新経路をコピーしてはならない。対象 Revision の
workflow、配布物、検証結果から再確認する。Draft 用の文面は公開可能な完成度まで作成するが、
公開済みと断定せず、`DISTRIBUTION: PUBLIC` など未確定の metadata を記載しない。

以下の日本語／英語テンプレートは、公開済み Release の例である。Draft を作成する場合は
`STATUS`、`CHANNEL`、`DISTRIBUTION` を検証済みの lifecycle 状態へ置き換えるか、未確定なら
省略する。「リリースしました」「is now available」などの公開済み表現は使用せず、
公開前であることが分かる中立な表現へ置き換える。

### 11.2 日本語リリースノート

```md
# 端末更新通達 // GRIMODEX REVISION vX.Y.Z

STATUS: OPERATIONAL
CHANNEL: STABLE
DISTRIBUTION: PUBLIC

## 運用者《オペレーター》各位

大規模言語モデル統合型物語編纂端末《GRIMODEX》、Revision vX.Y.Zをリリースしました。

本改訂では、[最も重要な変更]、[二番目の変更]、[必要なら三番目の変更]を実施しています。

## 配備要領

下記 Assets から、対象環境に対応するインストーラーまたはパッケージを選定し、取得してください。

| 対象環境            | 公開区分             | 手動導入用の配布形式  |
| ------------------- | -------------------- | --------------------- |
| [OS / architecture] | [Stable / Open Beta] | [現行 Assets の形式]  |

- [Revision vX.Y.Z の公式配布ページ]
- [提供中の場合はブラウザ版 Editor]

## ⚠️ インストール前に必ずお読みください

### プラットフォーム別配備区分

- [各 OS の配備区分と、試験運用の場合の注意]

### 更新方法

- [直前の公開版からの更新方法]
- [移行対象となる旧版からの更新方法]

### コード署名およびセキュリティ警告

- [各 OS の署名、公証、警告表示、および公式配布元の確認方法]

### データ保管および AI 利用

- [データの保存先、backup、AI 利用時の外部接続]

## 機能系統増設

- [新機能と運用者への効果]
- [新機能と運用者への効果]

## システム改修

- [改善内容]
- [性能、UI、内部構造などの変更]

## 解消済み異常

- [不具合の発生条件と、何が直ったか]
- [不具合の発生条件と、何が直ったか]

## 封鎖済み異常

- [影響を抑えた内容。根本原因が残る場合だけ記載]

## 既知異常

- [発生条件]
  - 影響：[影響]
  - 回避策：[回避策]

## 互換性通達

- [破壊的変更]
- [移行方法]
- [バックアップの要否]

## 運用者対応必須

- [必要な操作]
- [期限または対象バージョン]
```

存在しない節は削除する。空の節を残さない。

### 11.3 English release notes

```md
# GRIMODEX // TERMINAL REVISION vX.Y.Z

STATUS: OPERATIONAL
CHANNEL: STABLE
DISTRIBUTION: PUBLIC

## OPERATOR NOTICE

Revision vX.Y.Z of the GRIMODEX LLM-integrated narrative authoring terminal is now available.

This revision [summarize the most important change and its effect in plain English].

## DEPLOYMENT PROCEDURE

Select and obtain the installer or package for your environment from the Assets below.

| Target environment  | Release channel      | Manual installation formats             |
| ------------------- | -------------------- | --------------------------------------- |
| [OS / architecture] | [Stable / Open Beta] | [Formats present in the current Assets] |

- [Official Revision vX.Y.Z release page]
- [Browser Editor, when currently available]

## ⚠️ Please read before installing

### Platform release classification

- [Release classification for each OS and any trial-use notice.]

### Update procedure

- [Update procedure from the immediately preceding public release.]
- [Update procedure from any supported migration source.]

### Code signing and security notices

- [Signing, notarization, possible OS warnings, and official source verification for each OS.]

### Data storage and AI use

- [Data location, backup guidance, and external connections used by configured AI.]

## NEW CAPABILITIES

- [Feature and operator-facing benefit.]

## SYSTEM MODIFICATIONS

- [Improvement or internal change.]

## RESOLVED ANOMALIES

- Fixed an issue where [condition and impact].

## CONTAINED ANOMALIES

- Reduced the impact of [issue]. The underlying limitation remains under investigation.

## KNOWN ANOMALIES

- [Condition.]
  - Impact: [Impact.]
  - Workaround: [Workaround.]

## COMPATIBILITY NOTICE

- [Breaking change.]
- [Migration procedure.]
- [Backup requirement.]

## OPERATOR ACTION REQUIRED

- [Required action.]
- [Deadline or affected versions.]
```

### 11.4 日本語の短いリリース告知

```text
運用者《オペレーター》各位。

物語編纂端末《GRIMODEX》Revision vX.Y.Zをリリースしました。

本改訂では、[主要変更]を実施し、[主要な不具合]を解消しています。

更新記録：[URL]
```

### 11.5 English short release announcement

```text
OPERATOR NOTICE

GRIMODEX terminal revision vX.Y.Z is now available.

This revision adds [major capability], improves [area], and resolves [major issue].

Full revision record: [URL]
```

### 11.6 配備延期通達

日本語：

```md
# 配備延期通達 // GRIMODEX

運用者《オペレーター》各位。

物語編纂端末《GRIMODEX》の次期Revisionは、当初告知した時期より遅れてリリースされます。

延期の理由は、[具体的な理由]です。現行の開発版は[現在の状態]ですが、公開配布に必要な[検証、品質、互換性など]を満たしていません。

新しいリリース日は[日付 / 未定]です。日程が確定次第、改めて更新通達を発行します。
```

英語：

```md
# GRIMODEX // DEPLOYMENT DELAY NOTICE

To all operators:

The next GRIMODEX terminal revision will be released later than previously announced.

The delay is due to [specific reason]. The current development build is [current state], but it has not yet met the [validation, quality, or compatibility] requirements for public distribution.

The revised release date is [date / not yet determined]. A new deployment bulletin will be issued when the schedule is confirmed.
```

### 11.7 緊急修正

日本語：

```md
# 運用者対応必須 // GRIMODEX REVISION vX.Y.Z

Revision vX.Y.Zで、[データ消失 / 起動不能 / 脆弱性など]につながる不具合を修正しました。

影響を受けるバージョン：[version range]
推奨対応：[直ちに更新 / 機能を無効化 / バックアップなど]
回避策：[存在する場合]

この問題により作業へ影響を受けた運用者の皆様にお詫びします。
```

英語：

```md
# GRIMODEX // OPERATOR ACTION REQUIRED

Revision vX.Y.Z resolves an issue that could cause [data loss / startup failure / security impact].

Affected versions: [version range]
Recommended action: [update immediately / disable feature / create a backup]
Workaround: [if available]

We apologize to operators whose work was affected by this issue.
```

---

## 12. README冒頭の標準形

日本語：

```md
# GRIMODEX

**大規模言語モデル統合型物語編纂端末**

Grimodexは、AIチャット、Codex、AIエージェント連携、構造化された物語設計、出所追跡を備えた、ローカルファーストのデスクトップ小説執筆エディタです。
```

英語：

```md
# GRIMODEX // NARRATIVE AUTHORING TERMINAL

**LLM-INTEGRATED NARRATIVE AUTHORING TERMINAL**

Grimodex is a local-first desktop novel-writing editor with AI chat, Codex, AI agent integration, structured story planning, and provenance tracking.
```

タイトルの直後には、一般的な言葉による一文説明を必ず置く。初見の読者に製品種別を推測させない。

---

## 13. 良い例と悪い例

### 13.1 新機能

悪い例：

> 新たな外部思考機関との接続門を開放しました。

良い例：

> **機能系統増設**
>
> Codex CLIとの接続に対応しました。既存のCLI認証を利用して、Grimodex内からAIエージェントを実行できます。

### 13.2 バグ修正

悪い例：

> 編集区画に残留していた時間的不整合を封鎖しました。

良い例：

> **解消済み異常**
>
> エディタの初期化処理が重複し、古い内容が表示されることがある競合を修正しました。

### 13.3 既知の問題

悪い例：

> 一部環境では表示系統が不安定です。

良い例：

> **既知異常**
>
> 一部のWayland環境では、ウィンドウのリサイズ中に描画が乱れることがあります。編集内容には影響しません。ウィンドウを最小化して再表示すると復旧します。

### 13.4 英語

悪い例：

> The external cognition gateway has been activated.

良い例：

> **NEW CAPABILITIES**
>
> Added Codex CLI integration. Operators can now run the AI agent from Grimodex using their existing CLI authentication.

---

## 14. 作成手順

リリースノートや告知文は次の順序で作成する。

1. 変更を事実ベースで列挙する。
2. `新機能`、`改善`、`解消済み`、`封鎖済み`、`既知`、`互換性変更`に分類する。
3. データ消失、脆弱性、起動不能、移行失敗の可能性を先に確認する。
4. 運用者が必要とする操作、バックアップ、回避策を書く。
5. 本文を通常の技術文として完成させる。
6. 最後にタイトル、見出し、呼びかけへ端末文体を適用する。
7. 日本語版と英語版の意味、深刻度、対応方法が一致しているか確認する。

世界観の文章を先に書いてから、事実を後付けしてはならない。

---

## 15. 公開前チェックリスト

- [ ] 冒頭だけで、何がリリースまたは発生したか分かる
- [ ] AI、LLM、AIエージェント、Codex、MCPなどの正式用語を改変していない
- [ ] 完全呼称を繰り返していない
- [ ] `解消済み`、`封鎖済み`、`既知`を正しく分類している
- [ ] データ消失、脆弱性、起動不能を曖昧な表現で隠していない
- [ ] 破壊的変更に移行手順を付けている
- [ ] 必要な場合、バックアップ手順を明記している
- [ ] 対象バージョン、OS、環境、発生条件が明確である
- [ ] 運用者に必要な操作が明確である
- [ ] 見出しを除く本文は普通に読める
- [ ] 日本語版と英語版で事実と深刻度が一致している
- [ ] `STATUS`、`CHANNEL`、`DISTRIBUTION` が事実と一致している
- [ ] デスクトップ GitHub Release の日英版に、必須の配備要領と導入前注意の節がある
- [ ] 配備表の OS、architecture、channel、形式が現行 Assets と一致している
- [ ] 手動導入用 Assets、動作要件、自動更新用 Assets、公開後に更新される外部配布経路を区別している
- [ ] 更新方法、署名、backup、データ保管、AI 利用の説明に古い Revision の事実が残っていない
- [ ] リリース、bug fix、known issueなど一般的な検索語が本文にも含まれている
- [ ] リンク先、バージョン番号、日付が正しい

---

## 16. 運用上の優先順位

判断が衝突した場合は、次の順序で優先する。

1. 安全性
2. 技術的正確性
3. 読みやすさ
4. 検索性
5. 日英間の意味的一致
6. Grimodex固有の文体

文体は重要だが、上位五項目を犠牲にしてはならない。

---

## 17. 本規約の位置づけ

このファイルを、Grimodexの対外文書における文体と演出語彙の正本とする。

新しい呼称や見出しを恒常的に使用する場合は、本規約へ追加する。一度きりの冗談やキャンペーン表現は正本へ追加せず、製品機能の正式名称にも昇格させない。
