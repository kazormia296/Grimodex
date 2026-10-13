# NIR-1 L6〜L9 契約提案 proposal/6（draft）: 資源の上限

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-l6-l9-contract-proposal/6` |
| contractId | `graph-limited-binding`（proposal/5 の改訂）、`nir1-defensive-resource-limits`（新規） |
| 起案日と基点 | 2026-10-12。origin/master `a153743b`（Tree `023f6fbc`）。#610 は squash `13e3f6c6`。`l6-l9:N` は [L6〜L9 実行計画](nir1-l6-l9-execution-plan.md) のこの commit での行番号で、コードの行番号も同じ commit のもの |
| 確認済み baseline | `nir1-l6-l9-contract-proposal/5#graph-limited-binding`（確認を記録した #600 `146d8535` から `13e3f6c6^` まで変わっていない本文。`13e3f6c6^` の l6-l9:138-207 と resource unit 表 486-492）。2026-09-22 の B full-set 数値の追加確認（[B-close completion evidence](nir1-b-close-completion-2026-09-22.md) の Ratified numeric contract）。proposal/3・/4 の確認済み行 |
| 確認を求めるもの | #610 が台帳形式の確認なしに書き換えた proposal/5 の値（Revision 6 MiB、期限 100 ms、query の aggregate 上限の削除）の正式化と、それに伴う削除と受入れの変更。残レーンで今後追加する上限に共通の規則 |
| 変えないもの | Gold、P の固定値、proposal/3・/4 の各行、B-close の数値、Graph と local 送信の製品入口（閉じたまま）。新しい authority・schema・consumer・persistent adjacency は加えない |

## 要点

- `graph-limited-binding`: 資源の上限を、壊れたデータや巨大なデータに対する防御に絞る。Revision は `512 records`／`6,291,456 B`、C-query の per-Revision preflight は `2,097,152 B`、query は read／admission `512`、batch `16x32`、SQL `100,000 VM steps`、result lease `100 ms`、reader／busy wait `0`、2hop／12／144／8 を固定値とする。超えたら部分結果を出さず、Graph は unavailable にして R+IR に戻す。query 全体の物理メモリ上限とその証明、Native fixed-area packing、B 容量の再認定は求めない。B の whole-set は B-close の数値のままとし、超えたときに安全に失敗することだけを確かめる。
- `nir1-defensive-resource-limits`: 残レーンで今後追加する上限は、数値ごとに確認する代わりに、共通の規則（有限、取消できる、allocation の前に検査、超えたら fail-safe）に従い、integrator が実測から決めて記録する。厳しくするのは自由で、merge 後に緩めるときは再確認する。既存の確定値は対象外とする。

## 確認の扱い

- 確認は contractId ごとに、末尾の「確認文」の 1 文で行う（l6-l9:108）。1 文で確認されるのはその contractId の行だけで、もう一方の行や依存する契約は確認されない。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答は、確認として扱わない。
- どちらの行も、Graph の製品公開、local 送信、新しい authority・保存先・送信先を許可しない。Graph の製品公開条件（A3 + B + C + D2a、l6-l9:431）と、公開時のユーザー承認は残る。
- 確認された行は、この draft の bytes の SHA-256 と確認文を台帳に記録する。本文は編集せず、内容を変えるときは新しい draftRef で起案する。

## 根拠: ユーザー決定（逐語）

2026-10-12 のセッションで、構造化質問に対するユーザーの回答から、ユーザー自身の文言を写す。「読み方」は起案者の解釈で、ユーザーの発言ではない。

| ID | 質問 | 回答（逐語） | 読み方 |
| -- | ---- | ------------ | ------ |
| U2 | 「食い違い」: 承認後に #610／#611 で契約と実装が食い違った（C本文は同時 2 MiB・8 ms 前提、現行は worker 子プロセスで 100 ms lease など）のをどう扱うか | 「2MiB/8ms はキツすぎてCodexでは達成できませんでした。何かいい案があれば挑戦してもいいかもしれませんが、現状は達成不可能です。」 | query 全体の 2 MiB と 8 ms は達成できない値として契約から外し、現行の C-query（100 ms の result lease、aggregate 上限なし）を前提にする。8 ms に近づける試みは任意で、契約値を変えない |
| U6 | 「Revision上限」: #610 で共有定数が 2 MiB から 6 MiB に変わり、A2 の Revision 保存上限と B の per-Revision 入力上限も 3 倍になったのをどうするか | 「そもそもこんなにキチキチにメモリを制限している理由がよくわからん」 | — |
| U6 | 「メモリ制限」: 制限が厳しくなった理由の説明を受けた後、今後の資源契約をどうするか | 「防御用の上限だけに簡素化（推奨）」 | 壊れたデータや巨大なデータに対する上限と fail-safe だけを残す。物理メモリの証明と B 容量の再認定はやめる。6 MiB を正式化し、B は超えたときに安全に失敗することだけを確かめる。新しい資源契約として一度だけ確認を得る |

