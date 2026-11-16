# S3 の 10 回目の 5 回目の確認（`068cf3a6..dee4d00e`。2026-11-16）

**この file の出所**：S3 の独立 reviewer（Claude の agent、Opus 5.5、read-only）の報告である。ユーザーの確認ではない。

## 行ったこと

- repo と fusion-eval-data の file は、この 1 file のほかは変えていない。commit、build、run の起動もしていない。
- 一時 file は scratchpad（`/tmp/claude-1000/.../scratchpad/r5/`）にだけ作った。中身は次の 2 種類である。
  - 各 commit の S2・宣言・DR・validator・試験の写し
  - JSON と文を単位に差分を取る小さな script
- validator は読むだけで実行した（Node 22。前例どおり）。結果は `passed`、errors 0、`formalReady` false、placeholder 23 で、前回と同じだった。
- 試験の file は回していない（前例どおり）。
- **read-only の条件からの逸脱が 2 つある**（どちらも作業木と枝の ref は動かしていない）。
  1. contracts の worktree で `git fetch -q origin` を 1 回実行した。共有の `.git` の remote-tracking ref を動かしうる操作である。
     - reflog では、`origin/master` は動いていない。値は `f4fe9f25` のままである。
     - `origin/claude/nir1-contracts` は `1d372660` だった。
  2. merge を再計算するため、`git merge-tree --write-tree` を 2 回実行した。参照されない tree object が `.git` に書かれる。

## 対象

- 枝 `claude/s4-9-pr3` の `068cf3a6..dee4d00e` の 6 commit：`f5dd39ea`、`61b44652`、`d73e2986`、`92ca2e24`、`4a694cd9`、`dee4d00e`。
- 確認の途中で、別の担当が `6430b75b`（21:56:56 +0900）を枝に積んだ。
  - 内容は、宣言の `revisions[37]` の扱い、DR の追記 6、試験である。
  - 範囲の外なので見ていない。行番号はすべて `dee4d00e` の bytes で示す（S2 は `6430b75b` で変わっていない）。
- 宣言の `revisions[37]` は、依頼のとおり見ていない。

## 盲検

- 依頼文には、builder の結論が入っていなかった。
- 確認する対象（S2、宣言、DR）には結論が書かれている。読んだ順は、git の事実とコード → 記述である。

## 判定：**ok-with-notes**（必須 0、推奨 6）

**推奨 1・2（誤った数字）は ⑤〜⑦ を止めないが、⑧（S4b）の前に必ず直す。** 「開示で代える」の選択肢は無い。

- 4 回目の推奨 7 件は、5 件が閉じた。不完全が 2 件（推奨 3 は ⑥ への持ち越しで開示あり、推奨 7 は 1 か所の取り残し）。
- ② の取り込みには、Graph の経路、maintenance、seed・pin の読み戻し、R5 の閉包に効く製品の変更は見つからなかった。
- 両方の merge は、`git merge-tree` で再計算した tree と一致した。merge のときに中身を足した痕跡（evil merge）は無い。
- ③ が入れたのは docs だけで、束縛された記録はすべて真の祖先にあり、bytes も一致した。
- **④ の開示には、事実と合わない数字が 2 つある**（推奨 1・2）。
  - 「docs を除く 82 file」：実際は 92 file。
  - 「pin の 84 path」：実際は 73 path。
  - どちらも結論（測定に効かない、重なりが無い）は変えない。しかし凍結される S2 にあり、試験の語にも束縛されている。だから S4b（⑧）の前に直す。
- 黙った緩和は見つからなかった。

---

## 問 1：4 回目の指摘は閉じたか

