# s9 の dev 走行（s9d1）の評価（2026-11-18）

> 正本は `fusion-eval-data/design-notes/cp4-s9-dev-2026-11-18/evaluation.md`（受領書の写しは同 dir の evidence/）。**dev の参考記録で、台帳外**。

**dev の参考記録です。台帳・S6 の判定・品質判定・PUB-G の判断には数えません**（ユーザー決定「dev として全体を走らせる」）。正式の判定は、最後の凍結の後の正式 run で行います。

## 1 何を走らせたか

- 候補：`2100722a`（枝 `claude/cp4-sp-p4-shm-fix`、SHM の直し。master `01dd6821` との差は harness の driver と試験だけで、製品のコードは同じ）。
  - 枝はその後 `7272ad50` に進んだ。差は pre-step の観測の失敗時の記録だけで、成功の経路は同じ（README の「候補の記録」）。
- S4b は `70a07561`（9 回目の S4）、K6/7。worktree は `cp4-dev-s9d1`、ログは `/tmp/claude-1000/s9d1/`。
- 手順は `runbook-dev/`（run9 の runbook の写し）。contracts への push は止めた。

## 2 結果

### 2.1 実 G-case（13 variant の正式の setup）で通した前半

| 段 | 結果 | 補足 |
|---|---|---|
| build（標準・評価） | exit 0 | 01:45〜01:54 JST |
| setup 13 件 | 13/13 setup-complete | 01:58〜02:14 |
| V-10 の事前確認（2 版） | 13/13 ok | running 0、seal runs の最大 5、settle の最大 1359 ms |
| chain 冒頭の admission | ok | pin の commit の blob と祖先だけを見る |
| **SP-P4**（sp-p4-s9d1-1） | **passed** | 8 variant すべて `same:true`、差 0。problems 0。台帳は completed |
| trace-editing | valid | 下の表 |
| trace-browsing | valid | 下の表 |
| parity | **停止（設計どおり）** | runner の S5 admission が、直した driver の bytes を pin（39b89bc3）と違うとして `[precheck]`。測定前で、受領書・台帳は作られていない |

- **s9r1 が止まった SP-P4 の前段を、直した harness で通した。** 欠陥の直しの確認になった。

### 2.2 trace の値（K6/4 の読み。正式の s7r2 と並べた参考）

| | U | 窓内 | 窓外 | 窓外率 | 失効 | 窓外の理由 |
|---|---|---|---|---|---|---|
| s9d1 editing | 201 | 193 | 8 | 3.98% | 0 | graph-late:stale-start 8 |
| s7r2 editing | 201 | 185 | 16 | 7.96% | 0 | stamp0-missing 12、stale-start 4 |
| s9d1 browsing | 201 | 75 | 126 | 62.7% | 0 | graph-late:stale-start 126 |
| s7r2 browsing | 201 | 49 | 152 | 75.6% | 0 | stale-start 146、stamp0-missing 6 |

- 失効は両方とも 0 で、s7r2 と同じ。
- **窓外の増減は言えない。**
  - s7r2 は K6/6 の harness、s9d1 は K6/7 の harness で、候補も違う。どちらも 1 回だけの測定。
  - s7r2 にあった `freshness-stamp-stamp0-missing`（計 18 件）は、K6/7 では stamp の読みが外れたので出ない。
  - 同じ理由（`graph-late:stale-start`）どうしで比べると、editing は 4→8 に増え、browsing は 146→126 に減っている。読みが違うので、どちらの向きの比較も根拠にしない。
- 生の欄の `outOfWindowExceeds` は、両方とも true（s7r2 も true だったが、S6 の規則は HOLD を指さなかった）。
- 判定の規則（S6）は当てはめていない。受領書 28 件と台帳 8 件がそろわないため。

### 2.3 後段の dev の予行（dev の fixture。ユーザー回答「dev の fixture で後段を予行」）

`--dev-fixture` の経路（`admitDevPreview`）で、pin の照合を外す変更は入れずに通した。dev の形 2 つ（G-01 形 `v1`、G-08 形 `base-usable`）を使った。

