# 復元した decisions.md の出所

対象は、2026-10-14 の片付けで worktree と一緒に消えた `.ralph/agent/decisions.md` の7本。
Claude Code の会話記録（jsonl）だけから復元した。repo、worktree、会話記録は変更していない。

## 結果の一覧

| ファイル | レーン（PR） | 行数（wc -l） | バイト | sha256 | 最後の書込み（UTC） | 確からしさ |
|---|---|---|---|---|---|---|
| broute-decisions.md | B-ROUTE（#643） | 495 | 75,104 | c539f374c66ec2b61917912af93d552f4bf3d7dc4836441263904e444d27d712 | 2026-10-13T03:42:49Z | 確実 |
| dt3-decisions.md | DT-3（#637） | 330 | 43,012 | bfa867514eb0e2ed2dd0953da19b4aca5e647e9e8ee40bce2b18a2395adbcec4 | 2026-10-12T22:23:29Z | 確実 |
| cp1-decisions.md | CP-1（#641） | 510 | 59,688 | 360e71b163160181b08997dbc082b2622856a11981984a94d4e45868be34d68c | 2026-10-12T23:46:00Z | 確実 |
| cres-decisions.md | CR-1／CR-1b（#636） | 159 | 15,283 | 30b8444e82b22496ebc61c19097f6bb37f32fb18e83efef1e65b0ef8f5504e1e | 2026-10-12T14:41:48Z | 確実 |
| hp-decisions.md | HP-1（#632） | 26 | 2,217 | d1c9192bd581413c7b3fde02367ec3b4c1d57f6efc245ba6551f56852fc14acc | 2026-10-12T13:29:32Z | 確実 |
| dt1-decisions.md | DT-1（#634） | 94 | 9,758 | fb4042970839358dbf0df50aaa08c36090ec685fb63f039eb4e40563c2e3dff2 | 2026-10-12T13:05:22Z | 確実 |
| dt2-decisions.md | DT-2（#642） | 820 | 111,511 | 55f2a948b4ab26779c24e2acf1cd220d66dd4f8b47cbff4933eef1d298081b7d | 2026-10-13T03:26:13Z | 確実 |

7本とも、内容が不確かな箇所はない。どのファイルも末尾は改行1つで、CR は含まない。

## 共通の前提

- 時刻：jsonl の timestamp は UTC（Z）。`ls` の出力は JST（UTC+9）。
- 略記：`S` = `/home/grimodex/.claude/projects/-home-grimodex-Grimodex/3754f9a7-620d-4e21-ad37-3096691a96be`、
  `P` = `/home/grimodex/.claude/projects`。`a→b` は「tool_use の行 → tool_result の行」（jsonl の行番号）。
  出力が大きい Bash の結果は、tool_result に `<persisted-output>` があり、本文は `S/tool-results/*.txt` にある。
- 削除の記録：`S.jsonl:9403`（2026-10-14T03:25:28Z、`git worktree remove` のループ）→ `S.jsonl:9404`（03:25:54Z）で、7レーンとも「削除」。
  削除後の 03:30:32Z の `ls`／`sha256sum`（`S/subagents/workflows/wf_2c1e0818-089/agent-ac4d9d037656fc9dc.jsonl:236→237`）は「そのようなファイルはない」で失敗している。
  03:30Z より後に記録に出てくる dt1／dt2 の sha256 は、以前の結果を jsonl から再表示したもので、生きたファイルの観測ではない。