「メモリ制限」の質問で示した説明（integrator の文面）は次のとおり。

> メモリ制限が厳しくなった理由（Codex 設計の経緯）は3つです。① Related Scenes の待ち時間予算に収めるため、Graph を 8 ms で終わらせようと作業量と保持メモリを絞った。② 壊れたデータや巨大なデータ（import や貼り付け）で OOM やフリーズが起きないようにした。③ 同じユーザー権限で動く悪意のあるプロセスまで想定して『物理メモリ上限の証明』を求めた（10-04 に撤廃済み）。単一ユーザーのローカルアプリであれば、実際に必要なのは②と応答性くらいです。

ユーザーが選んだ選択肢の説明（integrator の文面）は次のとおり。

> 残すのは、壊れたデータや巨大データへの上限（Revision 6 MiB、frame/入力上限、512件、100,000 steps、100 ms）と、超えたら unavailable にして R+IR に戻す fail-safe だけ。物理メモリの証明や B 容量の再認定はやめる。6 MiB は正式化し、B については超過時に安全に失敗することだけ確認する。新しい資源契約として一度だけ確認をもらう。

## #610 の改訂経緯（記録）

proposal/5 の確認後、#610 の作業中に次の改訂が行われ、確認済みの proposal/5 の本文（l6-l9 の proposal/5 節と resource unit 表）がその場で書き換えられた。改訂は「明示改訂」「ユーザー承認済み」という叙述（l6-l9:14-18、post-B:8、enforcement draft:3）としてだけ残り、draftRef と contractId を名指した確認（l6-l9:108）はない。台帳行（l6-l9:100）は proposal/5 のままである。この draft は、これらを一つの差分として確認に出す。表の日付は JST で、commit の行は author date による（`13e3f6c6` は 2026-10-11 17:04 -0700、JST では 2026-10-12 09:04）。

| 日付 | 改訂 | 記録の状態 |
| ---- | ---- | ---------- |
| 2026-09-22 | B full-set の数値を追加確認。前提として「Revision の 512 records／2 MiB と seed-local query の契約は変えない」と記録 | 確認済み（b-close-completion:10-24） |
| 2026-09-29 | `nir610-q-default-registration-scratch/1`: worker Q `4,718,592 B`、registration S 最大 `64 MiB`、Native `1,572,864 B`、合計 `6,291,456 B` を実装境界として固定 | enforcement draft:29 の記述だけ。台帳行なし |
| 2026-10-01 | query の入力／aggregate を `2,097,152 B` から `6,291,456 B`（worker Q 4.5 MiB＋Native 1.5 MiB）へ、Native の admission→返却 result lease を `8 ms` から `16 ms` へ | 叙述だけ（l6-l9:14）。「これだけを」改訂するとし、Revision には触れていない |
| 2026-10-02 | parent admission→valid Native result lease を `16 ms` から `100 ms` へ。registration／READY と startup／retirement の待ちは含めない | 叙述だけ（l6-l9:16） |
| 2026-10-02 | 共有定数 `MAX_GRAPH_INPUT_BYTES` を `2 MiB` から `6,291,456 B` へ（commit `85898500`）。同じ定数を使う Revision validation（A2 の writer と reader、B の per-Revision admission）も 6 MiB になり、proposal/5 の Delta (1) と resource unit 表、品質試験（`scripts/quality/quality-workflow.test.mjs`）の期待値も 6 MiB に書き換えられた | ユーザー発言の記録なし |
| 2026-10-04 | query 全体の物理メモリ上限とその証明（worker Q 4.5 MiB／Native 1.5 MiB）と Native fixed-area packing を受入れ条件から削除 | 叙述だけ（l6-l9:18、post-B:8、enforcement draft:3） |
| 2026-10-12 | #610 を squash merge（`13e3f6c6`）。C-resource の受入れは HOLD のまま（l6-l9:27） | — |

## graph-limited-binding（proposal/5 の改訂）