| 指摘 | 結果 | 根拠 |
|---|---|---|
| 推奨 1 (n) の古い 1 文 | **閉じた** | S2 `:468`。「下のイの qzo1 で 1 件見た…推測ではなくなった」に置き換わった（`f5dd39ea`） |
| 推奨 2 `maintenanceStillAt` に quiesce | **閉じた** | 次の 3 か所に `"quiesce"` が入った。変異（`pop()`）の検出は `opt :6392` にある。`opt` は `observation-prep.test.mjs` の略 |
| | | ・S2 `:2533` |
| | | ・validator `observation-prep.mjs:1534-1538`（コメントつき） |
| | | ・試験 `opt :6411-6415` |
| 推奨 3 定数の束縛 | **不完全**（⑥ への持ち越し、開示あり） | 次の 4 点が入った |
| | | ・S2 `:2545` と validator `:1551` の `plannedRetryGraceConstant: "RETRY_DISPATCH_GRACE_MS"` |
| | | ・`frozen-setup-complete.test.mjs` の 5000 の固定 |
| | | ・S2 の `plannedRetryGraceMs`、`reopen.quiesce.reopens`・`waitMs` を、harness の定数（作業木の `workspace-db.mjs`・`frozen-setup-driver.mjs` を import）と照らす試験（`opt :6417-6430`） |
| | | ・名前を変える・消す変異の試験 |
| | | 残り：`HARNESS_CONSTANTS`（pin の bytes から読む）への移行は ⑥ へ持ち越した。持ち越しは DR 追記 4（`cp4-decisions.md:1688` の決定 (3)）、追記 5 の ⑥ の項、宣言 `[41]` に書いてある |
| | | S2 `:2315` の `harnessConstants` は「validator は pin の bytes から読まず、この値を literal で持つ」に直っていて、今は事実と合う |
| | | validator のコメント（`observation-prep.mjs:1452-1456` の「pinned bytes … do not carry them」）は、⑥ の後に事実でなくなる。⑥ で一緒に直す |
| 推奨 4 dev の記録の 2 点 | **閉じた** | 次の 4 か所が揃った |
| | | ・`setup-quiesce-dev.md:25`（run の時点の head、11c12fb9 の commit 時刻）、`:33`（受領書の SIGTERM の表示と、実際の SIGKILL） |
| | | ・S2 (n)（`:468` のイ） |
| | | ・DR-DBC-7（`db-connection-decisions.md:1048` 付近。「証明できない」の限定つき） |
| 推奨 5 観測の後に選んだ読みの一覧 | **閉じた** | 宣言の `setup-quiesce-after-dev`（`:768`）、`READINGS_AFTER_DEV`（`observation-prep.mjs:2257`）、試験の語（`opt :8930-8938`） |
| | | `dee4d00e` で `chosenBy` を直した：B・A・C の組み合わせは設計文書の推奨、値は builder が置いた |
| | | 照合：回答の記録 `337ff239` は、問 1 で B/A/C を質問に入れ、「今回の S4 に入れる (Recommended)」と答えている。`setup-quiesce-design.md:74-92` に、開き直しの回数・待ち・猶予の値は無い（`:76` の「2 回連続」は読みの一致の回数）。直した記述は事実と合う |
| 推奨 6 段取りの記述 | **閉じた**（新しく古くなる点あり。推奨 4） | `k67Readings.status`（`:466`）と `s4StagesRule`（`:1087`）に、#21・#22 と 3・4 回目の確認が入った |
| 推奨 7 書き方の細部 | **不完全**（1 か所） | 閉じたもの：「通らない」→「対象外」（`cp4-decisions.md:1067` の T-5 の追記と追記 3 の表、DR-DBC-7）。S2 の `readBack.maintenance` の acceptance（`:2419`）・`rule`・(n)(3) に「frozen の受領書」。(n) の小見出しのア・イ・ウ。`revisions[39]` を `67cf9453` の bytes に戻した（下の確かめたこと） |
| | | 取り残し：`s4StagesRule`（`:1087`）に「測定の入口も弾く（k67Readings.limits (n)）」が「frozen」なしで残る。(n) を指しているので害は小さい（推奨 5） |

**4 回目の細かい点（note 5・6）**

