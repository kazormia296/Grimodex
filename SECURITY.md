# Security Policy / セキュリティポリシー

Thank you for helping keep Grimodex and its users safe.
Grimodex の安全性向上にご協力いただきありがとうございます。

---

## Supported Versions / サポート対象バージョン

Grimodex is pre-1.0 software under active development. Only the **latest released version** receives security fixes. Older versions are not patched — please upgrade.

Grimodex は 1.0 未満の開発中ソフトウェアです。セキュリティ修正の対象は **最新リリース版のみ** で、それ以前のバージョンへのバックポートは行いません。アップデートをお願いします。

| Version | Supported |
| ------- | --------- |
| latest release on `master` | ✅ |
| anything older | ❌ |

---

## Reporting a Vulnerability / 脆弱性の報告

**Please do NOT open a public GitHub Issue for security vulnerabilities.**
**セキュリティ脆弱性を公開 Issue として投稿しないでください。**

Use the following private channel:

**GitHub Private Vulnerability Reporting**

- <https://github.com/kazormia296/Grimodex/security/advisories/new>
- This is the only supported reporting channel. Reports sent by other means may be missed.
- これが唯一の報告窓口です。他の手段による報告は見落とされる可能性があります。

In your report, please include where possible:

報告には可能な範囲で以下を含めてください：

- Grimodex version and OS / バージョンと OS
- Steps to reproduce / 再現手順
- Impact assessment (what an attacker could do) / 想定される影響
- Suggested fix, if any / 修正案（あれば）
- Whether you wish to be credited in the advisory / 公開アドバイザリでのクレジット希望の有無

---

## Response Expectations / 対応の目安

Grimodex is maintained by a single developer, so timelines are best-effort:

メンテナは個人です。対応時間はベストエフォートとなります：

| Stage | Target |
| ----- | ------ |
| Acknowledgement / 受領連絡 | within 7 days / 7 日以内 |
| Initial assessment / 一次評価 | within 14 days / 14 日以内 |
| Fix or mitigation / 修正またはミティゲーション | depends on severity / 重大度による |
| Public disclosure / 公開 | coordinated with reporter / 報告者と調整 |

If you do not receive a reply within 14 days, please re-send via the other channel above — the first message may have been lost.

14 日以内に返信がない場合は、もう一方の連絡経路から再送をお願いします（最初の連絡が届いていない可能性があります）。

---

## Scope / 対象範囲

### In scope / 対象

- The Grimodex desktop application (Tauri shell + frontend + Rust backend)
  - デスクトップアプリ本体（Tauri シェル + フロントエンド + Rust バックエンド）
- Tauri IPC command surface (`src-tauri/src/commands/`)
- Local data handling: SQLite database, file-backed scenes, exports
  - ローカルデータ処理（SQLite、ファイル裏付けされたシーン、エクスポート）
- Handling of user-supplied AI provider API keys
  - ユーザーが入力した AI プロバイダー API キーの取り扱い
- Content Security Policy and webview hardening
  - CSP および WebView のハードニング
- Dependency vulnerabilities that are actually exploitable in Grimodex's usage
  - Grimodex の使用形態で実際に悪用可能な依存関係の脆弱性

### Out of scope / 対象外

- Vulnerabilities in third-party AI provider services themselves (report to that provider)
  - サードパーティ AI プロバイダー側の脆弱性（各プロバイダーへ報告してください）
- Issues requiring physical access to an already-unlocked machine
  - すでにロック解除済みの端末への物理アクセスを前提とする問題
- Social engineering of the user or the maintainer
  - ユーザーまたはメンテナへのソーシャルエンジニアリング
- Self-XSS that requires the user to paste attacker-supplied content into devtools
  - DevTools への手動貼り付けを前提とする self-XSS
- Missing best-practice hardening headers without a demonstrable exploit
  - 具体的な攻撃シナリオを伴わないハードニングヘッダ不足
- Denial-of-service against the user's own local data (the user already controls their machine)
  - ユーザー自身のローカルデータに対する DoS（ユーザーは自端末を完全に制御しているため）

---

## Disclosure Policy / 開示方針

Grimodex follows **coordinated disclosure**:

1. Reporter privately discloses to the maintainer.
2. Maintainer confirms, develops a fix, and prepares an advisory.
3. Fix ships in a release.
4. GitHub Security Advisory is published, crediting the reporter (if they wish).

Grimodex は **調整された開示（coordinated disclosure）** に従います：

1. 報告者から非公開で連絡を受ける
2. メンテナが確認・修正・アドバイザリ準備
3. 修正をリリースに含めて公開
4. GitHub Security Advisory として公開（希望者はクレジット記載）

We ask reporters to refrain from public disclosure until a fix is released or 90 days have elapsed, whichever is sooner.

修正リリースまで、または 90 日経過のいずれか早い方まで、公開を控えていただくようお願いします。

---

## Safe Harbor / セーフハーバー

We will not pursue legal action against researchers who:

以下の条件を満たす研究者に対しては法的措置を取りません：

- Make a good-faith effort to comply with this policy
  - 本ポリシーを誠実に遵守する
- Only test against their own installation of Grimodex
  - 自身がインストールした Grimodex のみを対象とする
- Do not access, modify, or destroy other users' data
  - 他ユーザーのデータにアクセス・改変・破壊しない
- Give the maintainer reasonable time to respond before public disclosure
  - 公開前にメンテナへ合理的な対応時間を与える

---

## Bounty / 報奨金

There is no monetary bug bounty program. Recognition in the published security advisory is offered for qualifying reports if the reporter wishes.

金銭的な報奨金プログラムはありません。ご希望に応じて、公開アドバイザリでのクレジット記載のみ対応いたします。