- 削除前の最後の一覧：2026-10-14T01:11:37Z の `ls -la /home/grimodex/worktrees/Grimodex/*/.ralph/agent/decisions.md`
  （`S/subagents/workflows/wf_2c1e0818-089/agent-a619c3eda3d7ed79d.jsonl:48→49`）。

  | レーン | サイズ | mtime（JST） | = UTC | 対応する最後の書込み |
  |---|---|---|---|---|
  | broute | 75104 | 10-13 12:42 | 10-13 03:42 | §12 の `cat >> "$DEC"`（03:42:49Z） |
  | cp1 | 59688 | 10-13 08:46 | 10-12 23:46 | §12.5 の `cat >>`（23:46:00Z） |
  | cres | 15283 | 10-12 23:41 | 10-12 14:41 | Editor.rep（14:41:48Z） |
  | dt1 | 9758 | 10-12 22:05 | 10-12 13:05 | Write（13:05:22Z） |
  | dt2 | 111511 | 10-13 12:26 | 10-13 03:26 | Edit（03:26:13Z） |
  | dt3 | 43012 | 10-13 07:23 | 10-12 22:23 | §15 の `cat >>`（22:23:29Z） |
  | hp | 2217 | 10-12 22:29 | 10-12 13:29 | D3 の `cat >>`（13:29:32Z） |

  サイズは7本とも復元版のバイト数と一致する。mtime も、復元に使った最後の書込みの時刻と一致する。
- 01:11:37Z から削除（03:25:54Z）までの間、7本のパスへの書込みの記録はない。全 jsonl を、パス名か worktree 名を含む tool_use で走査した。
  この間にあるのは dt1／dt2 の Read、sha256sum、sed、cat と、削除前の状態確認だけだった。
- 方法：`~/.claude/projects` の下の全 jsonl（subagents と workflows を含む437本）から、入力に `decisions` か `.ralph` を含む tool_use と、対応する tool_result を集めた。
  レーンごとに時刻順に、次の書込みを当てた。
  - Write（全文）
  - Edit（old_string／new_string）。エラーで終わった Edit は当てていない。
  - Bash の heredoc（`cat >>`／`cat >`）と、python による置換。python は置換の対象が1回だけ出現することを確かめてから当てた。
  当てた結果は、後に続く全文の読取と照合した。照合に使った読取は次のとおり。
  - Read の結果から `N<TAB>` の接頭辞を外したもの
  - Read の toolUseResult（行番号なしの原文）
  - `cat` と `sed -n` の出力（persisted のものは本文のファイル）
  Bash の出力は末尾の改行が落ちるので、その比較だけは末尾の改行を除いて行った。
  スクリプトは `scratchpad/recdec-scripts/`、途中の生成物と PR 本文は `scratchpad/recdec-work/` にある。
- Read の結果は1行2000文字を超えると切り詰められる。ただし、どの照合も Write／Edit の入力から作った全文と完全に一致したので、切り詰めの影響はない。

## レーンごとの根拠

### broute（B-ROUTE、PR #643）

- 最終版の根拠：最後の書込みより後の、`cat` による全文の出力4件と完全に一致した。
  - 2026-10-13T04:04:30Z：`S/subagents/workflows/wf_e84ed721-751/agent-a6deb746029bb3f01.jsonl:25→32`。本文は `S/tool-results/b8jffyp94.txt` の `=== DECISIONS ===` の後。
  - 04:04:26Z：`…/wf_e84ed721-751/agent-a3b615d6af469699a.jsonl:22→23`（`bj59nsk9l.txt`）
  - 03:44:21Z：`…/wf_b2d621fd-e73/agent-a0f1358a0d84b1858.jsonl:26→33`（`b3eecgf8p.txt`）
  - 03:44:19Z：`…/wf_b2d621fd-e73/agent-a2ee0b05bed8b0e30.jsonl:25→31`（`bur3nqk7f.txt`）
  - サイズと時刻：03:57:09Z の `ls`（同 agent `:258→261`）で 75104 B、mtime 2026-10-13 12:42:49.920 JST。§12 を追記した Bash の出力も「lines now: 495」。