- note 5（宣言の過去の行）：`revisions[39]` は元に戻した。`[37]` の扱いは範囲外である。
  - 方針は「`revisions` の過去の行は書き換えない」に揃った。
  - ただし `readingsChosenAfterDevObservation[21]` は #21（`2d70fa10`）で書き換えたままである。`068cf3a6..dee4d00e` では変わっていない。この一覧に方針が及ぶかは、どこにも書いていない（note）。
- note 6（(n) の小見出し）：閉じた。

## 問 2：② の master の取り込み

### 2-1 製品の変更は CP-4 に効くか

**効くものは見つからなかった。** 製品は候補そのものなので、harness と製品の結合が保たれるかで見た。

| 経路 | 確かめたこと |
|---|---|
| Graph（Native・DB） | 変わったのは `electron/native/grimodex-node/src/related_scenes/graph_tests.rs` だけである |
| | ・この file は `graph.rs:855-857` の `#[cfg(test)] mod tests` で、試験の 1 関数を足しただけ |
| | ・`src-tauri/crates/grimodex-db`、`electron/main`、`electron/preload`、`src/lib`、`src/features/related-scenes` の試験でない file は、どれも `git diff 3948eeb2 f4fe9f25` が空 |
| maintenance の起動時の復旧 | `narrative_extraction` は不変なので、開き直しの経路を dev で取り直さない判断は、4 回目の確認の条件に照らして正しい |
| seed・pin の読み戻し | `workspace-db.mjs` と DB の schema（grimodex-db）は不変 |
| R5 の閉包 | 44 file の一覧そのものは見つけられなかった（未確認）。次の 3 つで代わりに確かめた |
| | ・harness の dir（`nir1-graph-eval`、`nir1-graph`、`nir1-packing`、`nir1-retrieval`）は不変 |
| | ・② で変わった scripts（`impact-map.mjs`、`eval-fixtures.mjs`）を import するのは `local-ci*`、`product-journey-catalog.mjs`、試験だけ。harness の試験でない file からは届かない。`native-architecture.mjs:95-96` は allowlist の path の文字列で名指すだけ。harness が import する共有の `local-ci-process-supervisor.mjs` は node の組込みしか import しない |
| | ・pin の 73 path と除外の 5 path と、② で変わった 97 file に重なりは無い |
| trace の打鍵（`trace-runner.mjs:434`・`:444` の `Control+End`、type、`Backspace`） | #912 の `GlobalCommandHost.tsx` の keydown の diff を全部読んだ |
| | ・照合の順と条件は同じ。動作を registry の `runAppCommand` に移しただけ |
| | ・固定キーの定義（`appCommandRegistry.ts:98-99`・`:115-116`）は、以前と同じ mod＋shift＋e／f である |
| | ・binding の表（`settings/keybindings.ts`）と `lib/platform.ts` は、② の 97 file に入っていない（照合するキーは不変）。表の中身は読んでいない |
| | ・tab 切替（`tabSwitchKeybinding.ts`）も、照合を残して動作を registry に移しただけ |
| IPC | `ipcContract.ts` の hunk は 3 つで、`grep '^@@'` で全部見た：import、`assertAgentSettingChangesValid`、`save_global_settings` の run |
| | ・新しい検査は、`userPreferences` に目録の 15 キー（editor・display だけ）が含まれ、しかも変わったときだけ動く |
| | ・harness は `global-settings.json` を直接書き、中身は `data.autoBackup` だけ（`launcher.mjs:324-334`）。この検査には当たらない |
| | ・Graph・nir1 の command の hunk は無い |
| settings の起動 | `migration.ts`：目録のキーのうち検査に通らない値を落とすだけ |
| | `settingsStore.ts`：`set` の永続化を `schedulePersist` に括り出し、`unset` を足した。`set` の挙動は同じ |
| | `restoreTransientUiState.ts`：新しい file で、undo 用。起動の経路ではない |
| renderer の測定の橋 | `window.cp4Harness` は harness の側にあり、`src` には無い（grep した） |

