# ユーザーの回答の記録：GDV/1（`graph-limited-binding` の改訂）の最終確認（2026-11-17）

- 経路：Claude Code の AskUserQuestion（1 問）
- 対象：`nir1-graph-dirty-binding-verify-proposal/1#graph-limited-binding`（GDV/1）、**改訂 6**
  - 材料（contracts の外）：`/home/grimodex/fusion-eval-data/pubg-a/05-iii-contract-draft.md`
  - **SHA-256 `b1fa766b2cd37a24777f953b1b823f5541223f7f8bac2208939201d0c4ff660a`**（写しは同じフォルダの `.r6.md`、同じ値）
- 位置づけ：契約の最終確認。前の選択の段は `b8a9ea86`（`user-confirmation-2026-11-17-gdv-choice-and-perf-retry.md`）。

## 経緯（要約。詳細は草案の §1.3 と §15〜§18）

- 改訂 2 → Opus 独立レビュー 2（必須 3）→ 改訂 3 → dev 試作（`claude/gdv1-dev` `2a01e0cc`、push なし）→ 改訂 4 → Opus 独立レビュー 3（必須 2）→ 改訂 5（GDV-R9 を狭める (x)）→ 試作 r5（同じ枝 `ec550a58`、push なし）→ Opus 独立レビュー 4（必須 0）→ 改訂 6。
- 統合者は、改訂 6 の §11 の数字を試作 r5 の記録（`05-gdv1-dev-results-r5.md`）と照合してから伺った。

## 質問の要旨

- 作り直し待ちの Graph を「再構築できるが使えない」として依存検証・再構築の検査の対象から外し、保守を止めない。Graph は消さず、作り直されるまで使わない。
- 緩和 9 つ（GDV-R1〜R9）。主なもの：期限なしで検査しない、容量の超過が Finding として残らない、依存検証の再利用と Finding の解消が通る。
- 作り直し待ちの間も閉じたままにするもの：手動の Repair の確定、C2Z の readiness、その先の不可逆な C2-ZC の cutover（(x)。試作で、閉じた形でも保守が Idle に達することを確認）。
- 足す名前：`NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE`、`verify-graph-recognized-unavailable`。
- 開示：改訂の前に容量で failed になった project は同じ epoch の間は自動で戻らない（評価・開発の DB だけの見込み）。案 C は評価の起動で publish を 1 回余分に起こした（統合者は範囲を狭める案を推す）。実装の時期の条件（#923 の merge `cc8c69b9` の後）は満たされている。9 回目の正式 run は GDV/1 なしで測る。製品の公開・PUB-G の承認ではない。
- 選択肢：承認（K-2 は (b)）／承認（K-2 は (a)）／承認しない。

## 回答

**「承認（K-2 は (b)）(Recommended)」**

- 改訂 6 をこの bytes のとおり承認する。
- K-2 は (b)：`VERIFY_CONTRACT_VERSION` などの契約の座標は上げない。他の project の結果を byte で同じに保つことを、実装の拘束にする。
- この確認は、PUB-G・Graph の公開・新しい authority・保存先・送信先を許可しない。policy の file を変えない。

## 次の段取り（草案 §1.3 の 4〜5）

1. 台帳の PR：草案を byte 同一で `nir1-graph-dirty-binding-verify-proposal-1-draft.md` として取り込み、`sha256sum` の一致を確かめる。台帳の補足・行 `GDV/1-1`・一覧表・節を §1.2 のとおり足す。
2. 実装の PR：§8 の受入れで、試作が実施しなかった項目（§10.3）を確かめる。§3・§5 の文と食い違えば止め、新しい版で改めて伺う。案 C の形（C-1〜C-3）は DR で決める。
