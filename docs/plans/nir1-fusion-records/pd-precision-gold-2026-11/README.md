# 融合の枠の候補の precision を測る小さな Gold：道具（事前登録 第 1 版 §11）

事前登録：`preregistration-v1.md`。この dir に置くものは**本文を含まない**（位置・層・ラベル・計算値だけ）。
Scene の本文は `/home/grimodex/fusion-eval-data/pd-2026-11/`（repo の外）にだけ置く。

## 置いたもの

| file | 役割 |
|---|---|
| `scripts/agg-pg.mjs` | `selection`（層・選択・候補）、`aggregate`（precision・Wilson・κ・arm・判断規則 §7）、`compare`（run 2 の run 間の差。§5）。関数 `jaccard`・`compareRuns`・`failureImpact`・`runPrecisionDelta`・`unionLabelMaps` |
| `scripts/agg-pg.test.mjs` | 第 6 版 records での枠 1 の再現（138 sample、不一致 0）、層の大きさ、選択の決定性、統計の既知の値、arm |
| `scripts/pg-common.mjs` | 表示・AI 注釈の共通部分（repo 外の確認、scenes の読み込み、prompt の取り出し） |
| `scripts/render-annotation-sheet.mjs` | 注釈の表示（匿名 ID・既出は参照のみ）を repo の外に作る／記入済みの表示を注釈 file に取り込む |
| `scripts/annotate-ai.mjs` | AI 注釈（OpenRouter `openai/gpt-6-luna`）。`--dry-run` で送信範囲だけ出す |
| `scripts/pg-tools.test.mjs` | 表示・AI 注釈の試験（合成の Scene、偽の fetch、偽の fetch を差した子 process。通信しない） |
| `annotation-prompt.md` | 注釈の prompt（設問・類型の文面・出力形式）。sha256 を記録して固定 |
| `selection-run1.json` | run 1（第 6 版の既存 run）の選択。種 `2026-11-06-precision-gold-1` |
| `records-m-ja-2-run2.json`・`records-g-ja-1-run2.json` | run 2 の records（本文なし。「run 2」の節） |
| `selection-run2.json` | run 2 の選択（run 1 と同じ query、候補は run 2 から取り直し、run 1 に無い組に `newPair`） |
| `run-comparison.json` | run 1・run 2 の差（query ごとの Jaccard、層ごとの中央値、新しい組・失った組の一覧、抽出失敗・時間切れの影響） |

試験：`node --test scripts/*.test.mjs`（Node 24 で確認。cargo・Electron・install は要らない）。

## 手順

```
# 1. 選択（run 1）
node scripts/agg-pg.mjs selection --records m-ja-2=../pd-ir-slot-2026-11-06/records-m-ja-2-v6.json \
     g-ja-1=../pd-ir-slot-2026-11-06/records-g-ja-1-v6.json --out selection-run1.json
# run 2：同じ query で、新しい records から候補を取り直し、run 1 に無い組に newPair を付ける
node scripts/agg-pg.mjs selection --records m-ja-2=<run2 records> g-ja-1=<run2 records> \
     --fixed-from selection-run1.json --prior selection-run1.json --out selection-run2.json
# run 1・run 2 の差（Jaccard・新しい組・抽出失敗／時間切れの影響）
node scripts/agg-pg.mjs compare --selection1 selection-run1.json --selection2 selection-run2.json \
     --records1 m-ja-2=../pd-ir-slot-2026-11-06/records-m-ja-2-v6.json g-ja-1=../pd-ir-slot-2026-11-06/records-g-ja-1-v6.json \
     --records2 m-ja-2=records-m-ja-2-run2.json g-ja-1=records-g-ja-1-run2.json --out run-comparison.json

# 2. ユーザーの注釈：表示を作る → 記入 → 取り込む（注釈中は selection と sheet-key.json を開かない）
node scripts/render-annotation-sheet.mjs --selection selection-run1.json --annotator user
#   → /home/grimodex/fusion-eval-data/pd-2026-11/precision-gold/sheet-user.md、sheet-key.json（本文を含む。repo の外）
#   候補 0 件の query は sheet に出さず、有効 query から外す（selection には残る）。
node scripts/render-annotation-sheet.mjs --ingest <記入済み sheet-user.md> --key <sheet-key.json> \
     --annotator user --out annotations-user.json

# 3. AI 注釈（--dry-run の後、§8 の確認の記録が揃ってから）
node scripts/annotate-ai.mjs --selection selection-run1.json --dry-run
#   dry-run が通信するのは単価の取得（OpenRouter の公開 API への key なしの GET 1 回）だけ。止めるなら --no-price-fetch（単価は仮定値＝未確認と表示）
node scripts/annotate-ai.mjs --selection selection-run1.json \
     --out-dir /home/grimodex/fusion-eval-data/pd-2026-11/precision-gold --state <repo 外の jsonl> \
     --privacy-record <json> [--key-file <path> | --product-key-store <ai-keys.json>]
#   → <out-dir>/annotations-ai.json（1 回目＝注釈）、annotations-ai2.json（2 回目＝安定性）
#   §4 の独立性：**ユーザーの注釈の取り込み（手順 2 の --ingest）が終わるまで、AI の注釈は repo（contracts）に置かない**。
#   --out-dir と --state が repo の内側なら止まる。未完了の組があっても file は書かれ（meta.missing・meta.complete=false）、
#   exit code は 1。再開は同じ command（完了済み・試行を使い切った組は送り直さない）。

# 3b. ユーザーの取り込みが終わったら、AI の注釈を contracts に写す（本文・応答の本文は含まない）
cp /home/grimodex/fusion-eval-data/pd-2026-11/precision-gold/annotations-ai*.json .   # annotations-user.json も同様
sha256sum annotations-*.json >> SHA256SUMS   # 既存の行を残して足す

# 4. 集計
node scripts/agg-pg.mjs aggregate --selection selection-run1.json --user annotations-user.json \
     --ai annotations-ai.json --ai2 annotations-ai2.json --out aggregate-run1.json
```