- **builder の〔推測〕「settings の store・ipcContract の変更が起動や測定の process の経路に触れないかは確かめていない」**：上の範囲までは、この確認で閉じた。
- 82 file のうち、この確認が diff を読んだのは次のものだけである。残りは名前と規模（`--stat`）しか見ていない。
  - `graph_tests.rs`
  - `fetchRelatedScenes.nir1.test.ts`
  - `grimodex-ai/src/lib.rs`
  - `ipcContract.ts`
  - `migration.ts`、`runtimeSettings.ts`、`settingsStore.ts`
  - `restoreTransientUiState.ts`
  - `GlobalCommandHost.tsx`、`tabSwitchKeybinding.ts`（keydown の部分）
  - `agentSettingCatalog.ts` のキーの一覧
  - docs 以外の非製品 file の一部：`impact-map.mjs`、`eval-fixtures.mjs`、`evals/impact-map.yaml`、`evals/quality-manifest.yaml`

### 2-2 開示は事実と合っているか

正しいもの：

- 7 commit（#912〜#918）
- src 77、electron 4、src-tauri 1
- #916 は docs だけ（3 file）
- #917 は試験だけ
- grimodex-ai の tool 名の試験の 3 行
- 衝突なし
- `f4fe9f25`・`d73e2986` の 40 桁
- `harness`・判定 3 file・`evals/nir1-graph`・`evals/nir1-g01`・`narrative_extraction`・`electron/main` が不変
- 判定 3 file の最後の commit は `1dd6fb35`
- pin 対象の 3 file は `068cf3a6` と同じ bytes

合わないもの：

1. **「src 77・electron 4・src-tauri 1 の計 82 file（docs を除く）」**
   - 該当箇所：S2 (l)(5)（`:468`）、宣言 `[42]`、DR 追記 5（`cp4-decisions.md:1714`）、`K67_LIMIT_WORDS` の `"82 file"`（`observation-prep.mjs:4785`）、試験の語（`opt :9104`）
   - docs 以外は 92 file である。82 には次の 10 file が入っていない。
     - `agent-tool-manifest.json`
     - `evals/fixtures/{grounding-artifact,routing,tool-safety}.yaml`
     - `evals/impact-map.yaml`、`evals/quality-manifest.yaml`
     - `policies/architecture/large-module-debt.json`
     - `scripts/quality/{eval-fixtures,eval-fixtures.test,impact-map}.mjs`
   - 出所は #913〜#915 である（`git show --name-only` で確かめた）。
   - `dee4d00e` の追記は scripts の 2 つに触れたが、数は直していない。
   - 10 file は品質ゲートの資産で、CP-4 の測定には効かない。
     - `eval-fixtures.mjs` は light の corpus の上限を 32→35 にした。AI ヘルプの case のためで、CP-4 の閾値ではない。
     - `eval-fixtures.mjs:8` は validator（`validateNir1ObservationPrep`）を呼ぶ側である。harness からは呼ばない。
2. **「S2 の setupReadings.source の pin の 84 path」**
   - 該当箇所：S2 (l)(5)（`:468`）、宣言 `[43]` の (3)、試験の語 `"84 path"`（`opt :9124`）
   - `setupReadings.source.pins` の file は 73 path（重複なし）である。validator の `SOURCE_PINS` も 45 pin・73 path である（import して数えた）。
   - 84 は、pin 73 ＋ `closureExclusions` 5 ＋ `boundFiles` 6 の合計と一致する。〔推測〕builder はこの 3 つを合わせて数え、「pin の」と書いた。
   - 重なりが無い結論は、どの数え方でも成り立つ。84 の全部と 97 file の交差は空である。