- 当てた書込み（`S/subagents/workflows/wf_5241a95d-291/` と `…/wf_b2d621fd-e73/` の下）：
  1. 2026-10-12T22:43:42Z：Write（`agent-acbf1656e2914e9e6.jsonl:603`）
  2. 22:44:36Z〜22:45:04Z：Edit 16件（同 `:630`〜`:645`）。22:45:05Z の Edit（`:646`）は「No changes to make」のエラーなので当てていない。
  3. 22:45:10Z と 22:45:20Z：Edit（`:667`、`:676`）。この時点で 22:45:30Z の Read 全文（`:681→682`）と一致。
  4. 22:45:43Z：Edit（`:685`）。この時点の 435 行・58300 B は次の観測と一致。
     - wc -l 435（`:690`）
     - 22:46:28Z の Read 全文（`agent-a2cdf1b0626493f4d.jsonl:15→16`）
     - 22:55:17Z の cat（`agent-a6f564b18a62050ff.jsonl:16→18`、`b0kczffvs.txt`）
     - 22:55:19Z の Read 全文（同 `:25→26`）
  5. 23:13:47Z：Edit（`agent-a6f564b18a62050ff.jsonl:523`）
  6. 23:47:44Z：Bash `cat >>`（§11 の 16。同 `:851`）
  7. 2026-10-13T00:00:40Z：Bash `cat >>`（§11 の 17〜18。同 `:1010`）。この時点の 479 行・72181 B は次の観測と一致。
     - 03:21:18Z の cat（`agent-a7eaba8ac7105c89f.jsonl:16→19`、`bfl1vz8e8.txt`）
     - wc -l 479（`:27`）
     - ls 72181 B・mtime 09:00 JST（`:114`）
  8. 03:42:49Z：Bash `cat >> "$DEC"`（§12。`agent-a7eaba8ac7105c89f.jsonl:1539→1540`）
- 確からしさ：確実。不確かな箇所はない。
- PR #643 本文との照合：PR 本文には「判断と信頼境界」の見出しがない。「変更」節と「PUB-G の前に解決すること」節を照合した。食い違いはない。
  - 配置は §0、§2、§3.1 と一致する。gated な新 route と、Run を作らない（ledgerless）work kind `nir1-graph-index-build` を置く。既存 route には載せない。Run 付きの Run Kind は `run_kind` の CHECK のため schema の変更が要るので採らない。`route_descriptors()` は3本のまま。
  - phase 1 の判定と V／P、phase 2 の publish、COMMIT 直前の grant は §3.4 と §4 と一致する。
  - `Nir1GraphIndexBuildGate` が開くのは未 package・`CI=true`・owner token の journey seam だけで、packaged では拒否する。これは §3.2 と一致する。
  - refusal の process-local な記録は §3.5、skip の証跡を durable に残さないことは §3.3 と §9-2 と一致する。
  - stale な binding と Verify の問題は §11.16 と一致する。
  - B-close の数値は、decisions では BC:19-39 の参照と、C7 試験の N+1 の値（候補 2,065、保存 edge 8,194 行、Source 16 MiB+1、SQL 600,000,001）として書かれている。PR の値（2,064、8,193 行、16 MiB、600,000,000、180 s）と整合する。
  - PR の P3 のうち、次の2件は decisions にない。受入れの指摘で、decisions の最後の書込みより後に出たもの。
    - 「COMMIT の予約が SQL 上限ちょうどで Err」
    - 「一時的な期限超過も refusal として記録」

### dt3（DT-3、PR #637）

- 最終版の根拠：
  - 2026-10-13T00:17:04Z の Read 全文（`S/subagents/workflows/wf_d46e629d-c69/agent-a3aecbd42b067905e.jsonl:81→83`）と完全に一致した。
  - 最後の書込みの後の Read 全文、2026-10-12T22:24:39Z（`…/wf_3d8d5f65-842/agent-aa9ea35434d0d9689.jsonl:16→20`）と 22:30:48Z（`…/wf_d46e629d-c69/agent-aa168ec94a8083114.jsonl:57→58`）も一致した。
  - 2026-10-13T13:13:00Z と 13:13:02Z の Read（1〜170行と170〜331行。`…/wf_80efa33c-a2a/agent-a1aa796a0a26f9cad.jsonl:72→73`、`:75→76`）でも、全行が一致した。
  - wc -c 43012（22:31:01Z、`…/agent-a18bf3d4a25f7fd2f.jsonl:65→66`）。wc -l 330 は 10-12 22:30Z から 10-13 13:12Z まで複数回観測されている。
