# 融合の枠の候補の precision を測る小さな Gold：道具（事前登録 第 1 版 §11）

事前登録：`preregistration-v1.md`。この dir に置くものは**本文を含まない**（位置・層・ラベル・計算値だけ）。
Scene の本文は `/home/grimodex/fusion-eval-data/pd-2026-11/`（repo の外）にだけ置く。

## 置いたもの

| file | 役割 |
|---|---|
| `scripts/agg-pg.mjs` | `selection`（層・選択・候補）と `aggregate`（precision・Wilson・κ・arm・判断規則 §7） |
| `scripts/agg-pg.test.mjs` | 第 6 版 records での枠 1 の再現（138 sample、不一致 0）、層の大きさ、選択の決定性、統計の既知の値、arm |
| `scripts/pg-common.mjs` | 表示・AI 注釈の共通部分（repo 外の確認、scenes の読み込み、prompt の取り出し） |
| `scripts/render-annotation-sheet.mjs` | 注釈の表示を repo の外に作る／記入済みの表示を注釈 file に取り込む |
| `scripts/annotate-ai.mjs` | AI 注釈（OpenRouter `openai/gpt-6-luna`）。`--dry-run` で送信範囲だけ出す |
| `scripts/pg-tools.test.mjs` | 表示・AI 注釈の試験（合成の Scene、偽の fetch。通信しない） |
| `annotation-prompt.md` | 注釈の prompt（設問・類型の文面・出力形式）。sha256 を記録して固定 |
| `selection-run1.json` | run 1（第 6 版の既存 run）の選択。種 `2026-11-06-precision-gold-1` |

試験：`node --test scripts/agg-pg.test.mjs scripts/pg-tools.test.mjs`（Node 24 で確認。cargo・Electron・install は要らない）。

## 手順

```
# 1. 選択（run 1）
node scripts/agg-pg.mjs selection --records m-ja-2=../pd-ir-slot-2026-11-06/records-m-ja-2-v6.json \
     g-ja-1=../pd-ir-slot-2026-11-06/records-g-ja-1-v6.json --out selection-run1.json
# run 2：同じ query で、新しい records から候補を取り直し、run 1 に無い組に newPair を付ける
node scripts/agg-pg.mjs selection --records m-ja-2=<run2 records> g-ja-1=<run2 records> \
     --fixed-from selection-run1.json --prior selection-run1.json --out selection-run2.json

# 2. ユーザーの注釈：表示を作る → 記入 → 取り込む
node scripts/render-annotation-sheet.mjs --selection selection-run1.json --annotator user
#   → /home/grimodex/fusion-eval-data/pd-2026-11/precision-gold/sheet-user.md、sheet-key.json（本文を含む。repo の外）
node scripts/render-annotation-sheet.mjs --ingest <記入済み sheet-user.md> --key <sheet-key.json> \
     --annotator user --out annotations-user.json

# 3. AI 注釈（--dry-run の後、§8 の確認の記録が揃ってから）
node scripts/annotate-ai.mjs --selection selection-run1.json --dry-run
node scripts/annotate-ai.mjs --selection selection-run1.json --out-dir . --state <repo 外の jsonl> \
     --privacy-record <json> [--key-file <path> | --product-key-store <ai-keys.json>]
#   → annotations-ai.json（1 回目＝注釈）、annotations-ai2.json（2 回目＝安定性）

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
- 本文は全文を引用（`>`）で並べる（抜粋にしない）。判定は `判定:` の後に s／p／n。

## AI 注釈の作法

- 1 組 × 2 回。2 つの Scene を `<current_scene>`／`<candidate_scene>` で囲んだデータとして渡し、`{"label":…}` だけを返させる。
  応答の本文・key は保存しない（state の jsonl も label・model・provider・token 数だけ）。
- key の経路は評価の harness（`ir-slot.mjs`）と同じ：`--key-file`（既定 `~/.config/grimodex-eval/openrouter.key`、権限 600）、
  または `--product-key-store`（Electron の `product-key-to-fifo.mjs` が safeStorage から復号して FIFO で渡す）。値は表示・記録しない。
- 要求に `provider: {"data_collection":"deny"}` を付ける（入力を保存・学習に使う provider を除く）。§8 の account 設定の確認の代わりではない。
- 実送信は `--privacy-record`（§8 の確認の記録：checkedAt／accountSetting／providerTerms／checkedBy）が無いと始まらない。

## 事前登録の文面で曖昧だった点（この道具での決め方）

1. 「Raw の rank 6〜8」の順が製品の Raw の rank と一致するか（§3 で未確認）。records の `rawPositions` の添字 6〜8 番目を使う。
2. 層の「前の Scene ≤30」は `priorScenes ≤ 30`（`priorScenes = position − 1`）。「満杯」は Raw の件数が 8。
3. 「足りない層は他方で埋める」：不足分を、余りのある他方の作品が hash の続きの順で取る（総数は 15）。
4. 「IR が Raw 外に 2 件以上持つ」は、probe の `admittedPositions` のうち query より前で Raw に無いものの数（§2 の 109／112 と一致）。
5. §7 の「同じ query の Raw の rank 6〜8（合計）」との比較：rank r の IR の組と Raw の組を**両方持つ query だけ**で、プールした precision の差。
   bootstrap は query を復元抽出（B=10000、percentile 95％、乱数は seed 由来で固定）。
6. §7 の判断は主の注釈（ユーザー）の strict で出す。AI・both・either は同じ規則の参考値として併記。
7. D0 相当の「有効 query」は、probe が available で、**渡された注釈者（ユーザー・AI）の全員が全ての組を付けた** query。
   「候補を取れなかった query」は probe が available でない query。κ はユーザー対 AI の strict。AI の注釈が無いと κ が出せず判断不能になる。
8. rank ごとの注釈済みの組が 30 未満の rank は、その rank を `indeterminate` とし、k はそこで止める（k は「以上」としか言えない）。
9. AI の 2 回目の「同じ prompt」の temperature 等は §4 に無い。指定せず model の既定に任せる（`max_tokens` は 4096）。
10. arm の「足した行の precision」は注釈済みの組だけ。未注釈の追加行は `unannotatedAdds` に数える。
11. run 2 の Jaccard・rank ごとの run 間の差は未実装（selection の `newPair` までは出す）。