3. **両側が変えた file の開示が無い**（note）
   - 該当する file：`graph_tests.rs`、`evals/quality-manifest.yaml`、`docs/plans/nir1-continuation-2026-10.md`
   - この 3 file は枝と master の両方が変えた。`d73e2986` の blob は master の blob と違い、3-way の内容 merge になっている。
   - `git merge-tree --write-tree 61b44652 f4fe9f25` の結果は、`d73e2986^{tree}` と同じ `4bfccc62` だった。だから「衝突なし」は正しく、merge で中身は足されていない。
   - 開示の「#917 は試験だけ」は master 側の説明として正しい。ただ、枝もこの file を変えていることは書かれていない。

## 問 3：③ の contracts の取り込み

- **真の祖先**：次の commit は、すべて `git merge-base --is-ancestor <c> dee4d00e` が 0 を返した。
  - 指示の 11 個：`b9559a22`、`ba1e1a05`、`160f5fa5`、`fd1f69ce`、`f7ea87a6`、`7a03eaf9`、`235e0c67`、`7361041f`、`4aa34626`、`337ff239`、`1d372660`
  - 追加で確かめた 6 個：`3f977b32`、`d4ad9dc9`、`5bbd6ebb`、`f628efb2`、`3a6a2ae7`、`4ada831e`
- **束縛された記録の bytes**：validator を import して、各 commit の bytes の SHA-256 を計算し、`HEAD` の祖先であることを確かめた。全部一致した。
  - 対象は `K67_CONFIRMATION_RECORDS`（`graphEvalProcedure`、`freezeRecord`、`additional` の 7 件）、`K67_S3_REVIEW`（`4aa34626`）、`K67_QUALITY_VERDICT_V3` の v3 と回答の記録。
  - `freezeRecord` だけは、`HEAD` の bytes が凍結の commit の bytes と違う。`235e0c67` が (α) を追記したためで、`observation-prep.mjs:230-232` のコメントどおり、束縛は凍結の commit の bytes にかかる。
  - v3 は `b6166ed2…`、K6/7 の draft は `7b8f81c7…` で一致した。
- **contracts の変更が揃っているか**：merge base は `259ec9bf`。そこから `1d372660` までに contracts が変えた 264 file は、すべて `dee4d00e` で同じ blob だった。
- **docs だけか**：はい。`git diff d73e2986 92ca2e24` の内訳は次の 263 file だけで、docs 以外は 0 である。
  - `docs/plans/nir1-cp4-records`：262 file
  - `docs/plans/nir1-pubg-records`：1 file
  - contracts が変えた `nir1-final-request-eval-proposal-7-draft.md` は、② の #916 で同じ bytes が先に入っている。
- `git merge-tree --write-tree d73e2986 1d372660` の結果は、`92ca2e24^{tree}` と同じ `a6defb54` だった。
- **祖先にならない記録**（推奨 6）：S3 の 10 回目の 2〜5 回目の確認の記録は、fusion-eval-data にあって contracts に無い。
  - draft の S2 の `review` は null で、placeholder 23 件に S3 の再確認の記録を求める欄は無い（S2 を読んで確かめた）。正式の門が束縛する S3 の記録は `K67_S3_REVIEW`（`4aa34626`）だけである。だから ⑧ はこれでは止まらない。
  - ただし、凍結される S2 の `status`・`s4StagesRule`・宣言は、hash の無い repo の外の file（`s3-review-10-recheck*.md`）を名指している。

## 問 4：凍結される S2・validator・DR に残る食い違い

- 事実と合わない記述：問 2-2 の 1・2（推奨 1・2）。
- 食い違う記述：
  - 宣言 `[41]` の「frozen-setup-complete.test.mjs が … S2 の値とも照らす」は誤りである。
    - `[43]` の (1) が訂正し、DR 追記 4（`:1688` 以降の表）は正しく書いている。
    - never edit の方針どおり、`[41]` は誤りのまま残り、新しい行が訂正する形である。食い違いではあるが、方針に沿っていて、開示もある。
  - DR 追記 4 の「作者の宣言に 6 行目（… revisions の 41 番）」と、追記 5 の「新しい 43 番目の行」は、番号の数え方（0 始まりの添字か序数か）が混ざっている（note）。
