# PUB-G 前提 #16「lease 越しの end-to-end」実施手順と合格基準の設計起案（草稿）

2026-11-07。起案のみ。コード・policy・Gold・閾値は変えない。実行もしていない。
`W`＝`claude-pubg-declaration-ui`（master `2cb73eec` を含む、読取専用）、`Q`＝`W/scripts/quality/nir1-graph-eval`。
「文書に無い」は文書に無いこと、「推測」は未確認の見立て。

## 1. 目的と「通す」の定義

出典：`W/docs/plans/nir1-lane-decisions/cp3a-decisions.md:69`（DR-CP3A-55）、`:72`（DR-CP3A-58）、`cp3b-decisions.md:164`。
DR-CP3A-55 は「PUB-G／CP-4 の実機（Chronicle の index と宣言済みの Scene をそろえた実 Native）で最初に通すこと」を PUB-G の前提とし、「通すまで PUB-G を開けない」とする。Native を mock する CP-3b の renderer 試験は代わりにならない。

確かめる経路（逐語から）：
1. Eligible の行を `graph_continue` で受け取る（lease 越し）。
2. その handle で `nir1_evidence_qualify` を呼ぶ。
3. click が `keep_click` まで届く。
4. `await_request` の Ready 以降の接着 5 点：`current_operation`、gate、`assemble`、返却の直前の再確認、`keep_click`。
5. seed つき begin が、gate の閉じた実 Native で `not-activated` になる（DR-CP3A-58。node の試験では fixture を作れず未確認）。

「通す」＝実 Native と実 renderer の上で、1〜5 が各 1 回以上、実際に実行されたことを記録で示す。品質（precision 等）の測定ではない。

## 2. 案の比較

既存の事実：`dprime-check.mjs` の `heldSample`（`Q/renderer/cp4-harness.ts:684`）は begin → continue → Graph-only なら qualify → `unused` settle → `graph-ready` → 再 begin（cached）→ `used` の settle まで回す。ただし dev fixture 専用で、凍結素材を拒む（`Q/admission.mjs:706`）。過去の実行は「Graph-only なし」「click の経路は通っていない」（`cp4-decisions.md:439`・`:448`）。G-01 の受領書には Graph-only の行があるが continue は cancelled（contracts の `gold-s5r6-1/G-01_v1.receipt.json:1262`・`:1357`）。

| 観点 | (A) dev fixture に Graph-only 行を足す | (B) G-01 の凍結素材で新 script | (C) (A) を先に通し、G-01 相当は CP-4 の次の正式 run へ |
|---|---|---|---|
| 実 Native | 満たす | 満たす | (A) と同じ |
| 宣言済みの Scene | 満たす（fixture で宣言） | 満たす（G-01 の宣言） | 同左 |
| Graph-only の行 | fixture 設計次第。`dev-harbor-graph-case.v1.json` が使えるかは未確認（推測：要確認） | G-01 の受領書にあるが、continue の経路が未整備 | (A) の結果に依る |
| click／lease 越し | 満たす見込み（heldSample が既に持つ） | 満たす | 満たす |
| 凍結への影響 | なし（`dev-fixtures/` は凍結外。S2／S4 に触れない） | admission の拒否を外す＝S2 追補・S4 再凍結・再測定が要りうる。新しい契約にあたりうる | (A) と同じ。正式 run の追加分は別の確認 |
| 「G-01」 | 満たさない | 満たす | 後続で満たす |
| 見積り（推測） | 小〜中（fixture 1 件＋build＋run 数回。所要の時間は文書に無い） | 大（凍結の再確認と再測定を含みうる） | 小＋後続は正式 run に依る |

その他：(D) 実 Native の node 試験に Chronicle の index を作る fixture を足す案は、DR-CP3A-58 が「lane の範囲を超える」として退けており、renderer を通さないので DR-CP3A-55 を満たさない。採らない。

推奨（起案者の見立て）：(C)。DR-CP3A-55 の文言（実 Native・宣言済みの Scene・click）は (A) で満たせ、凍結に触れない。G-01 で回す必要が出た場合だけ (B) 相当を別 lane で確認する。`cp4-quality-rest-and-pubg-unknowns-2026-11-03.md:41` の提案（G-01 fixture）は (B) に近く、凍結の扱いが書かれていない。