- 当てた書込み（`S/subagents/workflows/wf_3d8d5f65-842/` の下）：
  1. 2026-10-12T14:59:20Z：Write（`agent-af1f3a9af541fbdc1.jsonl:449`）
  2. 15:07:17Z と 15:08:19Z：Edit（`:553`、`:594`）
  3. 15:08:48Z：Bash `cat >>`（§13。`:608`）。15:08:57Z の Read 全文（`:617→618`）と一致。
  4. 15:14:24Z：Bash `cat >>`（§14。`:681`）
  5. 15:14:29Z の Edit（`:685`）は「File has been modified since read」のエラーなので当てていない。15:14:31Z の部分 Read（`:689`）と一致した後、15:14:34Z に同じ Edit が再実行されている（`:692`）。
     その後の 15:15:29Z、15:22:16Z、22:07:33Z の Read 全文と一致。
  6. 22:23:04Z：Edit（`agent-a9b842ef8bd485087.jsonl:273`）
  7. 22:23:29Z：Bash `cat >>`（§15。同 `:274`）
- 確からしさ：確実。不確かな箇所はない。
- PR #637 本文との照合：「判断と信頼境界」の5項目すべてに、対応する記述がある。食い違いはない。
  - 保存する識別子は receipt の tuple を超えない：§0 の表と §5。
  - incarnation に A1 の `scene_incarnation_id` を使い、tree_nodes の列の組は採らない：§4 と §9。
  - live は Scene 自身の `archived_at` だけを見る：§4 と §12-2。
  - session が Scene に付いていることを create／claim の条件にする：§4 と §12-3。
  - 未知の版は recover でも拒否し、downgrade 時は gate が閉じる：§7 と §12-4。
  - #642 本文の「動かす箇所は DT-3 の decisions に記録」は、§11（DT-2 との衝突面）に当たる。
  - PR の「DT-2 の上への rebase（2026-10-13）」の判断1〜5は decisions にない。decisions の最後の書込み（10-12 22:23Z）より後の作業で、mtime も変わっていない。

### cp1（CP-1、PR #641）

- 最終版の根拠：
  - 2026-10-13T03:21:40Z の Read 全文（`S/subagents/workflows/wf_10970356-6fd/agent-a9fd3540807a37119.jsonl:30→31`）と完全に一致した。
  - 次の cat 3件も一致した。
    - 2026-10-12T23:47:24Z：`…/wf_81f840b2-d9e/agent-a93c1110b89b7ddb5.jsonl:24→29`（`birn6hmsr.txt`）
    - 2026-10-13T03:21:34Z：`…/wf_10970356-6fd/agent-a2eee6a2253af001b.jsonl:15→16`（`biqit3vxn.txt`）
    - 同時刻：`agent-a9fd3540807a37119.jsonl:15→16`（`bocbw2cq9.txt`）
  - wc -l 510（10-13 13:18:44Z、`…/wf_9a1ff755-ffb/agent-ae296df91df3f8231.jsonl:210→211`）。