- **この確認の後に古くなる記述**（推奨 4）：次の箇所は、5 回目の確認が済んだ時点で事実でなくなる。
  - S2 の `status`・`s4StagesRule`（`:1087`）・(l)(5) の「S3 は S2 追補 #22 の後の bytes／取り込んだ bytes を見ていない」
  - 「#22 の後の S3 の確認の要否は統合者が決める」
- 黙った緩和：無い。
  - この範囲の validator の変更は、次の 3 つで、どれも束縛を足す向きである。
    - `maintenanceStillAt` への追加
    - `plannedRetryGraceConstant`
    - `READINGS_AFTER_DEV` と `K67_LIMIT_WORDS` の追加
  - 試験は語と行の数を足し、`revisions[39]` の復元を確かめる assert を足した。外した assert は無い。もとの「never edit」はコメントだけで、assert ではなかった。
  - ② で入った `eval-fixtures.mjs` の 32→35 は、CP-4 と無関係な master の変更である。

## 問 5：⑤〜⑧ に進んでよいか

**進んでよい。** 必須は 0 で、推奨のどれも判定 3 file と pin 対象の harness の bytes を変えない。

ただし、次の 3 点を守る。

1. 推奨 1・2 は誤った数字なので、⑧（S4b）の前の S2 追補で必ず直す。推奨 4・5 は、直すか、直さないなら限界に開示してから凍結する。どれも ⑥ の追補と一緒に入れてよい。
2. ⑥ で pin を取り直すときに、推奨 3 の持ち越しを閉じる。
   - `MAINTENANCE_QUIESCE_*`・`RETRY_DISPATCH_GRACE_MS` を `HARNESS_CONSTANTS` に移す。
   - S2 `:2315` と validator `:1452-1456` のコメントを直す。
   - その追補の bytes は、この確認が見ていない。
3. ⑦ で R5 の閉包を再計算するときは、② の 97 file との交差を記録に残す。この確認は、閉包の一覧そのものを見ていない。

---

## 必須

なし。

## 推奨

1. **「82 file（docs を除く）」を事実に合わせる**
   - 対象：S2 (l)(5)、DR 追記 5、`K67_LIMIT_WORDS` と試験の語。
   - 「docs を除く 92 file（製品 82：src 77・electron 4・src-tauri 1、品質ゲートの資産 10）」のように書き、10 file の名前か種別を足す。
   - 宣言 `[42]` は never edit の方針どおり、新しい行で訂正する。
2. **「pin の 84 path」を事実に合わせる**
   - 「pin 73・除外 5・boundFiles 6 の計 84 path」のように書く。
   - 対象：S2 (l)(5)、宣言は新しい行で、試験の語。
3. **両側が変えた 3 file を (l)(5) に一言足す**
   - `graph_tests.rs`、`quality-manifest.yaml`、続行計画。
   - 内容：「3-way で merge し、`merge-tree` の再計算と一致する」。
4. **この 5 回目の確認の後に古くなる記述を直す**
   - 対象：`status`、`s4StagesRule`、(l)(5) の「S3 は … を見ていない」。
   - 内容：5 回目の範囲（`068cf3a6..dee4d00e`）と判定、この確認が読んだ製品の file（問 2-1 の一覧）。
   - 見ていないものとして、`6430b75b` 以降、⑤〜⑧ の成果物を残す。
5. **`s4StagesRule`（`:1087`）の「測定の入口も弾く」に「frozen の受領書」を添える**
   - 4 回目の推奨 7 の取り残しである。
6. **S3 の 10 回目の 2〜5 回目の記録の扱いを決める**
   - 凍結される S2 が名指す repo の外の file について、次のどちらかにする。
     - contracts に入れて commit と sha256 で引く。
     - 「束縛しない（agent の報告。正式の門が束縛するのは 4aa34626 だけ）」と限界に書く。
   - あわせて、方針の対象を明記する。
     - 宣言の行の never edit の方針は、`readingsChosenAfterDevObservation` に及ぶのか。
     - 及ぶなら、#21 で書き換えた `[21]` をどう扱うのか。