## 注釈 file の形式（`fusion-slot-pg-annotations/1`）

```json
{
  "schemaVersion": "fusion-slot-pg-annotations/1",
  "annotator": "user",
  "selectionSha256": "<selection file の sha256。省略可。あれば一致を検査>",
  "meta": { "任意": "model・prompt の sha256 など（本文なし）" },
  "labels": [
    { "work": "m-ja-2", "queryPosition": 18, "candidatePosition": 3, "label": "strict" }
  ]
}
```

- 組は (work, queryPosition, candidatePosition)。selection に無い組・重複・不正な label は拒否する。
- label は `none`（0）／`partial`（partial のみ）／`strict`。strict は partial にも数える（§4）。
- 注釈者の別は `--user`（主）／`--ai`（AI の 1 回目）／`--ai2`（2 回目）。`both`／`either` は両者が付けた組だけが分母。

## 表示の作法

- 質問・候補の順序は `sha256(seed|"sheet-query"|作品|位置)` ／ `sha256(seed|"sheet-cand"|作品|query|候補の位置)` の昇順で固定。
  作品 key・位置・由来（IR／Raw）・順位は表示しない（`Q07`、`Q07-C3` の名前だけ）。対応表は repo 外の `sheet-key.json`。
- **匿名 ID**：Scene ごとに `sha256(seed|"anon"|作品 key|位置)` の先頭 6 桁。由来・順位・query に依らず、IR と Raw で形も同じ。
  ID と（作品・位置）の対応は `sheet-key.json` だけ。今の Scene も候補も同じ規則で、同じ Scene は同じ ID。
- 本文は全文を引用（`>`）で並べる（抜粋にしない）が、**同じ ID の 2 回目以降は本文を繰り返さず**「→ ID xxxxxx（既出：Q03-C2）」だけを置く
  （初出は sheet の順：query の順、各 query で今の Scene → 候補の順）。判定は `判定:` の後に s／p／n。
  run 1：57 query・269 候補、Scene の出現 326 回・異なる Scene 112 件・参照 214 件、約 23 万字。
- 候補 0 件の query（run 1 は 3 件、すべて short-le30）は sheet に出さず、有効 query にも数えない（selection には残す）。
  対応表の `excludedQueries` に記録する。
- sheet の先頭に読み方（ID の意味、既出の参照、記入の仕方、注釈中は selection と sheet-key を開かない）を書く。
  候補の件数（IR は rank 1〜3 の最大 3 件、Raw は rank 6〜8）から出どころを推測しうるため、注釈中は selection と sheet-key を開かない。
- 表示の形の変更（匿名 ID・既出の参照・候補 0 件の除外）は事前登録 §8（表示は repo の外）の範囲内で、測る前の変更。

## AI 注釈の作法