- 当てた書込み（`S/subagents/workflows/wf_81f840b2-d9e/` の下）：
  1. 2026-10-12T15:43:16Z：Write（`agent-aa47d7c7db4efa0d2.jsonl:404`）
  2. 15:43:45Z：Bash `python3`（行番号の参照5件を置換。`:420`）。同じコマンドの grep 出力と、15:43:48Z の Read 全文（`:425→426`）に一致。
  3. 15:44:04Z：Edit（`:433`）。この時点の 437 行・47999 B は、15:44:47Z、22:07:30Z、22:15:51Z の Read 全文と、22:15:49Z の ls に一致。
  4. 22:26:24Z と 22:26:26Z：Edit（`agent-a02adc01428a1be33.jsonl:251`、`:252`）
  5. 23:22:20Z：Bash `cat >>`（§12。同 `:618`）
  6. 23:46:00Z：Bash `cat >>`（§12.5。同 `:785`）
- 確からしさ：確実。不確かな箇所はない。
- PR #641 本文との照合：「判断（U3 委任）」は decisions と一致する。違いは計測値の小さな差1点だけ。
  - 一致する点
    - join を worker の中に置き、advisor は A 案：§1、§2、§2.1。
    - 新しい防御上限 `MAX_SCENE_SECTION_BYTES` = 16,384 B：§5.3 と §12.3。
    - 実測 2,188 B（UUID 形8件）と 247 B（sample）：§12.3。
    - pin の件数に独立の上限を置かない：§5.4。
    - 上界の 496 件で 31,509 steps：§12.3。
    - query Scene 自身の pin を除外しない：§11-1。
  - 小さな差：上界 496 件の wall を、PR は「約 3.1 ms」、decisions の §12.3 は「3.2 ms」と書いている。steps は同じ値。§12.3 は heredoc の追記そのままなので、復元の誤りではない。PR 側の丸めか、別の回の計測と見られる。

### cres（CR-1／CR-1b、PR #636）

- 最終版の根拠：
  - 2026-10-12T15:31:40Z の `sed -n 1,159p`（`S/subagents/workflows/wf_81f840b2-d9e/agent-aa47d7c7db4efa0d2.jsonl:340→341`）と完全に一致した。
  - 2026-10-13T13:09:39Z の `wc -c`（15283）と `head -150`（`S/subagents/agent-a2e27f48ce0c1ae01.jsonl:146→147`）、13:09:47Z の `sed -n 150,400p`（同 `:150→152`）でも、全行が一致した。
  - 15:12Z の cat 3件（`S/tool-results/becpefrk2.txt`、`b3w6a1a3r.txt`、`bbkcemiho.txt`）も一致した。
  - wc -l 159（15:31:29Z と 15:34:12Z。後者は `S.jsonl:2999→3000`）。
- 当てた書込み：
  1. 2026-10-12T13:36:14Z：Write（Ralph の Builder。`P/-home-grimodex-worktrees-Grimodex-claude-nir1-cres/55a1c15b-03f2-4081-888c-c2763c00c7f0.jsonl:874→875`）。toolUseResult の content も同じ。D1〜D4 を含む。
  2. 14:01:19Z：Bash `cat >>`（D5。同 `:1286`）。14:04:39Z の cat（`S/subagents/workflows/wf_84d5f687-f7e/agent-aa1bab25ec9060ecf.jsonl:15→17`）と一致。
  3. 14:41:29Z：Bash `cat >>`（「# CR-1b decisions」D6〜D8。同 agent `:676`）。直後の `tail -5` の出力と一致。
  4. 14:41:48Z：Bash `python3`（同 agent `:692`）。`scratchpad/cr1b/tools/edit.py` の Editor.rep で、D6 の1行を2行に置き換えた。結果は「ok: 1 edit(s)」。