- Baseline (approved; limited): `nir1-l6-l9-contract-proposal/5#graph-limited-binding` の確認時点の本文（`13e3f6c6^` の l6-l9:138-207、resource unit 表 486-492）と、2026-09-22 に追加確認された B full-set の数値。proposal/5 は proposal/3 の Graph binding と query の保護を保持し、資源を三つの resource unit（Revision bundle、seed-local query、whole-project B build）に分けた。Revision bundle は `512 records`／`2 MiB`、seed-local query は read／admission `512`、batch `16x32`、SQL `100,000 VM steps`（`1,000` steps ごとに取消を確認）、`2 MiB`、Graph `8ms`、reader／busy wait `0` で、閾値の変更には再確認を求める（l6-l9:152）。#610 の後の master にある 6 MiB・100 ms・aggregate cap なしの文面（l6-l9:14-18 の叙述、proposal/5 節の 147-160、resource unit 表とその本文の 494-502、post-B §6.2）は確認されていないので、baseline に含めない。Graph の製品 activation は承認されていない。
- Delta (L6-L9 resource limits; proposal/6 draft): 資源の値と、それに伴う受入れだけを改訂する。proposal/5 のその他の条項（三つの resource unit の分離、producer／index key／source kind の tuple、whole-project build の owner／lifecycle と full-roster validation、acceptance split の semantic gate、Evidence と cold reopen の受入れ、query と build の独立）は変えない。変更前後、確認後の固定値、実装上の防御上限、削除するものは下の節のとおり。要するに、Revision を `6,291,456 B` に、query の期限を `100 ms` に正式化し、query 全体の物理メモリ上限とその証明を外す。C-query の per-Revision preflight（`2,097,152 B`）と Packing の入力上限（`2 MiB`）は変えない。2〜6 MiB の Revision は、保存と A2 の読取はできても、Graph では使えない。Graph では、preflight の合計が `2,097,152 B` を超える Revision（2〜6 MiB の bundle を含む）に当たった query が拒否され、Graph は unavailable になって R+IR に戻る。Packing の `2 MiB` は、保存された Revision の bytes ではなく、準備全体の入力の合計にかかる（数え方は下の固定値の表）。このため Packing は 2〜6 MiB の Revision を保存サイズでは一律に除外せず、入力の合計が `2 MiB` を超えたときに準備全体を typed refusal にする。保存サイズで一律に除外するのは Graph だけで、Packing に同じ除外を加えることはこの行では求めない（加えるには、コードの変更と別の起案が要る）。
- Trusted actors: proposal/5 と同じ（Native／DB builder、既存 producer／source registry、A1／A2 の authority、sealed D1 head）。加えて、C-query の Native owner（parent 側で admission、期限、request と frame の検査、result lease、cleanup と quarantine を持つ）。worker binary は owner が起動する自前のコードだが、その出力は parent が検査するまで信用しない。
- Untrusted actors: proposal/5 と同じ（renderer の query／seed、catalog／Graph cache、model output、stale な generation／dependency digest、index restore）。加えて、保存データの中身と長さ（import、貼り付け、復元、DB の外部編集で壊れたり巨大になったりしうる）と、worker の出力（frame、status、終わり方、時間）。
- In-scope attacks: proposal/5 の In-scope attacks を保持し、閾値の drift の対象をこの行の固定値に置き換える。加えて、壊れたデータや巨大なデータによる OOM やフリーズ、2〜6 MiB の Revision の Graph への流入、Packing の入力の合計が上限を超えたときの部分的な pack、候補・page・SQL step の暴走、worker の hang・crash・不完全な frame・過大な frame・後続 bytes・期限後の結果、上限計算の overflow、成分 6 MiB までの Revision による B whole-set の超過と partial generation の公開、固定値を記録なしに変えること、実装上の防御上限を再確認なしに緩めること。
- Out-of-scope attacks: proposal/5 と同じ（OS／backend の侵害、意味の品質、Raw 検索の再設計、外部送信、新しい producer や material family）。加えて、同じ OS ユーザー権限で動く悪意あるプロセスによる物理メモリの枯渇（query 全体の物理メモリ上限とその証明は求めない）、プロセス全体の RSS の絶対上限、allocator や SQLite 自体の不具合、cleanup や OS の処理が `100 ms` の内に終わる保証。
- Mandatory defenses: proposal/5 の Mandatory defenses（seed／project の束縛、bounded output、current な A1／A2／Freshness／D1 tuple、atomic な sealed publish／invalidate、dirty・unknown・digest 不一致での whole-Graph unavailable、mixed generation と partial Graph の禁止、Evidence path の保持、renderer を authority にしないこと、build の owner／lifecycle、progress hook と cleanup の検証）は保持する。query の資源の保護は、下の固定値と実装上の防御上限に置き換え、次を必須にする。
  - 上限はすべて、materialize・JSON の解析・送受信の前に、件数と長さを checked arithmetic で数えて検査する。
  - 超えたら全体を拒否し、部分 Graph・partial generation・部分的な pack を出さない。Graph は unavailable（寄与 0）にして R+IR（Chronicle が止まっていれば exact R）に戻す。
  - `100 ms` を過ぎた結果、不完全な frame、terminal commit のない frame、後続 bytes のある frame、current binding と合わない結果は採用しない。startup と cleanup は `100 ms` とは別の有限の期限で区切り、cleanup を証明できなければ quarantine して claim を保持し、再利用しない。
  - 固定の領域や固定 allocator を使う箇所は、確保した元に沿って解放し、領域を取り違えたり、解放の前に再利用したりしない。
  - reader と busy を待たず、枠が使用中なら待たずに unavailable にする。取消と期限は `1,000` VM steps ごとと Rust の境界で確認する。
  - B は B-close の runtime の上限を保ち、超えたら typed refusal にして旧 sealed generation を残す。
  - 固定値の変更（方向を問わない）と実装上の防御上限の緩和は、再確認なしに行わない（l6-l9:152 の「Threshold changes require reconfirmation」を保持）。
  - query 全体の物理メモリ上限とその証明、Native fixed-area packing、B 容量の再認定は求めない。
