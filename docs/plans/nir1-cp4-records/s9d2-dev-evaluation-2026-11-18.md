# s9 の dev 走行 s9d2（後段を実 G-case で通した）の評価（2026-11-18）

> 正本は `fusion-eval-data/design-notes/cp4-s9-dev-2026-11-18/`（受領書・集計・判定の写しは同 dir の records/ と evidence*/）。**dev の参考記録で、台帳外**。

**dev の参考記録です。台帳・S6 の判定・品質判定・PUB-G の判断には数えません。** S5 admission に dev の例外を入れた候補で測ったので、凍結の上では正式の候補になりえません。正式の判定は、最後の凍結の後の正式 run で行います。s9d1 の評価（`evaluation.md`）の続きです。

## 1 何を走らせたか

- ユーザー回答（2026-11-18）：「後段やってください」。
- 候補は `8bd2cbb9`（dev 専用の枝 `claude/cp4-s9d2-dev`。merge しない）。
  - 中身は、SHM の直しの `7272ad50` に、S5 admission の名指しの例外 1 commit を足したもの。製品のコードは master `01dd6821` と同じ。
  - 例外は 2 つ。
    - `frozen-setup-driver.mjs`：sha256 が `f844b18b…`（直した版）のときだけ受ける。
    - `frozen-k64-admission.mjs` 自身：path の例外。候補の commit と作業木の bytes が同じことだけを求める。
  - 受けた行は、受領書と S6 の集計の `devPinExceptions` に `ok:true` で開示されている。
- 手順は `runbook-s9d2/`。全段を 1 本の script（`all-s9d2.sh`）で通した。contracts への push はしていない。
- 窓：07:42〜09:49 JST（build 11 分、setup 15 分、chain 1 時間 41 分）。grimodex-b1 に開始と終了を連絡した。

## 2 結果（すべて実 G-case）

| 段 | 結果 |
|---|---|
| build・setup 13・V-10（2 版） | すべて ok（V-10 は 13/13） |
| SP-P4 | passed（8 variant `same:true`。7272ad50 の driver でも通った） |
| trace-editing・trace-browsing | valid |
| parity（12 variant） | completed。窓 12/12 true、problems 0 |
| Gold（13 variant） | completed。窓 13/13 true、problems 0、V-10 の停止なし |
| N2・N3・N4 | completed。3 本とも measured・valid・`outcome: established`、problems 0 |
| G-01 の e2e の診断 | 9 つの到達点をすべて通過（`allReached: true`）。判定に数えない |
| 台帳 | 8 件（期待どおり） |

## 3 S6 の集計（dev の写し。規則と閾値は正式と同じ）

- 束縛：受領書 13＋12＋3 と台帳 8 件を照合した。SOURCE_PINS（54 件）は、dev の例外の 2 path を除いて一致した。例外の 2 path は ok で開示している。
- **Gold の pool**（9 variant、270 sample）
  - 表示 270、見逃し 0（許容は floor(0.01×270)＝2）。
  - 表示 0 の variant は無い（holdCases 0）。
  - first-render は 248、follow-up は 22（G-07 は 9／21、G-04 は 29／1）。
- **trace**（両方の読みを並べる。s7r2 の S6 README の §3 (b) と同じ形）

| trace | K6/2 の読み（受領書の記録） | K6/4 の読み（keep test の証拠つきで再計算） |
|---|---|---|
| editing | 失効 0、窓外 8／201（超える） | 失効 0、窓外 0／201。first-render 193、follow-up 8 |
| browsing | 失効 0、窓外 27／201（超える） | 失効 0、窓外 0／201。first-render 174、follow-up 27 |

  - keep test は 8 件 pass（`candidate-test`、head `8bd2cbb9`）。基準の再現（`recompute-trace-base.mjs`）は、受領書の要約と一致した。
  - q1 の最大は、editing 47.2 ms、browsing 77.9 ms。どちらも `T_late` 100 ms 以内。
  - start seal は両方とも current 201、dirty・missing・unknown 0。
- **規則の当てはめ**（s7r2 の S6 README §2 の規則。判定ではなく、規則が指す先を統合者が読んだもの）
  - 定常状態の欠落：0／270、許容 2 → 超えない。表示 0 の variant も無い。
  - trace の窓外率：K6/4 の読みでは 0／201 が 2 本 → 超えない。K6/2 の読みでは 8／201 と 27／201 で超える。
    - K6/4 の読みを当てるのは、s7r2 と同じく、事前登録の規則 (2) が読み替えを定めているため。
  - trace の失効率：0／201 が 2 本 → 超えない。`[precheck]` にも当たらない。
  - `contributedNotCounted`：0。
  - **規則は HOLD を指さず、`[precheck]` にも当たらない**（s7r2 と同じ向き）。
  - これは dev の読み。Lane unlocked と「可用性を満たした」の確定は、ユーザー本人の確認に残る。
- **trace の値は 1 回では安定しない**（開示）
  - s9d1 と s9d2 で、browsing の graph-late は 126 と 27 だった（editing は両方とも 8）。数は受領書の記録（K6/2 の読み）。
  - 条件の差：候補は `2100722a` と `8bd2cbb9`（後者は前者の子孫で、差は harness の 3 file〔S5 admission の例外、driver の観測の失敗時の記録、その試験〕だけ。trace の経路と製品のコードは同じ）。時刻（01:58 と 07:42 の開始）と他セッションの負荷は揃えていない。
  - start seal も窓の評価（clean）も同じ。差の原因は切り分けていない。
  - **K6/4 の読みでは、両方とも失効 0・窓外 0**（s9d1 も 2026-11-18 に同じ道具で再計算した。`records/s6-aggregation-s9d1/`。keep test 8 件 pass、head `2100722a`）。126 と 27 は、K6/4 の読みでは follow-up の表示（`followUpDisplayed`）の数で、規則の窓外には数えない。振れは、規則が使わない読みの中にとどまる。