## 3. 合格基準の案（到達の有無で判定。閾値は使わない）

status と reason の合格基準は文書に無いので、**ユーザーが決める**。提案：
- begin：ticket が出る。`graph.status` が `pending`。
- continue：`available` かつ `graphOnly` が非 null（Graph-only の行が実在する）。
- click：`nir1_evidence_qualify` の status が `available` 系で、Native 側の記録で `keep_click` に到達（`out.click.status` と reason を記録）。reason が `unavailable` なら失敗。
- settle `unused` → `graph-ready` 1 件以上 → 再 begin が Native の `cached` → continue `available` → settle `used`。終わりの slot が empty。
- seed つき begin の `not-activated`：gate を閉じた既定の `.node` で別 run を 1 回行い、Graph の行が出ず `not-activated` を返す。
- 失敗の分類：(i) Graph-only 行が出ない（fixture 側の欠陥。再設計）、(ii) continue が cancelled／unavailable（Native の lease・gate・assemble の疑い。DR-CP3A-55 の接着の失敗として記録）、(iii) click が unavailable（`keep_click` の失敗。PUB-G を開けない）、(iv) 環境の失敗（ONNX・Xvfb・build。再実行可。成功扱いにしない）。
- 時間（待ち時間）は合否に使わない。可用性は CP-4 の別の論点（DR-CP3A-53）。

## 4. 実施手順（案）

- 環境：`scripts/local-ci-xvfb.mjs` の下、Wayland／D-Bus の変数を除く（`Q/launcher.mjs:8-9・49-52`）。ONNX は ja／en の固定版で sha を manifest と照合（`Q/launcher.mjs:283-303`）。Linux 専用。
- build：clean な worktree で評価 build（`Q/eval-native-build.mjs`、heavy.sh 経由）。renderer は stub（`Q/renderer/nir1GraphAvailability.eval.ts`、値 true）。**製品 build の定数 true は使わない**（確認の要否は文書に無い。問 2 に含める）。
- command：`dprime-check.mjs` の `--phases held` 相当（`--n 1`〜少数）。fixture 追加後に admission の purpose は既存の `dprime-check` を使い、新しい purpose は足さない（推測：足すと admission の変更になる）。
- 別 run：既定 `.node` で seed つき begin の `not-activated` を確認（評価 feature の flag なし）。
- 記録：contracts の `docs/plans/nir1-pubg-records/` に新規 file として、各段の status／reason／回数、build sha（`.node`・worker）、候補 commit、base、ONNX sha、環境を記す。DR-CP3A-55 への追記は別の指示で行う。
- 入れないもの：Scene の本文、query 文字列、dense hit の本文、key。数値・status・sha・id のみ。
- 正式な CP-4 の run には数えない（`cp4-quality-rest-and-pubg-unknowns-2026-11-03.md:41` と同じ扱い）。

## 5. GDX-PRECHECK-001

- 実機の Electron、Native（N-API）、background の worker、Xvfb を起動する。長期・高リスクにあたるので、実行前に `[precheck]` で止まる。
- 送信先：なし。AI は使わない。ONNX はローカルの固定版。外部への接続は追加しない。
- 保存範囲：実行の作業物は repo 外の `.artifacts/` と scratch に置く。contracts には数値のみ。拡大なし。
- 閾値・Gold・policy・契約は変えない。(B) を採る場合は新しい契約・凍結の変更にあたり、別の確認が要る。
- 資源：Full 前の resource-isolation のような隔離は文書に無い。heavy.sh の運用に従う（要確認）。

## 6. ユーザーに決めてもらう問い

1. 案の選択：(A)／(C)／(B)。推奨は (C)。
2. 合格基準：3 の形（到達の有無）でよいか。status の許容値、`not-activated` を別 run にするか、定数 true の製品 build での確認を要するか。
3. G-01 相当：(C) の後続を CP-4 の次の正式 run に組み込むか、PUB-G の前提とは切り離して扱うか。
4. 3 OS：#16 を Linux の評価 build だけで通すか。3 OS の扱いは文書に無い（G-pub の packaged smoke は別）。