- 1 組 × 2 回（run 1 は 269 組 × 2 ＝ 538 回）。2 つの Scene を `<current_scene>`／`<candidate_scene>` で囲んだデータとして渡し、`{"label":…}` だけを返させる。
  応答の本文・key は保存しない（state の jsonl も label・model・provider・token 数だけ）。
- key の経路は評価の harness（`ir-slot.mjs`）と同じ：`--key-file`（既定 `~/.config/grimodex-eval/openrouter.key`、権限 600）、
  または `--product-key-store`（Electron の `product-key-to-fifo.mjs` が safeStorage から復号して FIFO で渡す）。値は表示・記録しない。
- 送信範囲：endpoint `https://openrouter.ai/api/v1/chat/completions`、body は `model`・`messages`（system＋user）・`max_tokens`（4096）・`provider` だけ。
  header は `Authorization`・`Content-Type` に加え、`HTTP-Referer`（`https://github.com/kazormia296/Grimodex`）と
  `X-Title`（`Grimodex precision gold annotation`）を送る。messages に作品 key・位置・pairId・由来は入れない（試験で確認）。
- 費用：dry-run が `GET /api/v1/models/openai/gpt-6-luna/endpoints`（key 不要）から単価を取り、endpoint 間の最小・最大を出す
  （見積りは最大）。推論 token は 1 回 1,000 と仮定（推測）、`upperBoundUsd` は全回が `max_tokens` まで使った場合。取れなければ仮定値で「未確認」と出す。
- 失敗の扱い：1 回の HTTP 要求は 120 秒で中断（`AbortSignal.timeout`）。例外・4xx・timeout は本文なしで state に
  （status・error の種類・pairId・attempt だけ）記録し、組ごとに最大 3 試行（再開をまたいで数える。送信の開始を送る前に記録する）。
  429／5xx は 1 試行の中で最大 3 回再送。401／402／403 は run を止め、試行に数えない。
- 要求に `provider: {"data_collection":"deny"}` を付ける（入力を保存・学習に使う provider を除く）。§8 の account 設定の確認の代わりではない。
- 実送信は `--privacy-record`（§8 の確認の記録：checkedAt／accountSetting／providerTerms／checkedBy）が無いと始まらない。

## 事前登録の文面で曖昧だった点（この道具での決め方）

1. 「Raw の rank 6〜8」の順が製品の Raw の rank と一致するか：**確認済み**（`fuseNir1RelatedScenes` が `rank1: index+1` を付け、
   records 696 sample で IR 以外の行の順が `rawPositions` と一致）。records の `rawPositions` の添字 6〜8 番目を使う。
2. 層の「前の Scene ≤30」は `priorScenes ≤ 30`（`priorScenes = position − 1`）。「満杯」は Raw の件数が 8。
3. 「足りない層は他方で埋める」：不足分を、余りのある他方の作品が hash の続きの順で取る（総数は 15）。
4. 「IR が Raw 外に 2 件以上持つ」は、probe の `admittedPositions` のうち query より前で Raw に無いものの数（§2 の 109／112 と一致）。
5. §7 の「同じ query の Raw の rank 6〜8（合計）」との比較：rank r の IR の組と Raw の組を**両方持つ query だけ**で、プールした precision の差。
   bootstrap は query を復元抽出（B=10000、percentile 95％、乱数は seed 由来で固定）。
6. §7 の判断は主の注釈（ユーザー）の strict で出す。AI・both・either は同じ規則の参考値として併記。
7. D0 相当の「有効 query」は、probe が available で、**候補が 1 件以上あり**、**渡された注釈者（ユーザー・AI）の全員が全ての組を付けた** query
   （候補 0 件の query は §7 の「候補を取れ」に当たらないので外す。run 1 は 60 → 57。D0 の閾値 40 には影響しない）。
   「候補を取れなかった query」は probe が available でない query。κ はユーザー対 AI の strict。AI の注釈が無いと κ が出せず判断不能になる。
8. rank ごとの注釈済みの組が 30 未満の rank は、その rank を `indeterminate` とし、k はそこで止める（k は「以上」としか言えない）。
9. AI の 2 回目の「同じ prompt」の temperature 等は §4 に無い。指定せず model の既定に任せる（`max_tokens` は 4096）。
10. arm の「足した行の precision」は注釈済みの組だけ。未注釈の追加行は `unannotatedAdds` に数える。
11. run 2 の Jaccard・新しい組は `compare`（`run-comparison.json`）で出す。rank ごとの run 間の差は注釈の後なので、関数 `runPrecisionDelta`
    （各 run の組の precision、新しい組だけの precision、差＝run 2 − run 1。区間は付けない）と `unionLabelMaps` だけを用意し、試験は合成の既知値。