| run | 形 | 結果 |
|---|---|---|
| dev setup 2 件 | G-01／G-08 | setup-complete |
| parity | G-01／G-08 | 測定済み。35 sample。problems 0 |
| Gold | G-01 | 測定済み。30 件すべて「数えない」（`FR7:no-expected-contribution`。dev の G-01 形は期待する寄与を定義していない） |
| Gold | G-08 | 測定済み。初回描画 29/30、見逃し 1（X5）。q1 44.1 ms、q3 75.7 ms（n=1） |
| N2・N3・N4 | G-01 | 測定済み。70 sample（Graph 35）。problems 0 |

- 7 本とも runner の problems は 0。検証の誤りは、dev では必ず出る `candidate.productReceiptSha256`（dev の経路は製品の receipt を受け取らない）の 1 件だけ。verdict は `preview-only`。
- **K6/7 の後段のコード（parity・Gold・negative の runner と受領書）のうち、dev の経路は、9 回目の S4 の harness で初めて最後まで走った。** その範囲では、SHM のような「走らせて初めて分かる」欠陥は出なかった。
- **dev の経路が通らないもの**（正式 run が初回になる）：
  - S5 admission。封印つきの setup 受領書の読み。13 の cold DB の seed pin の gate。
  - SP-P4 の受領書の gate、台帳。
  - one-shot の variant、blocked の variant。
  - G-01 の e2e の診断。
- **Gold の値は未評価。** 両方の形で `notReadyAtStart` 30/30、`outOfWindowRate` 1、`qualityHold` true だった。G-08 形は初回描画が 29 なのに、窓内が 0。dev の形でのこの値の基準（以前の dev preview の記録）と照合していないので、良し悪しは言わない。
- 13 の G-case の実データでの後段は、測れていない。

## 3 言えること／言えないこと

- **言えること**
  - SP-P4 の SHM の欠陥は直り、SP-P4 は実 G-case で passed になる。
  - 前半（setup・V-10・SP-P4・trace）と、後段の runner の経路は、この harness で動く。
  - trace の失効は 0（s7r2 と同じ）。
- **言えないこと**
  - 正式の判定（HOLD かどうか、Lane unlocked かどうか）。
  - 実 G-case での Gold・negative・parity の値。
  - G-01 の e2e の診断（走らせていない）。
  - 品質判定 v3 は、Gold・parity・negative の正式の受領書が要るので実行できない。

## 4 最後の凍結に持ち越すこと

1. driver の新しい pin（impl.md §6。pin 54→55、S2 の sha256 の取り直し）。これを入れないと、正式の parity 以降は S5 admission で止まる。今回の停止で確かめられた。
2. 正式 run では、parity・Gold・N2〜N4・G-01 が実 G-case で初めて走る。今回の dev の予行で runner の経路は通ったが、上の「dev の経路が通らないもの」と実データでの値は未知。
3. 実 G-case の SP-P4 が通ったのは `2100722a` の driver だけ。枝の head の `7272ad50` の driver（観測の失敗時の記録）は、workflow の dev の予行（8 形）でしか通っていない。最後の凍結で pin に載せる commit は、impl.md §6 の `a21d4f1f` ではなく、driver を最後に変えた `7272ad50` になる見込み（凍結のときに確かめる）。
4. 実 G-case で後段を通す道（dev 専用枝で S5 admission に名指しの例外を入れ、s9d2 として build からやり直す）は残っている。ユーザーの判断があれば始める。
5. S6 の道具（`recompute-trace-*.mjs`）は、s9d1 の trace の受領書ではまだ回していない。

## 5 記録の置き場

- 停止：`stop-parity-s5-admission.md`
- 実 G-case の受領書：`cp4-dev-s9d1/.artifacts/cp4/{sp-p4,trace-editing,trace-browsing}-s9d1-1/`
- dev の予行：同じ dir の `s9d1-dev-*`、ログは `/tmp/claude-1000/s9d1/backhalf/`
