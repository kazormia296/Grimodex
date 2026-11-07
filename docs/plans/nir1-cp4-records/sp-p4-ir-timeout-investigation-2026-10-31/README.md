# SP-P4 の IR 期限切れの群れの原因調査（2026-10-31）

ユーザーが「原因を調べてから決める」を確認した（`user-confirmation-2026-10-31-sp-p4-retake.md` の追記、`84f2ea63`）後に、調査担当（Claude Opus、effort high の subagent。人間ではない）が行った調査の要旨。**台帳を使う正式な測定は行っていない**。dev の観測は台帳と正式の引数を使わず、run 名 `inv-*`、別 worktree（`ed8e3fb9` から。観測の後に削除、tracked file は commit していない）で行った。候補の worktree は clean のまま。

## 結論（調査担当の報告。確信度は報告のまま）

- **期限切れの群れの最有力の説明（確信度：高）**: 数秒の停止は起きていない。IR の期限は `rawReadyAtMs + RELATED_SCENES_IR_EXTRA_WAIT_MS`＝約 **10.84 ms**（`src/features/related-scenes/relatedScenesConfig.ts:7`。「L0 frozen Raw baseline: D = 0.20 B」、#567）で、IR は begin の応答から**ふだんからほぼ D と同じ時間**（静かな機械で中央値 10.6〜10.8 ms、p10 10.4／p90 11.0）で届く。IR の到着の分布の上の裾が期限の境界（約 11.1 ms＝D＋sparse の 0.3 ms）に重なり、1 ms 未満の揺れで期限を越える。境界を超えた sample はすべて期限切れ。
- **側ごとに期限切れの率が違う**（その側の IR の平均が境界からどれだけ離れているか）。0.3 ms ずれるだけで率は数 % から数十 % に変わるので、側をまたいで同じ確率の二項分布を当てる見方は成り立たない。これが「4.7% なのに 1 側が 7 件以上」（過分散）の説明。試行 2 の G-06 with 側の measured 20〜23 番は、埋め込みの時間が 21〜25 ms に倍増した区間と重なり、短い CPU 競合が重なったと推測される（確信度は中）。
- **製品の maintenance は主因ではない（確信度：中〜高）**: 停止した 2 つの run の最悪の側では、測定の時間帯に `narrative_extraction_runs` の行が 0 件。discovery 失敗の stderr の行は全側で 4 回ずつ。旧 `sp-p4-1` では Verify の preempt が多い側（G-06 with 13 件→5/30、G-04 without 6 件→5/30）に弱い同時発生があるが、preempt 6 件の G-02 with は 1/30。
- **機械の負荷（確信度：高、飽和にだけ強く敏感）**: 全 12 コアを占めると measured 29/30、IR の到着の中央値は 12.3 ms（静かなとき +1.6 ms）。3 コアの負荷では 0/30 と 4/30 で静かなときと同じ。**機械を静かにしても約 5% の期限切れは残る**。
- 未解決: begin の応答後の約 10 ms の内訳（native に計装が無い）。IR の経路には読取りトランザクションが 3 回（qualify、題名の読取り、continue の `current_operation` の再検証）あり、どれも単一の接続 mutex を取り、競合すると 1 ms の sleep を挟む（`grimodex-db/src/lib.rs:462-510`）。DB は回転式 HDD 上で、測定前の iowait が約 41%、I/O の PSI の full が約 95% だった（発生源は不明）。正式の G fixture では IR の待ち時間を直接は測っていない（dev の G-06 相当での再現）。3 コア負荷で IR が速くなった理由は 1 回の観測。

## dev の観測（DEV-SHAPE-G06/base、`invTiming` の計装だけを足した。`dev-runs/`、差分は `inv-instrument.diff`）