12. bootstrap の seed 文字列は、判断規則（§7）と `paired` の strict で同じ（`${seed}|bootstrap|${variant}|strict|ir${r}`）。
    測る前の統一で、判断規則の区間と paired の区間が一致する。
13. `PREREG_PATH` は contracts の `preregistration-v1.md` を指す（repo 外の原本と sha256 が同一）。
14. **Jaccard の定義**（事前登録に式の記載は無い）：query ごとに、候補（IR の Raw 外 rank 1〜3 と Raw の rank 6〜8）を **Scene の位置の集合**として
    |∩|/|∪|。rank・由来は問わない（同じ Scene が rank 1→2 に動いても共通）。両方空の query は定義できないので `null` にして中央値から外す。
    Raw の候補は run 間で同一（下記）なので、全候補の Jaccard は IR だけの Jaccard より高く出る。両方を出し、主は全候補（事前登録の「候補集合」）とする。
15. **新しい組の割合の分母**：run 2 の候補の組の総数（271）。失った組（run 1 にあって run 2 に無い）は別に数える（75／run 1 の 269）。
16. 「probe が available でない query は候補を取れない」の読み方：候補（IR）は probe の `admittedPositions`（deadline なし）から取るので、
    probe が available でない query は IR の候補が空になる（Raw の候補は残る）。run 1・run 2 とも**全 116 query で available**（選んだ 60 でも 0 件）。

## run 2（事前登録 §5）

### 起動の条件

- 事前登録 第 1 版（sha256 `3934f6ca…`）、build-ir-24、評価 harness `9930ab64`、model `claude-sonnet-5-5`（Anthropic の API だけ）、D=40 ms。
  records の `harness`・`build`・`models` は第 6 版の records と**完全に同じ**（JSON の一致を確かめた）。作品は m-ja-2・g-ja-1（日本語だけ）。
- 起動 script `run-ir-main-pg2.sh`（repo の外。sha256 `29ce24d8…`）は `run-ir-main-v6.sh`（sha256 `e111f62a…`）の写しで、差分は事前登録の path と sha256、
  出力の名前（`main6-*` → `pg2-*`）、進捗 log の名前、コメントに加え、**起動前に重い job（rustc・cargo build/test・vitest・local-ci-xvfb）が走っていれば止まる検査 1 行**。
  事前登録 §8 は「path と sha256 だけを変える」としたが、この検査は §8 の隔離の条件（重い job が止まってから）を script に写したもので、測定の中身には触れない。
- 実行：2026-11-06T14:34:55Z〜19:49:25Z（m-ja-2 約 2 時間 19 分、g-ja-1 約 2 時間 55 分）、exit 0。records の費用の見積り（cache 割引を数えない）は m-ja-2 約 $8.08、g-ja-1 約 $8.96（計約 $17）。
- records の出力は `…/runs-ir/pg2-{m-ja-2,g-ja-1}/records.json`（repo 外）を本 dir に `records-{m-ja-2,g-ja-1}-run2.json` として写した（`records.in-progress.json` ではない）。
  status は m-ja-2 が `complete`、g-ja-1 が `complete-with-failures`。
- 写す前に第 6 版の `obs-v6.mjs` の `stringAudit` と同じ規則で点検した（結果は下）。

### 本文の混入の点検

4 本（第 6 版の 2 本と run 2 の 2 本）で結果が同じ形：日本語を含む文字列は 12 件で、すべて `$.ai.*`・`$.design.*`・`$.costEstimateUsd.priceAssumption.source` の設計の説明。
secret らしい値は 0。疑わしい key 名は `inputTokens`・`outputTokens`・`secretBefore`・`storeHasApiKey` の 4 つで、いずれも件数・真偽値（本文でも key でもない）。
60 字以上の文字列は m-ja-2 が 25（path 2、sha256 14、design 9）、g-ja-1 が 35（同 25＋extraction の `errorShape`／`errorChain.chain[0].message` 10）。この 10 は
抽出の失敗の記録で、中身は SQL の列名の並び（`Failed query: select "id", "project_id", …` を 240 字で切ったもの）と `Snapshot build failed: SNAPSHOT_*` の固定の文だけ（Scene の本文ではない）。
第 6 版の g-ja-1 にも同じ種類が 2 件ある。試験でも「日本語の文字列は ai／design／costEstimateUsd だけ」を検査する。

