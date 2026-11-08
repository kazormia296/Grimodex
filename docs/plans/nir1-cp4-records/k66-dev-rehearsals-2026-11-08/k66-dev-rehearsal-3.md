# K6/6（確認・凍結済み）の dev の予行 6（確認の後。**非判定**）

- **位置づけ**: K6/6 の threat model「dev の予行」の 4 の、確認の後・S4 の 7 回目の凍結の前の予行。実装した harness（枝 `claude/k66-harness`、head `7652a86e`、PR #840）で、`admitDevPreview` の範囲（`frozen-setup-driver.mjs --dev-fixture`、`frozen-k64-run.mjs --dev-fixture`）だけを使った。D = 40 ms、R1 の下、非凍結の dev fixture（予行 5 と同じ形、`dev-shape-g02/g03/g06/g08.v1.json`）。**これは「予告」で、/6 の判定・凍結・正式の receipt には使わない。** 判定・凍結・receipt は作っていない。
- 番号は `k66-dev-rehearsal-1.md`（予行 1〜3）・`-2.md`（予行 4・5）に続く**予行 6**。
- 実行した枝: `claude/k66-rehearsal-3`（新しい worktree `/home/grimodex/worktrees/Grimodex/claude-k66-rehearsal-3`。push しない）。`7652a86e`（harness の枝の head）に origin/master `ce1a6306`（#832・#835）を merge した `34d1cc5c`（merge commit だけ。harness のファイルは変えていない。評価 build が origin/master を祖先に要るため）。**harness の枝 `claude/k66-harness` のファイルは変えていない**（worktree は clean、head `7652a86e` のまま）。実行時の worktree は clean（`validation.json` の error は `candidate.productReceiptSha256 must be a sha256` のみ。dev の予行では製品の standard build の receipt を作らない。従来どおり）。
- 生の出力: `/home/grimodex/fusion-eval-data/cp4-k66-rehearsal-post-confirm/`（receipt・validation・setup の受領書・log・集計 `analysis-r6.json`・`analysis-r6.err`・`analyze.mjs`・G-01 の head）。run の実体（cold DB 等。G-08 は約 11 GB）は `claude-k66-rehearsal-3/.artifacts/cp4/k66-r6g0*`（ignore）。

## 結論

1. **FR-7 は取れた**: 窓内に合流した親 130 件の全件に `followUp.parent.contribution`（`material-revision`）が記録された（130／130）。
2. **止める条件（落ちた割合が 1/30 を超える）は満たさない**: 落ちた親 0／130（status `ok`）。有効の下限（窓内に合流した親が 30 件以上）は 130 件で満たした。fixture の直しも取り直しもしていない。
3. **品質の予告**（/6 の regime、品質判定 v2 の D2・D3 を入れた実装）: 9 variant のうち measurable 5・fallback-measured 3・**hold 1**・**FAIL 0**。G-08/chronicle-index-unusable は **FAIL でなく、D3 の対象として分類された**（eligible 30、graphShown 30、outOfD3 0）。ただし D3 の (b)(d) は 30 件とも `b-material-revision-record-missing` で hold（下の「気づいたこと」1）。
4. **G-01 の診断の head**: `readG01DiagnosticHead` は実リポジトリの git で動き、head に `observationPrep.commit`・`freezeRecordSha256`・`runStartedAtUtc`・k62/k64/k65/k66 の freezeCommit と sha256 が入った（下）。

## 予行の回数・待ち

| 回 | 内容 | 結果 |
| -- | ---- | ---- |
| 待ち | `until ! pgrep -f '[c]argo |[r]ustc|[v]itest'` の形（開始前 10:51:35Z と run の直前 11:00:58Z・11:01:56Z）。heavy process は無く、**待った時間は 0 秒**（2 回とも）。他の process は kill していない | - |
| 準備 | worktree 作成・merge・node_modules の複製（reflink）。評価 build 10:52:01Z〜10:57:18Z、electron build、napi build（〜11:00:33Z）。`CARGO_TARGET_DIR=/home/grimodex/cargo-targets/k66-proto`。Electron の binary は複製した既存のものを使い、取得はしていない | 成功 |
| 失敗（準備） | 最初の setup が renderer build で `@grimodex/scan-contract/web-editor-handoff` を解決できず停止（`packages/*/dist` が新 worktree に無かった）。harness の worktree から `dist` を複製して直した | 予行ではない（測定なし。ログは `failed-attempt-0/`） |
| **予行 6** | G-02（base）・G-03（base、frontier-exceeded）・G-06（base）・G-08（5 variant）。11:01:56Z〜11:44:23Z（G-02 約 2 分、G-03 約 7.5 分、G-06 約 3 分、G-08 約 30 分） | 測定は 4 run とも完了 |

測定が完了した予行は **この文書で 1 回（予行 6）**。setup と runner の launch は 4+4。

## 結果（予行 6。非判定）

D = 40 ms。1 variant の Graph arm の measured は 30 sample。窓内に合流した親 = `classifyJoin` が inWindow の親。

| run / variant | measured | 窓内に合流 | FR-7 記録 | first-render | 落ちた | follow-up | 欠落（窓外） | Raw |
| ------------- | -------: | ---------: | --------: | -----------: | -----: | --------: | -----------: | --: |
| G-02 base | 30 | 12 | 12 | 12 | 0 | 0 | 18 | 7 |
| G-03 base | 30 | 30 | 30 | 30 | 0 | 0 | 0 | 8 |
| G-03 frontier-exceeded | 30 | （unavailable。steady の集計なし） | - | - | - | - | - | 8 |
| G-06 base | 30 | 30 | 30 | 30 | 0 | 0 | 0 | 8 |
| G-08 base-usable | 30 | 28 | 28 | 28 | 0 | 0 | 2 | 2 |
| G-08 graph-recovered | 30 | 30 | 30 | 30 | 0 | 0 | 0 | 2 |
| G-08 の unavailable 3 variant | 30×3 | （unavailable。steady の集計なし） | - | - | - | - | - | 2 |
| **合計** | 270（steady の Graph arm は 150） | **130** | **130（全件）** | **130** | **0** | **0** | 20 | |

