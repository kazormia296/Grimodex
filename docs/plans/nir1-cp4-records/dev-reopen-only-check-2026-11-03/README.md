# dev の確認：本文を変えずに開き直しただけで、宣言は残るか（2026-11-03。CP-4 に数えない）

ユーザーの返答「安い代わりの方法を試してもらえますか？」（contracts `55861126`、`user-confirmation-2026-11-03-reopen-declaration-dev-check.md`）に従い、integrator が依頼して Opus の担当（read-only の制約のもと、repo の file を作らず変えない）が実行した。**dev の確認で、台帳・受領書は作らず、CP-4 の結果に数えない。** 封印の規則（案 A′）、限界の開示、v3 は変えない。

## 問い

K24-G01-N2／N3／N4 の「`g01-mira`（dev fixture では `cp4-dev-jars`）が出ない」が、本文の変更による宣言の失効によるのか、開き直しだけで宣言が消える製品の欠陥によるのかを、今の手順は区別できない（v3 の `limits` (v)）。本文を変えずに開き直しだけを行い、宣言が残るかを見る。

## 方法

- `scripts/quality/nir1-graph-eval/g01-negative-preview.mjs`（dev の予告）の写し `reopen-only-check.mjs`（SHA-256 `79cda7f8e61d8829e9d861dd26d581b901c956ee6caa2425cdbca4be47fd0d8e`）で、**mutation の段だけを外した**。宣言 → 対照（reached を確かめる）→ mutation をせずに N2 と同じ開き直し（`reopenUntilSealed`、`allowUnchanged: true`、`readFreshness` を注入）→ 同じ sample の query を 3 回（聞き直しの規則も同じ）。相対 import は worktree の絶対 path に直した。repo の file は作らず変えていない（実行の前後で `git status --short` が空）。
- 環境：dev-lantern fixture（dev setup `s45-preview-setup`）、real Electron を `scripts/local-ci-xvfb.mjs` で隔離（Wayland・D-Bus・プロキシの変数を外し、`ELECTRON_OZONE_PLATFORM_HINT=x11`、`TMPDIR=/tmp/gr5`）。build は直前の dev の予告と同じ（native と worker は DR-CP4-S4-8 の「dev の予告の結果」の build。製品は master `a1cd6675`、harness は枝の `f31d99e0` の bytes）。
- 実行：`reopen-only-1`、`reopen-only-2`（2026-11-03 12:28〜12:29 JST ごろ。`declaredAt` による）。手順は `run.sh`（SHA-256 `dd78bf56ba5ea04545831ec66ecf644d172aec900c9de55662248b544bac7568`）。結果の要約は `reopen-only-1.summary.json`（`04a93048…`）、`reopen-only-2.summary.json`（`247bcb72…`）。Electron の生の出力（`.artifacts/cp4/reopen-only-*/`、約 27 KB の JSON）は追跡していない。

## 結果

| 項目 | run 1 | run 2 |
|---|---|---|
| 対照（宣言の後、開き直しの前） | reached | reached |
| 宣言の状態（宣言の後／開き直しの前／後／query の後） | すべて `declared`、`effective: true`、`expiredBy: []` | 同じ |
| 宣言の DB の行（開き直しの前と後） | 同一（`declarationId`、`bodyDeclarationToken`、`version` 3、本文の `version` 0、`canonicalDigest` が一致） | 同じ |
| 封印 | `unchanged`（B gen 1、dirty false。Chronicle gen 3、dirty false、使える）。再判定も `unchanged`。静止 settled | 同じ（待ち 23 ms） |
| sample（3 回） | 3/3 `frameReached`、graph-ready、`cp4-dev-jars` が返る | 3/3 同じ |
| SP-P1、Graph の入力の digest が対照と同じ | match、true | match、true |
| N2 として判定した場合 | `not-established`（`g01-mira` が返ったので）。期待どおり | 同じ |
| `problems` | 空 | 空 |

直前の dev の予告（`s45-preview-n2`、同じ fixture と build）との並べ方（mutation の後に開き直した Main で読んだ宣言の状態）：

| 操作 | 宣言の状態 |
|---|---|
| なし（開き直しだけ） | `declared`、`effective: true`、`expiredBy: []`（この確認） |
| N2：同じ本文の再保存（本文の版 0→1、sha256 は同じ） | `declared`、`effective: false`、`expiredBy: ["content"]` |
| N3・N4：restore | `none`（restore が宣言を消す。K2/4 の期待どおり） |

## 読み

- 開き直しだけでは宣言は消えなかった（宣言の行も、有効の状態も、query の結果も変わらない）。N2 で `g01-mira` が返らなかったのは、開き直しではなく本文の再保存による失効（`expiredBy: ["content"]`）と整合し、N3・N4 の宣言が `none` になったのは restore による。**dev fixture での参考の確認**で、「開き直しで宣言が失われる製品の欠陥」の仮説（v3 `limits` (v)）を支持する観測は得られなかった。
- 限界：dev fixture 1 つ、2 run×3 sample。凍結した G-case の材料ではない。N3・N4 の restore の経路だけを、開き直しなしで分けた確認はしていない（開き直しの機構は共通）。N2 の失効が再保存の時点か開き直しの時点かは分けていない（宣言の状態は mutation と開き直しの後に読んでいる）。製品の実装を読んだ確認ではなく、観測。CP-4 の判定には使わない。v3 の `limits` (v) の限界は、凍結済みの文面のまま残る（この確認はそれを取り消さない）。