### 結果の概要

| | m-ja-2 | g-ja-1 |
|---|---|---|
| 抽出 | 117/117（失敗 0） | 106/117（失敗 11：位置 64・67・70・76・83・91・93・95・98・111・114） |
| IR の時間切れ（sample） | 0 | 27（100% 地点の 87 sample 中。16 query、位置 92 以降） |
| 枠の使用（slot-used／分母） | 81/90（0.900） | 57/69（0.826） |
| 第 6 版（run 1） | 抽出 117/117、時間切れ 0、81/90 | 抽出 106/117（失敗 10：位置 65・72・74・78・84・94・96・100・102・109）、時間切れ 33、57/69 |
| probe | 全 116 query で available | 全 116 query で available |

「IR の時間切れ」は sample の `irStatus` が `unavailable` のもの（records の summary の `ir-timeout` と一致）。m-ja-2 run 2 には `irStatus: empty` の sample が 3 件（位置 5 の query。IR が空で、時間切れではない）。

### run 間の差（`run-comparison.json`）

- 選んだ 60 query は run 1 と**完全に同じ**（作品・位置・層・hash・順序。試験で確認）。層の不一致 0。Raw の候補（rank 6〜8、113 組）は run 間で**同一**。
- 候補の組：run 1 が 269、run 2 が 271（IR 156→158、rank 別は ir1 55→55、ir2 54→53、ir3 47→50。Raw 113→113）。共通 194。
  **新しい組（run 1 に無い）77／271＝28.4%**（すべて IR。rank 別 ir1 20/55、ir2 24/53、ir3 33/50。作品別 m-ja-2 45・g-ja-1 32。層別 full-le30 15・full-gt30 32・short-le30 8・short-gt30 22）。
  失った組（run 1 にあって run 2 に無い）75／269＝27.9%。共通の 194 組のうち rank が動いたもの 39。新しい組がある query は 44、無い query は 16。
- query ごとの Jaccard の中央値（全候補。n は定義できた query 数）：全体 **0.500**（n=57）。層別：full-le30 0.714（15）、full-gt30 0.500（15）、short-le30 0.800（12）、short-gt30 0.429（15）。作品別：m-ja-2 0.500（33）、g-ja-1 0.667（24）。
- IR だけの Jaccard の中央値：全体 **0.500**（n=55）。層別：full-le30 0.500（14）、full-gt30 **0.200**（15）、short-le30 0.500（11）、short-gt30 **0.250**（15）。作品別：m-ja-2 0.375（32）、g-ja-1 0.500（23）。
  分布（全候補）：1.0 が 11 query、0 は無く、null が 3（候補 0 件の query）。IR だけでは 1.0 が 9、0 が 7、null が 5。
- 読み：IR の rank 1〜3 は run 間で約 3 割しか重ならない層（full-gt30、short-gt30）がある。確率性は Wilson の区間に含まれない（§5）ので、precision の区間は run 間の変動を過小に見せうる。
  rank が上がるほど新しい組が多い（ir1 36%、ir2 45%、ir3 66%）。

### g-ja-1 の抽出の失敗・時間切れが候補に与える影響

候補は IR が probe の `admittedPositions`、Raw が `rawPositions`。時間切れ・失敗が効く経路を records で確かめた（`run-comparison.json` の `failureImpact`）。

- **probe が available でない query**：0（run 1・run 2、全 116 query）。available でなければ IR の候補は取れない定義だが、該当は無い。D0 (4)（取れなかった query 10％ 超）に効かない。
- **IR の時間切れ（27 sample／16 query）**：サンプルの IR の行だけに効き、候補（probe は deadline なし）には効かない。選んだ 60 query に時間切れの sample を持つものは **0**
  （時間切れは位置 92 以降。g-ja-1 の選んだ query の最大位置は 85）。run 1（33 sample／21 query）も同様に 0。