欠落 20 件は、すべて Graph が D の窓内に合流しなかったもの（G-02 の 18、G-08 base-usable の 2）で、first-render の候補ではない。follow-up（first-render でない表示）は steady の全 variant で 0 件。

### FR ごと（R-6 の (a)〜(c) と FR-1〜FR-8）の下位条件（窓内に合流した親 130 件）

| 下位条件 | 満たした | 欠いた |
| -------- | -------: | -----: |
| (a) R1 | 130 | 0 |
| (b) 親の準備が 1 回 | 130 | 0 |
| (c) 次の Graph arm の `preparesReady` との差が 1 | 130 | 0 |
| FR-1〜FR-6 | 各 130 | 0 |
| FR-7（親の寄与） | 130 | 0 |
| FR-8（記録の誤り。`[artifact]` で止まった親 0） | 130 | 0 |

### stamp0-missing の頻度

measured の Graph arm 270 sample のうち、`stamp0-missing` 209、`fresh` 1（G-06）、`none` 60（G-08 の graph-index-unusable・both-indexes-unusable の 30×2）。steady で Graph が使える variant では 29〜30／30 が `stamp0-missing`（予行 3・5 と同じく頻度は高い）。FR-3 は窓内に合流した 130 件のすべてが満たした。

### 品質の予告（/6 の regime、判定に使わない）

予行の receipt の regime は k62（封印。呼び手が選べない）のため、`assessK66RehearsalQuality`（変える点 6、D2・D3）を samples に当てた。

- **measurable 5**: G-02 base（first-render 12・follow-up 0）、G-03 base（30・0）、G-06 base（30・0）、G-08 base-usable（28・0）、G-08 graph-recovered（30・0）。`graph-contributed-parent-not-counted-as-first-render` は 0 件。
- **fallback-measured 3**: G-03 frontier-exceeded、G-08 の both-indexes-unusable・graph-index-unusable。
- **hold 1: G-08/chronicle-index-unusable**（`a2-index-ready-requery-hold`）。D3 の対象として分類された（index-ready の子 30 件が eligible、graphShown 30、D3 の対象外の子 0）。予行 5 では `unavailableQuality` が FAIL にしていた（`graph-shown-for-a-variant-expected-unavailable`）variant が、D2・D3 を入れた実装では FAIL でなくなった。
- **FAIL 0**。

## 落ちた親

0 件。理由の記録は無い（構造的か偶発かの判定は不要）。

## G-01 の診断の head の確認

`pubg16-e2e-run.mjs --mode g01-frozen` の head の書き出しを、実リポジトリ（新 worktree の git）で確かめた。凍結の手順（setup の凍結・正式 receipt）には触れていない。

- 呼び方（dev の形）: `--s4-commit <今の HEAD `34d1cc5c`> --k62-commit af643a93… --k64-commit 5dea38af… --k65-commit 07fc80ec… --k66-commit 56fb4fad…`（k62〜k66 は `constants.mjs` に pinned の freeze commit）、`--setups /nonexistent.json`（存在しない file）、`--run k66-r6-g01head`。CLI は head を作って `head.json` を `.artifacts/cp4/k66-r6-g01head/` に一度だけ書き、その後 `readSetups` の ENOENT で止まる（setup を作っていないため。意図どおり。測定は始まらない）。
- `head.json` の項目: `kind: g01-diagnostic`、`k62`・`k64`・`k65`・`k66`（freezeCommit と sha256）、`observationPrep.commit`（`34d1cc5c`）・`observationPrep.freezeRecordSha256`（`315d6113…`、HEAD の `observation-prep-freeze.v1.json` の sha256）、`runStartedAtUtc`。つまり `observationPrep.commit`・`runStartedAtUtc` と他の項目が入る。
- `readG01DiagnosticHead` を直接呼ぶ版（`g01-head/k66-g01head.mjs`）でも、s4-commit に HEAD と `63bc9b90`（6 回目の S4）の両方で同じ形の head が取れた。
- 正式の receipt は作っていない。

## 気づいたこと

1. **D3 (b)(d) が dev の予行では常に hold になる**: dev-shape の子の記録には `materialRevisionPreview`（`basis: material-revision`、observed に path-attachment）があるが、品質判定が読む `materialRevision` は無い（`d3Problems` は `child.materialRevision` が object でなければ `b-material-revision-record-missing` で hold）。setup の `typedRevisions`（2 件）は渡した。したがって予行の hold は dev の receipt の形に由来し、正式の run（子が `materialRevision` を持つ形）での結果を予告しない。D3 の対象への分類（FAIL でない）は確かめられたが、(a)〜(d) の通過・違反は予行では見えない。
2. G-02 は窓内に合流する割合が 12／30（予行 1・3・5 は 14・12・7）。D = 40 ms の端にあり、run ごとのぶれが大きい。30 件の下限は予行全体では問題なし（130）。
3. 新しい worktree で評価 build の前に `packages/*/dist`（ignore された build 出力）が要る。node_modules を複製するときは一緒に複製する。
4. 予行 5（#830 の後）と比べ、各 run の所要が短く（G-08 約 30 分、予行 5 は約 32 分）、G-03 は約 7.5 分。Graph の到着の速さの比較はこの文書では行っていない。