## 確かめたこと

- **範囲**
  - 6 commit の親と変更 file。`dee4d00e` は `origin/claude/s4-9-pr3` と一致した（確認の開始時）。
  - その後、範囲外の `6430b75b` が積まれた。
- **S2 の差分**：`068cf3a6→f5dd39ea→4a694cd9→dee4d00e` の各段で、JSON の path ごと・文ごとの差分を全部見た。
- **宣言**
  - `revisions[0..39]` は、`[37]` を除いて `67cf9453` と完全に一致する。`[39]` の復元を含む。
  - `[40]` は `2d70fa10` と一致する。`[41]`〜`[43]` と `readingsChosenAfterDevObservation[23]` の全文を読んだ。
- **validator と試験**
  - validator（`observation-prep.mjs`）の差分の全体と、試験（`observation-prep.test.mjs`、`frozen-setup-complete.test.mjs`）の差分の全体を読んだ。
  - validator を実行した：`passed`、errors 0、placeholder 23。
- **DR**：`cp4-decisions.md` の追記 4・5、T-5 の追記、追記 3 の表、`db-connection-decisions.md` の DR-DBC-7 の差分を、文ごとに読んだ。
- **dev の記録**：`setup-quiesce-dev.md`（mtime 21:20）の訂正（`:25`・`:33`）。
- **値の決定者**：回答の記録 `337ff239` と `setup-quiesce-design.md:74-92`。`chosenBy` の訂正の照合に使った。
- **② の file**
  - 一覧と、top dir ごとの数。docs 5、src 77、electron 4、src-tauri 1、evals 5、scripts 3、policies 1、root 1 の計 97 file。
  - PR ごとの内訳。
- **② の経路**
  - Graph・maintenance・seed・pin・harness の path の不変。
  - 問 2-1 の表の file の diff。
- **merge の再計算**：`git merge-tree --write-tree` で、2 つの merge の tree を再計算して一致した。
- **pin と重なり**
  - S2 の pins（73）、`SOURCE_PINS`（45 pin・73 path）、`closureExclusions`（5）、`boundFiles`（6）。
  - それらと ② の file の交差は空だった。
- **③**：祖先の 17 件、束縛された記録の bytes と SHA-256、contracts の変更 264 file の blob の一致、③ の diff が docs だけであること。
- **不変のもの**
  - 判定 3 file の最後の commit は `1dd6fb35`（`implementationCommit` と一致）。
  - pin 対象の harness の 3 file の bytes は、`068cf3a6..dee4d00e` で変わっていない。
  - harness の dir で変わったのは `frozen-setup-complete.test.mjs`（＋4 行）だけ。
- **`origin/master`**：確認の時点で `f4fe9f25` で、② の後に master は進んでいない。

## 未確認

- 試験の件数は、作者の申告のままである。
  - 1023 件、pass 1015、fail 8 と、取り込みの前後で同じ名前であること
  - 「祖先でない」の 1 件が次の assert に移ったこと（assert の並びが申告と合うこと（`opt :3953` の後に pin の照合が続く）だけは、コードで見た）
  - nir1-packing の 291 中 290、architecture.test の 37/37
- R5 の閉包の 44 file の一覧そのもの。② との交差は、上の代わりの方法でしか見ていない。
- ② の 82 file のうち、問 2-1 に挙げなかった file の中身。renderer の負荷が測定の時間にどれだけ効くかも、測っていない。
- `6430b75b` 以降の commit、宣言の `revisions[37]`。
- ⑤〜⑧ の成果物：検出力の記録、取り直した pin、閉包の再計算、S4b。
- 4 回目の未確認の残り：凍結の G-03/frontier-exceeded での開き直し、2 回を使い切る経路、will-quit の障壁。