- **抽出の失敗（11 件）**：失敗した Scene は IR の索引に載らず、`admittedPositions` に**出ない**（全 query で 0 件を観測）ので IR の候補になれない。Raw は本文の検索なので失敗した Scene も候補になりうる
  （選んだ query の Raw 候補に 1 件。run 1 も 1 件）。失敗位置の最小は 64（run 2）、65（run 1）。選んだ g-ja-1 の 26 query のうち、失敗した Scene より後ろにあるのは **5**（位置 68・75・76・82・85。run 1 も 5）で、
  query 自身の Scene が失敗したのは run 2 で 1（位置 76）。run 1 の IR の組 66 のうち run 2 で失敗した Scene にあたるのは 1、run 2 の新しい IR の組 32 のうち run 1 で失敗していた Scene にあたるのは 0。
  → 失敗・時間切れは新しい組の割合をほとんど動かさない（g-ja-1 の新しい組 32 の主因は抽出の LLM の確率性＝提案の違い）。ただし**位置 86〜117 の query は g-ja-1 では無作為に 1 件も選ばれていない**ので、
  失敗・時間切れが多い終盤の候補の正しさは、この測定では言えない（m-ja-2 の選んだ最大位置は 114）。
- m-ja-2：抽出の失敗 0、probe 全 available、時間切れ 0。影響なし。
- 3 query（m-ja-2 位置 4、g-ja-1 位置 2・5。すべて short-le30）は run 1・run 2 とも候補 0 件で、sheet に出さず有効 query にも数えない。IR の候補が 0 の query は 5（上の 3 と、Raw だけの 2）。

### 注釈の追加（新しい組だけ）

- run 2 の追加分は**新しい組 77 だけ**（44 query）。run 1 の注釈（sheet-user.md）はそのまま使う。sheet は repo の外 `sheet-user-run2.md`（約 2.4 万字）。
  `render-annotation-sheet.mjs --selection selection-run2.json --additions-of selection-run1.json --annotator user`。質問は `R01…`、候補は `R01-C1…`（run 1 の Q01… と区別）。
  匿名 ID は run 1 と同じ規則（Scene だけから決まる）なので、同じ Scene は同じ ID。**前の sheet に出た Scene は参照だけ**（「→ ID xxxxxx（既出：前の sheet の Q03-C2」）。
  本文を出すのは前の sheet に無い Scene 7 件だけ。異なる Scene は 69、出現 121＝本文 7＋参照 114（前の sheet への参照 109、この sheet 内の参照 5）。
- 対応表 `sheet-key.json`（repo 外）は schemaVersion `fusion-slot-pg-sheet-key/2` のまま、run 1 の部分を変えずに `run2Additions`（run 2 の selection の sha256、queries、新しい組が無い query）を足した。
  更新前の対応表は `superseded-20261106/sheet-key.pre-run2.json` に残す。run 1 の sheet は同じ command で**1 byte も変わらず再現**することを確かめた。
- 取り込み：`--ingest <記入済み> --key sheet-key.json --key-section run2Additions --annotator user --out annotations-user-run2.json`。取り込んだ file の `selectionSha256` は run 2 の selection のもの。
  run 2 の集計は run 1 の注釈（run 1 の selection に対して検証）と追加分を `unionLabelMaps` で 1 つにして `runPrecisionDelta` に渡す。
- **AI 注釈の追加は未実施**（依頼の範囲外）。新しい組 77 件だけを AI（gpt-6-luna）に送るなら、新しい組だけの selection を作って `annotate-ai.mjs` を使う（送信範囲の増分は §8 の確認の範囲内かを別に確かめる）。

### 曖昧な点・言えないこと

1. **追加分の sheet は候補がすべて IR 由来**（新しい組はすべて IR。Raw は run 間で同一）。ID・順序は隠しても、追加分の候補はすべて IR だと読める。
   run 1 の注釈は由来を伏せたまま付けたのに対し、追加分は「IR の候補」と知った上で付けることになり、先入観の方向は分からない。run 1 の Raw の組を混ぜて隠す案は
   「新しい組だけ」（§5）に反するので採らなかった。結果の読みでは run 2 の新しい組だけの precision（`newOnly`）を別に出し、この差を注記する。
2. 同じ Scene・同じ query の組は run をまたいで 1 組（§3）なので、run 1 で付けた label は run 2 でもそのまま使い、rank が動いても label は変えない。
3. Jaccard・新しい組は「Scene の位置」の同一性で、rank の入れ替わりは差に数えない（共通の組のうち rank が動いたもの 39 は別に記録）。
4. 新しい組の割合には、LLM の確率性（抽出の提案の違い）、抽出失敗の位置の違い、IR の並びの境界での入れ替わりが混ざる。原因の分解はしない。
5. run 間の差の区間・検定は出さない（2 run は同じ条件の取り直しで、確率性の全体は測れない：§10）。