- Acceptance implications: Positive: 512 charged records の Q512 が `100,000 VM steps` の内で、parent admission から `100 ms` の内に valid な result lease を返し、path と Evidence が独立した canonical projection と一致する（CQ-1。startup は含めない）。`512 records`／`6,291,456 B` の内の Revision は保存と A2 の読取ができ、B の whole-set の上限の内なら B build で publish される。per-Revision preflight が `2,097,152 B` の内の Revision は、通常どおり Graph に使われる。proposal/5 の正例（再 build と cold reopen の後の path と Evidence の一致など）は変えない。Negative: Revision の 513 records と `6,291,457 B` は writer が保存しない。per-Revision preflight が `2,097,153 B` 以上の Revision が seed から辿った候補にあれば、その query 全体を拒否し、Graph の寄与 0 で R+IR に戻る。Packing の入力の合計（数え方は下の固定値の表）が `2 MiB` を超えたら、保存サイズにかかわらず準備全体が typed refusal になる。513 件目の record、`16x32` を超える候補、`100,000 VM steps` の超過、`100 ms` を過ぎた結果、過大な request や frame、後続 bytes、reader／busy の競合、使用中の枠は、どれも部分 Graph を出さずに unavailable になる。成分がそれぞれ `6,291,456 B` 以下の Revision で B の whole-set の上限（例: Source 入力 `16 MiB`）を超えたときは、typed refusal になり、partial generation を出さず、旧 sealed generation を残し、Graph は R+IR に戻る。固定値の変更や防御上限の緩和を、再確認なしに merge しない。proposal/5 の負例（wrong／unknown seed、3 hop、stale・dirty・unqualified edge など）は変えない。Recovery: 拒否、取消、期限切れの後に、部分的な結果や generation を残さない。worker、reader、claim は owner が後始末し、証明できなければ quarantine する。次の query は新しく始め、B は次の owned maintenance で sealed head から作り直す。Lane unlocked if confirmed: C-resource の受入れ記録は、CQ-1〜3 の証跡と独立受入れに加えて、この行を HOLD（l6-l9:27）を解く契約上の根拠にできる。C-product と Graph 公開の資源面の根拠にもなる。Graph の製品公開には、A3 + B + C + D2a と公開時の承認がさらに要る。
- 受入れへの影響（l6-l9:620）:
  - 品質閾値: query の期限は `8ms` から `100 ms` に変わる。`100 ms` は C-query の資源上の期限で、P の固定値（B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms）とは別に扱い、P の待ち予算に足さない。Related Scenes に間に合わなかった Graph の結果は、その query に混ぜない（post-B §7.2、§7.3）。
  - 保存範囲: 1 件の Revision に保存できる量の上限が `2 MiB` から `6,291,456 B` に増える。保存先、データの種類、family（`nir1.entity-relation@1`）、authority は変えない。`typed-revision-material`（proposal/4）の行は変えず、/4 が参照する validator の byte 上限はこの行の値に従う。
  - 信頼境界: 変えない。#610 で入った worker の境界をそのまま使い、物理メモリの上限と証明の要件だけを外す。
  - 受入れから外すもの: query 全体の物理メモリ上限とその証明、worker Q と Native の物理的な収まり、Native fixed-area packing、`8ms` の正例、成分 2〜6 MiB の形状での B 容量の再認定。
  - 受入れに加える・変えるもの: Revision の N／N+1（`512`／`513 records`、`6,291,456`／`6,291,457 B`）、per-Revision preflight の N／N+1（`2,097,152`／`2,097,153 B`。超えたら query を拒否して R+IR に戻る）、Packing の入力の合計が `2 MiB` を超えたときの typed refusal（判定は保存サイズではなく入力の合計による）、Q512 の admission→lease が `100 ms` の内であることと期限後の結果の不採用、B の安全失敗の試験（成分ごとに `6,291,456 B` 以下の Revision で whole-set の上限を超えたとき）。
  - 変えないもの: Gold、P、既存の 24 件、G-01〜G-08 の判定、CQ-1〜3（閾値の値を除く）、proposal/5 の B の semantic gate、B-close の runtime の数値、A-1（Graph と送信の製品入口は閉じたまま）。
  - 可用性: B の whole-set の上限は project 全体の合計にかかる（例: 1 回の scan で admission する Source 入力 `16 MiB`）。成分が 6 MiB に近い Revision では少ない件数でこの上限に届き、build 全体が typed refusal になって、その project の Graph が unavailable になりうる（R+IR は使える）。per-Revision preflight を超える Revision が seed から辿った候補に 1 件でもあれば、その query 全体が unavailable になる。どちらもこの行で受け入れる制約で、緩めるには再確認を要する。
  - 既存のデータ: #610 の merge 後に `2 MiB` を超える Revision が保存されていても、有効な Revision として扱う（保存と A2 の読取はできる）。Graph では使えない。Packing では保存サイズで除外せず、準備の入力の合計が `2 MiB` を超えたときに準備全体が typed refusal になる。2 MiB に戻す移行はしない。