## 4 品質判定 v3（補助。実装 `1dd6fb35`、事前登録 v3 `160f5fa5`）

- 全体は **hold**（`held-required-items`、`unverified-required-items`）。s7r2 は `unverified-required-items` だけだった。

| 条件 | s9d2 | s7r2（参考） |
|---|---|---|
| G-01 の事前指定の改善 | pass（Graph recall 1.0／nDCG 0.631） | pass（同じ値） |
| macro の非回帰 | not-evaluable（G-case 13 は pass。既存 24 件の Graph arm が無い） | 同じ |
| Hybrid p95 ≤ 94.2 ms | pass（Graph arm 59.70 ms、R+IR 26.00 ms、n=390） | pass（60.10／26.10 ms） |
| Evidence 100％ | **hold** | not-evaluable |
| 禁止寄与 0 | not-evaluable（(a)(b) は pass、(c) は受領書に無い） | 同じ |

- **Evidence の hold の中身**
  - v3 の 4 項目のうち、`utf16-range`・`explicit-pin-association`・`added-scene-body-anchor` と edge の束縛は pass。
  - **`raw-excerpt-unchanged` だけが hold**。6 variant で、hold の理由は全件 `first-render-has-no-child-to-compare`（G-07 は 9 件、ほかは各 30 件）。
- **これは事前登録 v3 に登録された扱いで、ユーザーは確定のときに承知している。新しい伺いではない。**
  - v3 §2.3（:135、:143）は、「子が無い first-render」を「比べられない」とし、hold に数える。
  - 実装（`quality-evidence-items.mjs` の `rawSample`）は、表示側が first-render の sample を一律に hold にする。G-07 の hold 9 件は、first-render の 9 件と一致する。
  - §11 の最終確認の文面（ユーザーが承認した 1 問）にも、「子の無い first-render は、この 4 項目では保留と数えます」「全体の判定は合格になりません」とある。
  - 開示：§2.0（:58）の「D8 の first-render の扱い」の括弧書き（v2 D8 が fail にする sample）は、出力の「D8 親の合流の寄与：pass」と字面が合わない。§2.3 の「子が無い first-render は比べられない」が上位の定めと読んだ。この字面の差は、統合者の読みとして記録する。
  - 帰結：Graph が first-render で表示されるほど、この項目は hold になる。s9d2 の first-render は 248／270 なので、正式 run でも同じ理由で hold になる見込みが高い。
  - s7r2 の「not-evaluable」は旧実装（v2 の形）で、v3 の 4 項目がまだ無かったため。hold は後退ではない。
- 判定の `--verify` は `bindings match`。

## 5 言えること／言えないこと

- **言えること**
  - 9 回目の S4 の harness と SHM の直しで、K6/7 の連鎖は実 G-case で最後まで走る。
    - 止まったのは S5 admission の pin の照合だけで、これは凍結で新しい pin を足せば消える種類の停止。
  - この候補の製品（master 01dd6821 と同じ）で、S6 の規則は HOLD を指さない。
  - 品質判定 v3 では、`raw-excerpt-unchanged` が構造的に hold になる。
- **言えないこと**
  - 正式の判定。dev の例外の入った候補で、台帳外のため。
  - 正式 run で同じ値が出ること（1 回の測定）。
  - 既存 24 件の Graph arm と、禁止寄与 (c)（今回も受領書に無い）。

## 6 最後の凍結に持ち越すこと

1. driver の新しい pin（7272ad50）を足し、S2 を取り直す（impl.md §6）。dev の例外の枝は使わない。
2. 品質判定 v3 の `raw-excerpt-unchanged` は、正式 run でも登録どおり hold になる見込み。扱いを変えたいときだけ v4 になる（ユーザーの判断。統合者からは提案しない）。
3. 既存 24 件の Graph arm と禁止寄与 (c) は、今回も not-evaluable のまま。

## 7 道具の初回の通過（開示）

- S6 の集計の script（K6/7 版）は、実物の受領書で初めて最後まで通った。s9r1 版との差は、run 名・候補・worktree の機械的な置き換えと、2c の pin の照合の dev の例外（`devPinExceptions` に開示）だけ。
- 品質判定 v3 の CLI も、実物の受領書で初めて通った。正式の手順に効く点を 2 つ踏んだ（records-template §E に追記した）。
  - CLI は候補の worktree から回す。実装の commit の worktree から回すと、古い定数で `[precheck]` になる。
  - v2・v3 の file は、contracts の git の中の path を指す。

## 8 記録の置き場

- 受領書・台帳・記録：`records/`（`gold-s9d2-1/`、`parity-s9d2-1/`、`negatives-s9d2-1/`、`sp-p4-s9d2-1/`、`traces-s9d2-1/`、`g01-e2e-s9d2-1(-report)/`、`attempts-final-s9d2/`、`setups-s9d2/`）。
- S6 の集計：`records/s6-aggregation-s9d2/`（`aggregate.out`、`trace-k64-recompute.json`、scripts）。
- 品質判定：`records/quality-verdict-s9d2-1/`。
- worktree：`cp4-dev-s9d2`（`.artifacts/cp4/`）。枝は `claude/cp4-s9d2-dev`。