- 確からしさ：確実。不確かな箇所はない。
- PR #636 本文との照合：「判断と信頼境界」は decisions と一致する。PR のほかの節とは、decisions が更新されなかったための差が2点ある。
  - 一致する点
    - D1：1試験を1 process で実行し、1 process にまとめる案は相互干渉のため採らない。
    - D2、D6（2本が最小。試験 `schema_42_decision_indexes_each_serve_a_lookup_the_other_cannot`）、D7、D8。
    - 外部送信、新しい送信先、閾値の変更はない：D1 の信頼境界。
  - PR のほかの節との差（decisions の最後の書込み 10-12 14:41Z より後の修正が、decisions に反映されていないため。復元の誤りではない）
    - lifecycle lane の件数：PR は 14 件（Q2 reader を追加）。decisions の D1 は 13 件のまま。
    - core dump の対策：PR は `prlimit --core=1:1`（受入れの P2 の修正）。decisions の D5 は `ulimit -c 0` のまま。
    - 10-13 13:14Z の CR-REC のメモ（`S/subagents/agent-a2e27f48ce0c1ae01.jsonl:246`）も、D5 について「ulimit->prlimit later」と書いている。

### hp（HP-1、PR #632）

- 最終版の根拠：
  - 2026-10-12T13:29:50Z の Read 全文（Ralph の Reviewer。`P/-home-grimodex-worktrees-Grimodex-claude-nir1-hp/44f6d584-55fb-4460-99aa-8409fdeabc96.jsonl:20→22`）と完全に一致した。
    この Read の toolUseResult の `file.content` は行番号のない原文で、numLines は 27、totalLines も 27。
  - 13:33:02Z の cat（`S/subagents/workflows/wf_7124f216-0b6/agent-affaf8008d04490c7.jsonl:14→15`）と、14:40:17Z の `sed -n 1,80p`（`S/subagents/workflows/wf_c24debcf-c97/agent-ad300c16ea7afd799.jsonl:389→390`）も一致した。
  - wc -l 26（15:31:29Z）。
- 当てた書込み（Ralph の Builder。`P/-home-grimodex-worktrees-Grimodex-claude-nir1-hp/9e93665d-094a-478f-9cca-91b215895515.jsonl`）：
  1. 2026-10-12T12:59:25Z：Bash `cat >> .ralph/agent/decisions.md`（`:169→173`。コマンドの2つ目の heredoc。D1 と D2）。
     直前の 12:57:36Z の `ls .ralph/agent/`（`:22`）は空だったので、この追記が新規作成に当たる。
  2. 13:29:32Z：Bash `cat >>`（D3。`:457→463`。コマンドの1つ目の heredoc）
- 確からしさ：確実。不確かな箇所はない。
- PR #632 本文との照合：PR に「判断と信頼境界」の節はない。食い違いはない。
  - 次の記述は D1 と一致する。
    - `nir1_generation_history.rs` の変更は、adapter 試験 fixture の struct literal に新しい field を足しただけ。許可範囲外だが、コンパイルに必要な最小の変更。資格 gate と reauthorize の本体は変えていない。
    - 受入れの P3-2。
    - 予算を渡さない呼出しは fail-closed になる。
  - D2（subprocess、background、async、egress は変えない）と D3（rustfmt の件）に反する記述はない。
  - rebase（10-14）で DT-3 の `history_budget()` に足した変更は、decisions にない。decisions の最後の書込みより後の作業。

### dt1（DT-1、PR #634）

- 最終版の根拠：
  - 書込みは 2026-10-12T13:05:22Z の Write 1回だけ（`P/-home-grimodex-worktrees-Grimodex-claude-nir1-dt1/f22274ca-7057-4394-b978-745a87d99276.jsonl:290→293`）。その content の sha256 が fb404297…。
  - 削除前の最後の観測は、2026-10-14T03:09:22Z の `sha256sum`（`S/subagents/workflows/wf_2c1e0818-089/agent-afbad72c830d92744.jsonl:180→181`）で、値は fb404297…。
  - 10-14T02:44:00Z の cat 全文（`…/agent-a8ceeac1dd7a88119.jsonl:307→308`）と、03:09:25Z の `sed -n 86,96p` も一致した。
  - mtime は 10-12 13:33Z から 10-14 02:35Z まで、ずっと 10-12 22:05:22 JST のまま。