### 変更前後

| 項目 | proposal/5（確認時点） | #610 後の master 文面（未確認） | proposal/6 |
| ---- | ---------------------- | ------------------------------- | ---------- |
| Revision bundle の validation | `512 records`／`2 MiB` | `512 records`／`6 MiB` | `512 records`／`6,291,456 B` に正式化する |
| C-query の per-Revision preflight（A2・A3） | 明記なし（query の `2 MiB` の内側） | 明記なし。コードは `2 MiB`（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/input.rs:18`） | `2,097,152 B` を明記して固定する |
| query の memory | `2 MiB` | aggregate physical-memory cap／proof なし | query 全体の物理メモリ上限とその証明は求めない。入力と保持見積りの論理上限は残す |
| query の期限 | Graph `8ms` | parent admission→valid Native result lease `100 ms` | `100 ms` に正式化する。startup と cleanup は含めない |
| query のその他 | read／admission `512`、batch `16x32`、SQL `100,000 VM steps`（`1,000` ごと）、reader／busy wait `0`。不適格な行も read／admission を消費する | 同じ。input／frame／fixed-buffer の上限と checked arithmetic を維持 | 同じ。513 件目は拒否する。request と frame の上限は、固定値ではなく実装上の防御上限として明記する（下の節） |
| 意味上の上限 | 2hop／Entity 12／edge 展開 144／Scene 8 | 同じ | 同じ |
| whole-project B build | 数値は測定の後（B-close で確認） | 同じ。測定は成分 2 MiB 未満の形状 | B-close の数値を維持する。成分 6 MiB までの Revision で超えたときに安全に失敗することだけを確かめ、容量は再認定しない |
| Packing の入力 | この行の対象外（実装は `2 MiB`） | `2 MiB` のまま | この行では変えない（`2 MiB`）。準備全体の入力の合計にかかり、保存された Revision の bytes にはかからない（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_packing.rs:413-435`、`838-843`、`1891-1898`）。保存サイズで一律に除外するのは C-query の per-Revision preflight だけ |
| Native fixed-area packing | — | 受入れ条件から削除（10-04） | 要件にしない |
| `graph-query-memory-accounting/1` | 未批准の draft | 10-04 の改訂で superseded | 退役させる |

### 確認後の固定値

固定値の変更は、方向を問わず再確認を要する。