| run | 機械 | without（measured／warm-up の期限切れ） | with | IR の到着（begin の応答から、中央値） | 期限までの余裕（中央値） |
|---|---|---|---|---|---|
| inv-q1 | 静か | 2/2 | 1/1 | 10.8 ms | +0.34 ms |
| inv-q2 | 静か | 1/0 | 2/1 | 10.6 ms | +0.54 ms |
| inv-l3 | 3 コアに負荷 | 0/0 | 4/0 | 9.6 ms | +1.44 ms |
| inv-l12 | 12 コアに負荷 | 29/5 | 未測定（without で `[precheck]` 停止） | 12.3 ms | −1.16 ms |

## 考えうる対処（調査担当の整理。どれも未実施）

1. 環境の制御：他の負荷を止めるのは必要だが、それだけでは足りない（静かな機械でも 0〜7/30 は確率的に起きる）。
2. 製品側の修正（新しい候補が要る）：begin の応答後の約 10 ms の内訳を native の計装で調べ、IR の経路を短くする。
3. harness の変更（再凍結が要る）：sample に IR の待ち時間を記録して開示する。期限切れの扱いの規則の変更は閾値の変更に当たりうる。
4. 閾値の扱い：側ごとの上限 6、組の上限 6、D そのものを変えるのは委任の外（ユーザーの判断）。

SP-P4 の目的（R と IR が揃った組の一致）は、期限切れの sample を除いても比べられた variant で差異 0 だった。

## 追加の観測：DB の置き場（HDD と tmpfs）の A/B（調査担当、Q4）

この機械の Linux の root は回転式 HDD（sda、WD20EZRX）で、`/proc/pressure/io` の some avg10 が 60〜90% だった。workspace の DB を RAM に置くと IR の裾が変わるかを、dev の G-06 相当で A（HDD 上の `.artifacts`）と B（`/tmp` の tmpfs へ `.artifacts` を symlink）を A→B→A→B→A→B の交互に測った（`dev-runs-ram-ab/`、各 run は `inv-ha*`／`inv-rb*`）。

| 置き場 | IR の到着（begin の応答から）中央値／p10／p90 | 期限までの余裕の中央値 | 期限切れ（without の measured。with は without が上限超えで未測定の run が多い） |
|---|---|---|---|
| A HDD（140 sample） | 10.8／9.3／11.9 ms | +0.39 ms | 合計 33/140 |
| B tmpfs（105 sample） | 10.9／9.0／12.4 ms | +0.24 ms | 合計 38/105 |

- **DB を RAM に置いても期限切れは減らない（確信度：高）**。begin の中央値（18.2〜18.4 ms）と埋め込み＋Raw（13.8〜14.1 ms）も同じ。B の期限切れが多めなのは、B をいつも A の直後に走らせたための時刻の揺れと区別できず、悪化とは言えない（確信度：低）。製品の DB の fsync や I/O の揺れが IR の裾の主因だという仮説は支持されない。
- **一般の負荷が効く**：この A/B の時間帯（05:50〜05:55Z）はユーザーの Chrome が複数の process で CPU 10〜20% を使い、load1 が 3.6〜9.5、iowait が 40〜56% だった。どの run も 4〜12/30 の期限切れで、前の静かな時間帯の `inv-q1`／`inv-q2`（05:32〜05:36Z。1〜2/30）の数倍。IR の到着の中央値はほぼ同じ（10.8〜10.9 ms）で、**p90 が 11.0 ms から 12 ms 台に伸びた**。期限切れの率は IR の到着の裾（CPU の揺れ）で決まる、という結論と合う。
- 注意：`quiet-check`（D3 の分類）は build／test／他の測定を探すだけで、ブラウザや `electron:dev` などの一般の負荷は見ていない。毎回 `quiet` を返したが、上のとおり率は大きく変わった。
- 製品の拒否：workspace を `/dev/shm` 以下に作ると `electron/main/externalMountFs.ts:136-146` が拒否する（システム dir の一覧に `/dev`）。`/tmp` は許可されている（同 135 行）。`.artifacts` の symlink は harness も製品も受け付けた。