- 既存の版との関係：`lost-decisions/dt1-decisions-fb404297.md` と `dsn5/recovered/dt1-decisions-write-2205.md` と、byte 単位で同じ。より新しい版はない。既存の版が最終版である。
- 確からしさ：確実。不確かな箇所はない。
- PR #634 本文との照合：食い違いはない。
  - 次の記述が一致する。
    - 信頼境界：§1。
    - D1：§5。代替案2つも同じ。
    - D2：lock の外で drain し、上限は 250 ms。
    - D3 と D6。
    - owner／lifecycle matrix の13行（entry、start、retry、reentrant、admission closure、pending start、active lease、cancel、drain 上限、終了の証拠、error／timeout、shutdown、restart）：§4。
  - D4 は、PR が「Ready と Join の間に revision だけが変わった場合」を足している点だけが、decisions の D4 にない。受入れの P3「revision だけが変化した後の再 sweep（D4）」を、PR 側で要約に入れたものと見られる。
  - D5 は PR の要約にない。

### dt2（DT-2、PR #642）

- 最終版の根拠：
  - 既存の版（`dsn5/recovered/dt2-decisions-55f2a948.md`）は、2026-10-14T01:48:25Z〜01:48:36Z の `sed -n` 4本の出力を継いだもの。
    - `S/subagents/workflows/wf_2c1e0818-089/agent-a6a6d95147855319c.jsonl:86→87`
    - 同 `:90→91`（`bijlgq23p.txt`）
    - 同 `:96→97`
    - 同 `:100→101`（`bp77nyade.txt`）
  - その sha256 は、生きたファイルへの `sha256sum` の出力と一致する。観測は 10-14T01:11:41Z、01:26:43Z、01:48:19Z、02:10:41Z、02:35:14Z、03:04:18Z の6回。削除前の最後は `…/agent-afbad72c830d92744.jsonl:65→66`。
  - 次の読取とも一致した。
    - 10-14T02:35Z の Read（1〜115、115〜434、435〜554、645〜824行。`…/agent-a8ceeac1dd7a88119.jsonl:94〜105`）
    - 02:10Z の sed（1〜112、112〜430、662〜820行）
    - 10-13 の Read（1〜250、250〜509、510〜821行など）
  - mtime は 2026-10-13 12:26:13.397 JST（=03:26:13Z）。01:26:43Z の `stat`（`…/agent-a619c3eda3d7ed79d.jsonl:242→243`）で観測した。最後の書込みは、2026-10-13T03:26:13Z の Edit（`S/subagents/workflows/wf_4a2b064c-efc/agent-a6210480d540413dd.jsonl:293→294`）。
  - sha256 が一致するので、Write、Edit、Bash による書込みのすべてを当て直すことはしていない。
- 既存の版との関係：`lost-decisions/dt2-decisions-55f2a948.md` と `dsn5/recovered/dt2-decisions-55f2a948.md` と、byte 単位で同じ。より新しい版はない。既存の版が最終版である。
- 確からしさ：確実。不確かな箇所はない。
- PR #642 本文との照合：「判断と信頼境界」の4項目すべてに、対応する記述がある。食い違いはない。
  - 入口は Native の内部だけで、冪等鍵は capture writer が mint した型から取る：§2 と §3。
  - lock 順：§4。
  - 新しい防御上限3つ：§11-1、§14-5、§14-6。
    - registry 16
    - zero-send の書込み 3回
    - sweep の `ConnectionBusy` は1件3回、間隔 0 ms
  - 決定的 attempt ID を Session B で通知し、retry の鍵は DD-1 で決める：§6 の E5 と §11-2。

## 既存の復元版について

`lost-decisions/` と `dsn5/recovered/` の dt1／dt2 は、どちらも削除前の最終版と一致した。より新しい版はない。
既存のファイルは変更していない。sha256 は作業前と同じ。

## SHA256SUMS

同じディレクトリの `SHA256SUMS` に、7本の decisions の sha256 を書いた。この PROVENANCE.md は含めていない。