| 単位 | 固定値 | 超えたとき |
| ---- | ------ | ---------- |
| Entity／Relation Revision bundle | proposal/5 と同じ数え方で `512 records`、`6,291,456 B`。A2 の作成時の検証、A2 の reader、B build の per-Revision admission に使う | writer は保存しない。reader は使わない。B はその Revision を qualified にせず、完全な roster を作れなければ build 全体を typed refusal にする（partial generation なし、旧 sealed を維持） |
| C-query の per-Revision preflight | Revision 1 件ごとに、保存された payload・envelope・metadata と、その Revision に結び付く basis・依存・Freshness などの行の bytes の合計が `2,097,152 B` 以下。A3 の開示の preflight も同じ上限を使う。JSON の解析より前に検査する | その query 全体を拒否する。部分 Graph を出さず、Graph の寄与は 0 で、Related Scenes は R+IR（Chronicle が止まっていれば exact R）に戻る |
| seed-local query | read／admission `512`（513 件目は拒否。不適格な行も消費する）、batch `16x32`（1 page 16 件、query 全体で 32 page まで）、SQL `100,000 VM steps`（`1,000` steps ごとと Rust の境界で取消と期限を確認）、parent admission→valid Native result lease `100 ms`（registration／READY までの startup と、cleanup／retirement の待ちは含めない）、reader／busy wait `0`、2hop／Entity 12／edge 展開 144／Scene 8 | 同上。`100 ms` を過ぎた結果は採用しない |
| whole-project B build | B-close で確認した数値: qualified material `8,192`、current Revision `1,024`、scan 候補 `2,064`、1 回の scan で admission する Source 入力 `16 MiB`、roster `4 MiB`、保存 edge と D1 はそれぞれ `8,193` 行・`16 MiB`、SQL `600,000,000` progress counts、期限 `180 s` | typed capacity refusal。partial generation を公開せず、旧 sealed generation を残す。current な binding が成り立たなければ Graph は unavailable で R+IR に戻る |
| Packing（参考。この行では変えない） | `MAX_PACKING_INPUT_BYTES`（`2 MiB`）。準備 1 回について、読み込む入力（Raw、Human 入力、typed candidate の item。id・text・atomic_group の bytes を数える）の合計、Revision ID の bytes の合計、prepared turn で保持する authority binding（Revision の直列化を含む）の bytes の合計を、それぞれ `2 MiB` 以下に保つ。保存された Revision の bytes では検査しないので、2〜6 MiB の Revision も保存サイズだけでは除外されない | どれかの合計が超えたら、準備全体を typed refusal にする。部分的な pack を作らず、その request は作られない |

### 実装上の防御上限

場所は `src-tauri/crates/grimodex-db/src/` からの相対パス。

| 上限 | 現行値（`a153743b`） | 場所 |
| ---- | -------------------- | ---- |
| C-query の request | `8,192 B` | `narrative_extraction/nir1_graph/c_query_worker.rs:29` |
| worker から受け取る frame（NQG1） | 固定の受信領域に収まる長さ（`FRAME_BYTES`）。受信領域は、Native 領域 `1,572,864 B` から request の 2 区画（各 `8,192 B`）と、request・制御・mailbox などの構造体を除いた残りで、正確な bytes は構造体の大きさで決まる。受信の前に長さを検査する | `narrative_extraction/nir1_graph/c_query_worker.rs:198-205`、`narrative_extraction/nir1_graph/worker_frame.rs:10` |
| query 全体の入力と保持見積り（論理会計） | それぞれ `6,291,456 B` | `narrative_extraction/nir1_graph.rs:1437-1465` |
| worker の固定 allocator | query `4,718,592 B`、registration scratch `64 MiB` | `bin/support/c_query_fixed_allocator.rs:18-19` |
| Native 領域 | `1,572,864 B` | `narrative_extraction/nir1_graph/c_query_worker.rs:28` |
| 同時に動く query | process 全体で 1。使用中なら待たずに unavailable | `narrative_extraction/nir1_graph/c_query_worker.rs:40,223` |
| startup と cleanup | startup `30 s`、cleanup `500 ms`。cleanup を証明できなければ quarantine し、claim を保持して再利用しない | `narrative_extraction/nir1_graph/c_query_worker.rs:31-32` |

これらは現行値のまま維持する。緩める変更（容量を増やす、期限を延ばす、同時に動く数を増やす、上限を外す）は再確認を要する。厳しくする変更と、同じかより厳しい方式への置き換えは、正例の受入れを保つ範囲で integrator の技術判断として行い、作業記録に残す。どの容量も query 全体の物理メモリ上限の保証とは読まず、その証明も求めない。frame の版を上げて運ぶ内容を増やす場合（例: Scene との対応付けを返す次の版）は、増やした分の上限を `nir1-defensive-resource-limits` に従って選ぶ。その行が確認されていなければ、増やした分の上限は個別に確認する。

### 削除するもの

- query 全体のメモリ上限とその証明（proposal/5 の `2 MiB`、10-01 の物理上限 `6,291,456 B`＝worker Q `4,718,592 B`＋Native `1,572,864 B`）。入力と保持見積りの論理上限は、実装上の防御上限として残す。
- Native fixed-area packing（Native 側の全 data／metadata を固定領域に詰める要件）。
- B 容量の再認定（成分 2〜6 MiB の形状での RSS・heap・一時ファイルの再測定）。B-close の fixture 資格（RSS `384 MiB`、heap `320 MiB`、一時ファイル `1 GiB`）は、成分 2 MiB 未満で測った形状の記録として残し、それより大きい形状の保証とは読まない。proposal/5 の capacity benchmark は B-close の測定で済んだものとし、取り直さない。
- `graph-query-memory-accounting/1`（enforcement draft:103。query の 2 MiB を worker と allocator で物理的に強制する設計で、一度も批准されていない）は退役させる。同じ方式をまた提案するときは、新しい draftRef で起案する。
- `8ms` は契約値から外す（U2）。8 ms に近づける診断は任意で、契約値を変えない。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId graph-limited-binding.`

## nir1-defensive-resource-limits（新規）

- Baseline (approved; limited): この contractId に確認済みの行はない。現行の規定では、新しい上限や期限を決めることは品質閾値や信頼境界の変更にあたり、変更前後と受入れへの影響を示して、上限ごとに明示確認を得る（l6-l9:106、620、iron-laws.md:64-67）。post-B §5.2 は、測定の後に数値を選び、必要な確認を経て実装するとしている（§10.2 も、history の予算を実測の後に固定するとしている）。#610 の技術委任（AGENTS.md:28-31、iron-laws.md:68-75）は #610 の C-query に限られ、ほかの作業には及ばない。
- Delta (L6-L9 resource rule; proposal/6 draft): NIR-1 の残レーンで今後追加する資源の上限に、共通の規則を一つ置く。上限ごとの確認を、この規則への適合と記録に置き換える。数値は integrator が実測から決め、厳しくするのは自由、merge 後に緩めるときは再確認する。この規則が扱うのは「どれだけ読む・待つ・保持するか」だけで、何を読む・保存する・送るか（authority、保存範囲、送信先、同意、開示）は決めない。それらは各契約で確認する。対象、規則、対象外は下の節のとおり。
- Trusted actors: 上限を強制する Native と Main の owner（各 lane の owner／lifecycle matrix で定めた owner）、integrator（数値を選んで記録する。runtime の authority ではない）、候補を編集しない独立受入れ（記録と試験を照合する）。
- Untrusted actors: renderer が渡す件数・長さ・期限、保存データの中身と長さ、local server（transport の相手）の応答と速度、worker や子 process の出力、model output、lock を持ち続けるほかの処理。
- In-scope attacks: 巨大な本文・履歴・応答による OOM やフリーズ、応答しない相手や遅い相手、lock や barrier での無期限の待ち、再試行の暴走や二重送信、上限計算の overflow、上限を超えたときに打ち切った結果を使うこと、実測によらない数値、merge 後に記録や再確認なしで上限を緩めること、この規則を使って既存の確定値を書き換えること。
- Out-of-scope attacks: 同じ OS ユーザー権限で動く悪意あるプロセスによる物理メモリの枯渇、OS や backend の侵害、何を読む・保存する・送るかの判断（各契約で扱う）、意味の品質。
- Mandatory defenses: 下の規則 1〜8 を守る。上限ごとに境界の試験（N と N+1、期限の前後、取消）を置き、超えたら typed な fail-safe になり、打ち切った結果の採用・自動の再送・無期限の待ちがないことを示す。値と実測を PR 本文と作業記録に残す。緩める変更は再確認なしに merge しない。
- Acceptance implications: Positive: 上限の内の操作が、その lane の受入れ（G-01〜G-08、DG-1〜4、H-1〜2、P など）を満たして成功する。上限を厳しくした後も正例を保つ。Negative: N+1、期限切れ、止まった相手、取消で typed な fail-safe（unavailable、除外、送信 0）になり、打ち切った結果の採用、自動の再送、無期限の待ちがない。値や実測の記録がない上限と、再確認のない緩和は merge しない。Recovery: fail-safe の後に部分的な状態を残さず、確保した資源を解放し、次の操作は最初から始める。送信の後の失敗は `native-generation-receipt` の terminal（exactly once）に従う。Lane unlocked if confirmed: C-body、C-product、H-store／H-current、D-transport で追加する上限の数値を、integrator が実測から決めて PR に記録できる。この行が確認されなければ、これらの数値は上限ごとに確認する。
- 受入れへの影響（l6-l9:620）: 変更前は、新しい上限の数値ごとに変更前後と受入れへの影響を示して確認を得る。変更後は、この規則に適合し、値と実測を記録した上限は、個別の確認なしに merge できる。merge 後に緩める変更と、既存の確定値の変更には、引き続き確認を要する。各 lane の受入れには、境界の試験、fail-safe の確認、値と実測の記録の照合が加わる。物理メモリの証明と容量の再認定は受入れに入れない。既存の確定値、Gold、P、各契約が決める authority・保存範囲・送信先・同意・開示は変えない。

### 対象と超えたときの扱い

| 対象 | lane | 上限の例 | 超えたとき（fail-safe） |
| ---- | ---- | -------- | ----------------------- |
| Graph が追加する target Scene の本文の読取 | C-body | 読む bytes、件数、期限 | その Graph 追加候補を出さない。R+IR の結果はそのまま残る |
| Graph の到達 Entity に対する Scene の pin（`scene_codex_pins`）の列挙 | C-product | pin の件数、frame に加える bytes。SQL と期限は query の固定値の内 | query 全体を unavailable にし、R+IR に戻る |
| history の 1 turn の予算 | H-store／H-current | VM steps、期限、busy、node・edge・attempt・bytes | その履歴候補と子孫を除外する。turn に共通の認可が失効したら turn を止め、送信しない |
| local transport | D-transport | provider を待つ期限、応答の body・frame・中間 buffer | 送信の前なら送信 0。送信の後なら接続を閉じ、`native-generation-receipt` の terminal を一度だけ記録して、再送しない |
| barrier の待機 | D-transport | DB mutex、busy、操作ごと、drain、sweep の期限 | gate を開けない（Closed のまま、または RecoveryRequired）。claim と transport に進まず、送信 0 |

### 規則

1. 有限: 件数、bytes、時間、回数のそれぞれに上限を置く。無期限の待ちや無制限の再試行を作らない。
2. 取消できる: 取消、期限、workspace の切替や終了で止まる。待っている間も取消を観測する。
3. allocation の前に検査する: 件数と長さを先に数え（checked arithmetic）、超えるなら materialize、読取、送受信を始めない。
4. fail-safe: 超えたら、その lane の安全側の結果（unavailable、除外、送信 0）にし、理由を typed で返す。打ち切った途中までの結果を完全な結果として使わず、その場で自動に再送・再試行しない。やり直すときは、既存の契約が定める新しい attempt（新しい handle と再認可）として始める。
5. 数値の決め方: integrator が実測から選ぶ。値、単位、検査する位置、超えたときの結果、実測の条件（環境、fixture、方法、重い処理と重ならない窓か）を PR 本文と作業記録に残す。数値は merge で確定し、merge の前は実測に合わせて調整してよい。
6. 厳しくする: 確認なしで行える。ただし、その lane の正例の受入れ（常に unavailable にならないことなど）を保つ範囲に限る。
7. 緩める: merge の後に、上限を大きくする、期限を延ばす、待ちや再試行を増やす、上限を外す、fail-safe の結果を弱める変更は、変更前後、理由、実測を示してユーザーの再確認を得る。
8. 物理的な証明は求めない: 上限は論理的な会計（件数、bytes、時間、回数）で強制する。プロセス全体の物理メモリ上限やその証明、容量の再認定は求めない。

### 対象外

既存の確定値は、この規則で変えず、規則の対象にもしない: P（B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms）、Gold、`graph-limited-binding` の固定値（Revision `512 records`／`6,291,456 B`、C-query の per-Revision preflight `2,097,152 B`、read／admission `512`、batch `16x32`、SQL `100,000 VM steps`、result lease `100 ms`、reader／busy wait `0`、2hop／12／144／8）、Packing の `2 MiB`、B-close の数値。これらを変えるには、従来どおり個別の確認を要する。この列挙はそれぞれの値の確認状態を変えない（`graph-limited-binding` の固定値は、その行の確認によってだけ確定する）。既存の確定値の内側に置く上限（例: pin の列挙は query の `512`／`100,000 VM steps`／`100 ms` の内）は、確定値を広げる根拠にならない。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId nir1-defensive-resource-limits.`

## 確認後の記録（この draft の外で行う）

- 台帳: `graph-limited-binding` の行（l6-l9:100）の draftRef と confirmedRef を proposal/6 にし、`nir1-defensive-resource-limits` の行を加える。どちらにも、この draft の SHA-256 と確認文を記録する。
- l6-l9 の proposal/5 節と resource unit 表を確認時点（`13e3f6c6^`）の文面に戻して履歴とし（l6-l9:91）、proposal/6 の節を加える。
- 6 MiB と 100 ms を proposal/5 の値として検査している品質試験（`scripts/quality/quality-workflow.test.mjs`）と、b-close-completion:22-24 の「Revision limit (512 records / 2 MiB)」を同期する。AGENTS.md と iron-laws.md に残る「8 ms／2 MiB」の表記は、台帳の現行値への参照に置き換える。
- `graph-query-memory-accounting/1` を退役として enforcement draft に記録する。
- 確認されなかった行は、HOLD 表に `[precheck]` として残す。

## 確認文

確認は contractId ごとに次の 1 文で行う（l6-l9:108）。

- I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId graph-limited-binding.
- I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId nir1-defensive-resource-limits.
