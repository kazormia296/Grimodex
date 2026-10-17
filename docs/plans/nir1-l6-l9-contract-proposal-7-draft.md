# NIR-1 L6〜L9 契約提案 proposal/7（draft）: 資源の上限の見直し

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-l6-l9-contract-proposal/7` |
| contractId | `graph-limited-binding`（proposal/6 の改訂。確認文は 1 文）。`nir1-defensive-resource-limits` は規則を変えず、`graph-limited-binding` の固定値は「その行の確認によってだけ確定する」（proposal-6-draft:174）ので、確認文を増やさない |
| 示す場 | Session B2。K2/4（`nir1-c-body-disclosure-proposal/4`）と同時に示す draft（提示の順は integrator が決める。K2/4 の「状態と示す場」）。Session B1 の draft は K3/2、K4/3、K5/3、K6/2、X1/1（2026-10-17 に確認済み。origin/master に記録済み）。この draft の確認と K2/4 の確認は、確認の順序についてだけ互いに依らない（実装の順序と、参照する sha は依る。「他の draft との関係」の K2/4 の行） |
| 起案日と基点 | 2026-10-17。origin/master `a7666048`。実測とコードの行番号は `df40eec8`（#664 CQ-MEM の merge）。他の draft（Session B1 の提示版と K2/4）は、文書名と節・項目の名前で引く（行番号と sha256 は書かない。版の正本は `docs/plans/nir1-session-b1-manifest.md`）。「変更する値」の場所は `src-tauri/crates/` からの相対（`df40eec8`） |
| 確認済み baseline | `nir1-l6-l9-contract-proposal/6`（draft の SHA-256 `5528f4e091ca087c0f1e071039c6bcede9d3d7cde1422ac1bfd852ee1d8d6b4b`）の `#graph-limited-binding` と `#nir1-defensive-resource-limits`。2026-10-12 23:58 JST にユーザー自身が確認した |
| 確認を求めるもの | 3 種類を、1 文で確認する。(1) 確認済みの閾値の緩和（GDX-PRECHECK-001 の relaxed thresholds）: query の read／admission（records）・batch（pages）・steps・Entity・edge、worker の Q と Native 領域。(2) 保存範囲と fail-safe の範囲を変える変更（緩和ではない）: RB-1、registration の検査（preflight の値は変えず、超える Revision 1 件で project 全体が止まる代わりに、その Revision に達する query だけを拒否する）。(3) 凍結済みの評価 fixture の期待値の更新: G-03 の frontier-exceeded（黙って通さず、確認の対象にする）。**確認を求めず、確認文が承知した確認として扱うもの**: この実測が X1/1 の Q7 を満たさない（X1-3 の前の実測）こと。再測で補い、余裕が 1.5 倍を割れば lane は止まる。RB-1 の閾値（counted 約 3.05 MB／約 6.15 MB）も X1-3 で変わりうるので再測の対象にし、動けば止まる（「確認の扱い」、「受入れ」）。本文は「graph-limited-binding の差分」 |
| 変えないもの | 時間 `100 ms`（ユーザーが選べる。P7-1）、Revision の `512 records`／`6,291,456 B`、per-Revision preflight `2,097,152 B`、入力と保持の論理上限 `6,291,456 B`、S `64 MiB`、B の whole-set、reader／busy wait `0`、2 hop／Scene 8、fail-safe、G-01〜G-08 の判定、Gold、P。新しい authority・schema・consumer・persistent adjacency・製品入口は足さない |
| 測定の記録 | `docs/plans/nir1-lane-decisions/proposal7-measurement/`（`measurement-record.md`、`harness/`、`raw.tar.gz`、`SHA256SUMS`）。`SHA256SUMS` の SHA-256 は `be8734432396fbbc98c7e6303e6edfbbd26f0c3a0735fd7ba59e11a16f1aeac6`。draft と一緒に commit する。表の全体と生の出力はそこに置く。再測はこの harness で行う |

## 要点

**これまでのユーザー決定**（逐語は末尾の「根拠」）: U6 は「防御用の上限だけに簡素化」。SB-4 は「実測から決め直す」（時間 `100 ms` は防御として残す）。SB-5 は「2 hop の Entity の上限を上げる」（それでも超えたら Graph 全体を出さない）。

**用語**（この要点で使う語）

| 語 | 意味 |
| -- | ---- |
| R+IR、typed unavailable | R+IR は Graph が使えないときに戻る従来の検索の結果。typed unavailable は、理由の種別つきで「Graph を使えない」と返すこと（部分 Graph は出さない） |
| seed、m1〜m5、c01、cast | Graph を辿り始める人物。m1〜m4 は合成 fixture の主人公級、m5 は出現が少ない人物、c01 は脇役の筆頭。cast 5+15 は主要人物＋脇役の人数（既定）、8+40 と 12+80 は大きい cast。50 場面は fixture の場面数 |
| Revision、Entity、edge | Revision は場面ごとの review で保存する抽出結果 1 件。Entity は Graph の頂点（人物など）、edge はその間の関係。2 hop で辿る数に上限がある |
| records、pages、steps | records は query が読む行の数。pages は候補の page と scene pin の page を**読んだ回数**（1 page は 16 行以下。pages は辿る Entity の数に連動し、records÷16 ではない。`nir1_graph.rs:1816`、`:2398`）。steps は SQL の VM 命令数（暴走した query の遮断。`1,000` steps ごとに取消を確認） |
| A2 bytes、A3、preflight | A2 bytes は reader が Revision 1 件で数える admission の bytes（payload・envelope・decision とその付随の行。K1/6 の preflight の A2 側）。A3 は project 単位の読取側（`admit_rows`）。preflight は Revision 1 件ごとの上限 `2,097,152 B`（K1/6 の定義は、payload・envelope・metadata と、その Revision に結び付く basis・依存・Freshness などの行の bytes の合計。proposal-6-draft:108）で、超える Revision に達した query は全体を拒否する |
| registration、NOMEM、READY | registration は worker が起動時に project の Revision を Q に載せる登録（READY の前）。NOMEM は確保の失敗で、registration で起きるとその project の Graph が unavailable になる。READY は worker が起動を終え、query を受けられる状態 |
| Q、S、Native 領域、frame | Q は worker の固定領域（`4,718,592 B`）で、registration と query が載る。S（`64 MiB`）は registration の一時領域。frame は worker が返す結果 1 通、Native 領域（`1,572,864 B`）はそれを受ける領域で、frame の上限はここから決まる |
| lease、窓外率 | lease は parent の受付から有効な結果が返るまでの時間（`100 ms`）。窓外率は Graph の結果が最終 request の窓（D=10.84 ms。K6/2）に入らない率で、基準は 1% 以下 |
| 製品形、payload 形 | 製品形は UI の prepare が作る Revision の形（日本語の summary、Entity 12 件。実作に近い）。payload 形は typed writer の長い文字列を payload に持たせた padding 形で、A2 の約 5.8 倍の registration を使う。契約上の最悪に近いが、実作で出るかは未確認 |
| peak の台帳、retained、先取り | peak の台帳は query の入力 bytes・retained（保持の見積り）・serde を 1 つで数える上限 `6,291,456 B`（変えない）。先取りは records×16 B を node ごとに retained へ先に計上すること |
| B、whole-set、RB-1、X1-3、G-03 | B は Entity-Relation Index の build。whole-set は B が 1 回の scan で数える Source 入力の上限 `16 MiB`。RB-1 は受入れ台帳 §7.1 の項目で、writer が数える counted と B が数える保存形の bytes の食い違い。X1-3 は X1/1 の実装 lane（A2／A3 の Revision ごとの費用と envelope の bytes を変える）。G-03 は凍結済みの評価 fixture（`g03-bounded-two-hop`）で、variant frontier-exceeded が「Entity の上限を超えたら Graph 全体を出さない」ことを検査する |

**上限は何のためか**（U6 前段の「なぜこんなにキチキチにメモリを制限しているのか」への答え）

- 物理メモリを守る契約ではない（RSS の上限は保証しない。U6）。壊れた・巨大なデータや暴走した query が来ても、アプリが固まったり落ちたりせず、Graph だけが typed unavailable になって R+IR に戻るための安全弁である。超えたら部分結果は出さない。
- 各上限が防ぐもの: records・pages は読む量、Entity・edge は辿る広がり（どちらも異常に大きい入力）、steps と時間（100 ms）は暴走した query。Q と Native 領域は確保の失敗への余裕で、足りないと worker が起動できず、project 全体の Graph が止まる。
- Q を固定サイズにするのは、確保の失敗（NOMEM）を typed な失敗にして、プロセスを落とさず Graph だけを止めるため。現行の Q 4.5 MiB は、実作の形（製品形・50 場面）を測る前に置いた防御上限で、実測では製品形の A2 が 1.13 MB までしか通らなかった。物理メモリは証明しないが、NOMEM を起こす領域の大きさは実測で決める。推奨の Q 16 MiB は最悪形の推定に 1.4 倍しかなく、測っていない形では足りないことがあるが、そのときも落ちずに R+IR に戻る。

**判断の要点**

- 現行の値は、実作に近い形（50 場面・場面ごと review）の主人公級に届かない（available なのは m1 で 20 場面、c01 で 22 場面まで）。**推奨の組でも、50 場面の主人公級は 100 ms では拒否される。** 候補 B の定数（推奨の query 側の値）と 100 ms を、Q 32 MiB・Native 1.5 MiB の worker、R1 の窓（負荷の記録は限られる。「実測の要約」の「条件と限界」）で測ると、m1 は 34 場面、c01 は 38 場面まで available だった（現行は 20〜22。記録 R1）。推奨の構成そのもの（Q 16 MiB・Native 3 MiB）は、負荷が上がる間（3.84 から 10.72）にしか測っておらず、30 場面でも m3、c01 が 10 回中 4 回拒否、34 場面以上はほぼ拒否だった（R2-6）。34／38 は構成も負荷も違う値で、負荷が上がると減る。50 場面まで届かせるには 200 ms が要る（P7-1）。
- 値は測った必要量に余裕を持たせた。50 場面の既定 cast に対して records 2.1 倍（967）、steps 2.6 倍（233,022）、Entity 3.8 倍（13）。pages 3.4 倍（38）と edge 4.7 倍（108）は大 cast の 50 場面が基準で、大 cast の Entity は 2.2 倍（23）。100 ms が先に当たる分、実効の余裕は records 2.8 倍、steps 3.4 倍（100 ms が当たる付近の必要量に対して）。長い summary（2000 字）では、変えない peak の台帳 `6,291,456 B` が先に当たる（最大 93%）。
- **この実測は X1/1 の Q7（X1-3 の入った候補で測る）を満たさない。** X1-3 の後の再測で余裕が 1.5 倍を割れば lane は止まる（「受入れ」）。

**実測で分かったこと**（合成 fixture の実測。実作の分布ではない。詳細は「実測の要約」）

1. 現行の上限では、50 場面・場面ごと review の主人公級は records（827〜967）と steps（203,786〜233,022）で unavailable になる。
2. 上限を上げると、次に時間が当たる。50 場面の lease は 124〜163 ms（in-process の最大）。34／38 場面の根拠と負荷時の結果は上の「判断の要点」と表 B。SB-4 の問いが挙げた「最大 37.7 ms」は、出典が記録に無く、再現もできなかった（records で拒否された query は 52〜57 ms）。
3. worker のメモリ: 現行の Q は製品形の A2 が 1.13 MB までしか通らず、preflight 上限（2,097,152 B）の正例に届かない（Q 8 MiB と Native 3 MiB で、上限の 2,094,797 B まで通った）。payload 形は registration の使用量が A2 の約 5.8 倍になり、Q 16 MiB では A2 2.03 MB（使用量 11.9 MB、Q の 71%）まで通った。A2 が約 2.7〜2.9 MB（推定。断片化の幅）を超える保存済みの Revision が 1 件あると、Q 16 MiB でも worker が起動できず、project 全体の Graph が止まる。
4. 大きい cast（脇役 40〜80 人）では、Entity が 22〜23（100 場面では 25）、50 場面の records が 1,259〜1,339、pages が 35〜38 になる。現行の pages 上限（32）を超える。
5. 安全側は保たれた: 813 回の worker 実行で signal 終了は 0 件。上限超過は typed unavailable か worker の exit 1 で、部分 Graph は出なかった。

**何を変えるか**（変更前→推奨。余裕は、必要量に対する上限の倍率。別の値は新しい draftRef）

| 値 | 現行→推奨 | 必要量（実測） | 余裕 | 別の値にすると |
| -- | --------- | -------------- | ---- | -------------- |
| read／admission（＝query の records。A3 の `admit_rows` も query の残りに従う） | `512`→`2,048` | 967（50 場面）／1,339（大 cast）／1,879（100 場面） | 2.1×／1.5×／1.09×（100 ms 付近の 738 に 2.8×） | 1,024: 大 cast が unavailable（100 ms のままなら実効は同じ。2,048 は 200 ms か速い機の備え）。4,096: 先取りが retained 上限の 52% |
| batch（＝pages。`16x32`→`16x128`、1 page 16 件のまま） | `32`→`128` | 24〜38（大 cast）。200 場面でも 43。Entity 50 は推定 83〜93 | 3.4×（38 に対し）。推定に 1.4×（100 場面の既定 cast は、1 Entity あたり 2.3 pages〔記録の表 2 の 30 pages÷13 Entity〕を Entity 50 に掛けた推定約 115 に対し約 1.1×。推定） | 64: Entity 約 35〜39 で先に当たる（推定）。256: 読出し回数の遮断が緩む |
| SQL steps | `100,000`→`600,000` | 233,022／310,952（大 cast） | 2.6×／1.9×（100 ms 付近の 174,694 に 3.4×） | 300,000: 大 cast が unavailable（100 ms のままなら実効は同じ）。1,000,000: 暴走の遮断が遅れる |
| 2hop／Entity（＝2 hop の Entity） | `12`→`50` | 13／23（大 cast、50 場面）／25（100 場面） | 3.8×／2.2×／2.0× | 24: 25 に届かない |
| edge 展開 | `144`→`512` | 108（大 cast、50 場面）／214（100 場面） | 4.7×／2.4× | 144 のまま: Entity 約 19〜30（推定）で edge が先に当たる |
| worker の Q | `4,718,592 B`→`16 MiB` | 製品形 7.2 MB／payload 形 約 12.2 MB（A2 が preflight 上限のとき。後者は推定） | 2.3×／1.4× | 8 MiB: payload 形で NOMEM。32 MiB: 実行ファイル +17 MB |
| Native 領域 | `1,572,864 B`→`3 MiB` | frame 1,481,356 B（最大。2000 字、50 場面）／1,958,008 B（製品形の上限） | 2.1×／1.6×（frame の上限に対して）。records 2,048 の最悪は推定 3.14 MB で frame の上限（約 3.13 MB）と同程度、未測定 | 1.5 MiB: 製品形の上限の frame が入らない |
| registration の検査 | preflight の外→READY の前に A2 bytes を検査 | A2 約 2.7〜2.9 MB 超の payload 形で Q 16 MiB も NOMEM（推定） | — | 検査なし（P7 案 3）: 1 件で project 全体が止まる |
| Revision の保存（RB-1） | counted だけ検査→payload と envelope の各 `6,291,456 B` も検査。**保存できる Revision が減る**（counted が上限の内でも保存形が超えるとき。試験形で counted 約 3.05 MB 超、製品形で約 6.15 MB 超。この閾値は X1-3 で変わりうる〔再測の対象〕。確認済みの正例「`6,291,456 B` の内は保存できる」を形によって破る） | 実測の Revision の最大 115,679 B で当たらない | — | 文言だけ直す: 保存範囲は変わらず、巨大な Revision で B が止まる現行のまま |
| G-03 の frontier-exceeded | 発見 16 件（上限 12 を超える）→発見 54 件に作り直し、再 freeze と独立レビュー（`evals/nir1-graph` の freeze、schema、README、review を更新し、Graph の観測の前に新しい独立レビューを経る） | 現行の fixture は Entity 上限 50 で available（16 件）になり、期待値と食い違う | — | 期待値を available に書き換える: 超過の検査が G-03 から消える |

**確認済みの固定値の名前との対応**（proposal/6 の「確認後の固定値」と「実装上の防御上限」の節の名前。上の表の別名〔query の records、pages〕は、台帳と確認文では左の名前で書く）

| proposal/6 の確認済みの名前 | 確認済みの値→この draft | 上の表の呼び名 |
| -------------------------- | ----------------------- | -------------- |
| seed-local query の read／admission | `512`→`2,048` | query の records |
| seed-local query の batch | `16x32`→`16x128`（1 page 16 件のまま、query 全体で 32 page まで→128 page まで。16×128＝2,048 で read／admission と同じ） | pages |
| seed-local query の SQL | `100,000 VM steps`→`600,000 VM steps` | SQL steps |
| seed-local query の 2hop／Entity／edge 展開／Scene | 2hop／`12`／`144`／`8`→2hop／`50`／`512`／`8`（2hop と Scene は変えない） | 2 hop の Entity、edge 展開 |
| seed-local query の lease、reader／busy wait | `100 ms`、`0`（変えない） | — |
| worker の固定 allocator の query（実装上の防御上限） | `4,718,592 B`→`16 MiB` | worker の Q |
| Native 領域（実装上の防御上限） | `1,572,864 B`→`3 MiB` | Native 領域 |
| Entity／Relation Revision bundle、C-query の per-Revision preflight、registration scratch（S）、query 全体の入力と保持見積り、whole-project B build、Packing | 変えない（`512 records`／`6,291,456 B`、`2,097,152 B`、`64 MiB`、`6,291,456 B` など） | — |

**ユーザーが選ぶ点 P7-1〜P7-4**（同時に示す K2/4 の選ぶ点は K2-1〜K2-3 で、番号が別。推奨と違う選択は新しい draftRef。「確認の扱い」）

P7-1. 時間。**100 ms を残すと、SB-4・SB-5 の問いが想定した姿（50 場面の主人公級が available）にはならない。** 上限を全部上げても、時間が先に当たる。

| 選択 | 届く場面数（この機） | 防御と影響 |
| ---- | -------------------- | ---------- |
| 100 ms を残す（推奨） | R1 の窓で m1 約 34、c01 約 38 場面（候補 B・Q 32 MiB。R1。負荷の記録は限られる）。推奨の構成の負荷時（R2-6）は 30 場面でも m3、c01 が 4/10 拒否。最も重い m2 の境界は未測定。現行は 20〜22 | worker の占有は最大 100 ms。時間は機械と負荷で動く遮断で、時間を外しても steps 600,000 が約 360 ms 相当（推定）で止める。50 場面の主人公級は拒否され続け、R+IR に戻る。K6/2 の前提（100 ms）と合う |
| 200 ms | 50 場面（in-process の最大 163 ms。上限を外した build の worker 経路で m1・m2・c01 は呼出し最大 150.5 ms。R1）。70 場面は、m1 が in-process の最大 186.9 ms、c01 が 181.0 ms（記録の R1 の境界表。m1 と c01 だけで m2 は未測定。100 場面の m1 に対する m2 の最大の比は約 1.04 倍なので、70 場面の m2 は約 195 ms と推定され、200 ms にほぼ届く）。200 ms の期限そのものは worker 経路で未測定。負荷で 1.2 倍遅くなると（R2-6 の c01・30 場面は 75→90 ms）、163 ms は約 200 ms に達する（推定）ので余裕は薄い | worker の占有が最大 2 倍（同時 1 query。使用中は待たず unavailable）。Related Scenes は完了した query にだけ Graph を混ぜる（post-B §7.2）ので待ちは増えず、遅い Graph は次の query で使われる。窓外率の前提が 100 ms の lease なので、K6/2 の「根拠: ユーザー決定（逐語）」の U2 の行と、未成立の条件 (a)（graph-eval-procedure の「区分と許す改訂」）の見直しが要る（内容と日数は未見積り）。新しい draftRef が要り、起案と再確認が 1 巡増える |

SB-4 の問いは「時間は最大 37.7 ms で 100 ms に収まる」を前提にしたが、この実測では再現しなかった。それでも 100 ms を推奨するのは、決定が「100 ms は防御として残す」であることに加え、時間は他の値と独立に proposal/8 で後から変えられ、100 ms で確認して lane を進めても失うものが少ないため。失うのは、lane が済んでも 50 場面の主人公級が拒否され続ける間である。200 ms を選ぶと、その拒否は R1 の窓の 50 場面まで解けるが、worker の占有が最大 2 倍になり、K6/2 の窓外率の前提の見直しと起案・再確認が 1 巡増える。50 場面の主人公級を Graph で使うことと、1 query の占有の上限を 100 ms に保つことの、どちらを重く見るかの選択である。

P7-2. worker のメモリ。P7 案 1〜5（本文は「worker のメモリ」）。

| 案 | 製品形の上限（A2 2.09 MB） | payload 形の A2 2.03 MB | 保存済みの大きい Revision 1 件 | 実行ファイル増 | 日数 |
| -- | -------------------------- | ----------------------- | ------------------------------ | -------------- | ---- |
| P7 案 1 変えない | 通らない（1.13 MB までは通る） | 通らない（0.53 MB は通る。境界は 0.53〜0.83 MB の間） | project 全体が止まる | 0 | 0 |
| P7 案 2 Q 8 MiB＋Native 3 MiB | 通る | 通らない（0.83 MB は通る。境界は 0.83〜1.43 MB の間） | 止まる | 約 3.7 MB | 2 |
| P7 案 3 Q 16 MiB＋Native 3 MiB | 通る | 通る | 止まる（A2 約 2.7〜2.9 MB 超） | 約 12 MB | 2 |
| **P7 案 4（推奨）** P7 案 3＋registration の検査 | 通る | 通る | 止まらない見込み（**未測定**。設計が成り立たなければ P7 案 3 と同じ結果になる） | 約 12 MB | 3.5 |
| P7 案 5 Q 32 MiB＋Native 3 MiB | 通る | 通る | 止まる（A2 約 5.4〜5.8 MB 超。推定） | 約 29 MB | 2 |

P7 案 4 を推奨する理由: P7 案 3 では 1 件の大きい保存済み Revision で project 全体が止まる。P7 案 4 はその 1 件を Q に載せないことで防ぎ、Q を 32 MiB まで広げずに済む。**確認するのは方針で、効果は実装後の試験で確かめる。** 確かめられなければ worker を READY にしない typed refusal に倒し（P7 案 3 と同じ結果）、日数が増える。

P7-3 RB-1、P7-4 G-03: 推奨と対案は上の「何を変えるか」の表のとおり。

**進め方**（詳細は次節）

- 推奨の組（100 ms 維持、P7 案 4、RB-1 の検査、G-03 の作り直し、他の行は表のとおり）でよければ、末尾の確認文をそのまま返す。違う選択は、P7-1（時間）、P7-2（P7 案の番号）、P7-3（RB-1）、P7-4（G-03）、または採る行の名前を返す（確認文は出さず、proposal/8 を起案する）。Entity・edge・pages・G-03 は連動（G-03 の発見 54 件は Entity 50 の値に依存）、Q・Native・registration の検査は組で効く。steps、時間、RB-1 は単独で選べる。どの選択でも新しい draftRef が要り、再確認が 1 回増える。
- 確認すると、lane 約 8 日で実装し、X1-3 の後の再測を終えるまで merge しない。確認しないと、現行の値のまま（50 場面の主人公級は unavailable、メモリの正例は [precheck]）。

## 確認の扱い

- 確認は contractId ごとに、末尾の「確認文」の 1 文で行う。1 文で確認されるのはその contractId の行だけで、依存する契約は確認されない。この確認文は、G-03 の期待値の更新と、X1/1 の Q7（実測を X1-3 の入った候補で取る）を満たさないこと（再測で補う）も承知した確認として扱う。
- 計画への同意、merge の指示、構造化質問への回答（SB-4、SB-5 を含む）、「この提案でよい」のような包括的な返答は、確認として扱わない。
- 推奨と違う選択は、新しい draftRef（proposal/8）で起案する。この draft の確認文は、推奨の組だけを確認する。
- `nir1-defensive-resource-limits` は規則だけを置く行で、この draft は規則を変えない。規則 7（緩めるときは再確認）が求める変更前後、理由、実測は、この draft が示す。確認文を増やさない。
- この確認は Graph の製品公開、local 送信、新しい authority・保存先・送信先を許可しない。公開条件（A3 + B + C + D2a）と公開時のユーザー承認は残る。
- 確認された行は、この draft の bytes の SHA-256 と確認文を台帳に記録する（`draftRef#contractId`）。本文は編集しない。

## 根拠: ユーザー決定（逐語）

継続計画 §1（`docs/plans/nir1-continuation-2026-10.md`）から写す。「読み方」は起案者の解釈で、ユーザーの発言ではない。

| ID | 時刻（JST） | 回答（逐語） | 読み方 |
| -- | ----------- | ------------ | ------ |
| U6 前段 | 2026-10-12 17:28 | 「そもそもこんなにキチキチにメモリを制限している理由がよくわからん」 | 上限は防御に要る分だけにする。必要量に合わせて決める |
| U6 | 2026-10-12 17:31 | 「防御用の上限だけに簡素化（推奨）」 | 壊れたデータや巨大データへの上限と fail-safe を残す。物理メモリの証明と B の再認定はしない |
| SB-4 | 2026-10-14 10:02 | 「実測から決め直す (推奨)」 | 問い要旨は「50場面・場面ごとに review した現実の形では、主人公は約40件の Revision に入り、値を変えない最適化の後でも records 約900（上限512）、steps 約21万（上限10万）が要る。時間は最大 37.7 ms で 100 ms に収まる。」。CQ-OPT、B-GUARD、CQ-AVAIL、CQ-MEM の後に現実の形で測り直し、records と steps、worker のメモリ（RB-2）、Revision の数え方（RB-1）を見直す。100 ms は防御として残す |
| SB-5 | 2026-10-14 10:02 | 「上限を上げる (推奨)」 | 2 hop の Entity の上限を上げる。値は実測で決める。それでも超えたら、今どおり Graph 全体を出さない（部分 Graph は出さない） |

## 実測の要約

数値の表の全体と生の出力、harness、集計の根拠は「測定の記録」（`measurement-record.md`。追補 A-1〜A-6）に置く。ここは判断に効く部分だけである。

**条件と限界**

- 基点は `df40eec8`（CQ-OPT #657、B-GUARD #660、CQ-AVAIL #663、CQ-MEM #664 を含む）。**X1-3 は含まない。** X1/1 の Q7 は、この実測を X1-3 の入った候補で取るよう定めた。この実測はそれを満たさない（「他の draft との関係」）。
- 合成 fixture（実作ではない）。場面ごとに Entity／Relation を review して Revision を作る。既定の cast は 5+15。summary は既定（短い）、200、600、2000 字。実作の分布は不明。
- 1 台の Linux 機（共有）。時間は目安で、Windows と macOS は測っていない。**時間の境界は負荷で動く。** R1 の負荷の記録は、run の前の 1 分負荷平均 2.00 と 2.25 の 2 点（5・15 分平均は 2.8〜3.3）だけで、候補 B・100 ms を含む run に個別の記録はなく、run の後の記録もない。CPU とコア数も記録していない。記録の手順 4 は、負荷平均が 2〜3 を超える窓の時間を pass／fail に使わないとするので、R1 の時間は目安である。 worker の RSS と B の build は測っていない。推奨の構成（Q 16 MiB、Native 3 MiB、100 ms）を、静かな窓で測ってはいない。
- 定数を変えた build は 3 種。「上限を外した」build（表 A の必要量用）、候補 A（1,024／300,000／24／288）、候補 B（推奨値の query 側。2,048／600,000／50／512／pages 128）。候補 B の定数で測ったのは、in-process の全 seed（R2-1）と、worker 経路（Q 16 MiB、Native 3 MiB。R2-2）。

**表 A 必要量（主人公級 m1〜m4、c01 の最大。上限なし。lease は in-process の最大）**

| 場面数 | records | steps | Entity | edge | lease 最大 | 現行の上限で |
| ------ | ------- | ----- | ------ | ---- | ---------- | ------------ |
| 20 | 415 | 95,749 | 11 | 40 | 66.4 ms | 全 seed available |
| 30 | 596 | 140,275 | 13 | 59 | 84.0 ms | steps で unavailable（m5 のみ available） |
| 50 | 967 | 233,022 | 13 | 99 | 162.9 ms | records で unavailable（m5 のみ available） |
| 100 | 1,879 | 459,181 | 13 | 198 | 272.6 ms | m1〜m5、c01 はすべて unavailable |

大 cast（50 場面）: 8+40 は records 1,259／steps 297,197／Entity 22／edge 108／pages 35。12+80 は 1,339／310,952／23／97／38。100 場面は 8+40 が records 2,454、12+80 が 2,663（候補 B の 2,048 を超えて unavailable になる）。Entity が 13 前後で頭打ちになるのはこの fixture の性質で、一般則ではない。

**表 B 100 ms を残したときの到達**（本番の親の経路、n=10、候補 B の定数、Q 32 MiB、Native 1.5 MiB。記録 R1。負荷は run の前の 1 分負荷平均 2.00 と 2.25 の 2 点しか記録がなく、この表の run〔候補 B・100 ms を含む〕に個別の記録はない）: m1 は 34 場面で available（最大 96.8 ms）、36 場面で `NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`。c01 は 38 場面で available（最大 98.7 ms）、40 場面で 10 回中 3 回が同じ拒否。m5 は 50 場面でも available（最大 34 ms）。推奨の構成を、1 分負荷平均が 3.84 から 10.72 に上がる間に測り直すと、30 場面は m1、m2 が 10 回とも available（最大 94 ms）、m3、c01 は 10 回中 4 回が拒否、34 場面以上の主人公級はほぼ拒否だった（c01 は 34 場面で 3 回、40 場面で 2 回が available。記録 R2-6）。R1 と R2-6 は worker の構成も負荷も違い、差は分離していない。

**表 C worker のメモリ**（Revision 1 件、A2 bytes ごと。記録 R2-3、R2-5。現行の Q で通るのは、製品形が 1,128,845 B まで、payload 形が 534,294 B まで。834,294 B は NOMEM で、Q 8 MiB 以上では通る）

| 形 | A2 bytes | registration の使用量 | Q 4.5 MiB（現行） | Q 8 MiB＋Native 3 MiB | Q 16 MiB＋Native 3 MiB |
| -- | -------- | --------------------- | ----------------- | --------------------- | ---------------------- |
| 製品形 | 1,188,677 | 4,541,469 B | NOMEM（請求が空きを超える枯渇） | available | available |
| 製品形 | 2,094,797（上限） | 7,208,463 B | NOMEM（請求 4,376 B に空き 73,280 B。**断片化**） | available（frame 1,958,008 B。Q の 86%） | available（Q の 43%） |
| payload 形 | 1,434,294 | 8,469,205 B | NOMEM | NOMEM | available |
| payload 形 | 2,034,294 | 11,885,581 B | NOMEM | NOMEM | available（Q の 71%）。超過形（counted 700,000）も 13,591,405 B（81%）で載る |

- 現行の Q の NOMEM には、請求が空きを超える枯渇（A2 1,188,677 B）と、請求が空きより小さい**断片化**（A2 1,608,797 B で請求 43,830 B・空き 148,192 B、2,094,797 B）の両方がある（記録 A-6）。
- payload 形の使用量は、A2 が preflight の上限のとき約 12.2 MB（推定。2 点の直線の外挿）。保存済みの Revision の A2 が約 2.7〜2.9 MB（counted 約 890,000 付近）を超えると、Q 16 MiB でも NOMEM になる（推定。2.9 MB は Q を 100% 使える前提で、2.7 MB は Q の 94% で断片化する場合）。
- 製品形で Revision が複数ある project（同じ Entity 12 件を場面ごとに review）は、A2 の合計が入力の論理上限を超えない範囲で、現行の Q でも available だった（A2 948,772 B×4 件）。これは Entity が全 Revision で同じ fixture に限る。**未解決**: 台帳 §7.2（#664）は 4 件の製品形 project（`pm-300000`）が S3 以降に断片化で NOMEM になると記録するが、R2-4 は再現せず、fixture が repo に無いため原因は未特定。
- worker の実行ファイル: Q 4.5 MiB で 79,356,200 B、8 MiB で 83,026,216 B、16 MiB で 91,414,840 B、32 MiB で 108,192,040 B（`ls -l`。記録 A-2）。起動時間は変わらない（ready p50 54〜56 ms）。

**そのほか**

- 場面ごとの Revision は 4〜16 records、A2 は最大 26,388 B（2000 字の summary で 115,679 B）。A2 の合計の最大は、50 場面・2000 字で 3,545,258 B（候補 B。`6,291,456 B` の入力上限の 56%）、100 場面・2000 字で 7,042,501 B（上限を超えて unavailable。記録 A-1）。
- **拘束するのは peak の台帳**（入力 bytes・retained・serde を 1 つで数える。上限 `6,291,456 B`、変えない）。R2-1 の最大 peak は、2000 字・cast 5+15・50 場面で 5,861,161 B（93%、余裕 1.07 倍）。2000 字・100 場面は 6 seed 中 1 seed だけが available。長い summary では records ではなく、この台帳が取れる場面数を決める。**大 cast と 2000 字の組合せは測っていない。**
- retained の最大は 2,505,518 B（600 字、100 場面。上限の 40%）。上限を外した build の retained は、node ごとの先取りが records に比例するので、根拠にしない。

## 変更する値

### records と pages

- 現行: `MAX_GRAPH_RECORDS = 512`（`grimodex-core/src/narrative_nir1.rs:33`）を Revision と query が共有する。`QUERY_MAX_PAGES = 32`（`grimodex-db/src/narrative_extraction/nir1_graph.rs:80`）。
- 推奨: query の read／admission を `2,048`、pages を `128` にする。**定数を分け、Revision は `512 records`／`6,291,456 B` のまま。** records と pages は独立に当たる: pages は Entity の数に連動し、records が少なくても先に当たりうる。
- 使用箇所の分類（lane が確定する。`narrative_extraction/` は `grimodex-db/src/` の下）。Revision 側（512 のまま）: `narrative_nir1.rs:484,549,564`、`nir1_entity_relation.rs:3855,3944`、`nir1_entity_relation_index.rs:57`。query 側（2,048）: `nir1_graph.rs:1556,1747-1806,1856-1928,2358-2383`、保持見積り `:2560-2578`（`nir1_graph/input.rs:1574-1943` は `#[cfg(test)]`、1439 行から。製品コードの変更箇所ではない）。frame と projection の検査（query の値に従う。frame の版 NQG3 と運ぶ内容は変えない）: `nir1_graph/worker_frame.rs:139,176,192,284,1198,1383,1417`、`worker_projection.rs:52-62`。
  - A3 の開示の行数（`input.rs:324` の `admit_rows`）: project 単位の読取の行数を `remaining.min(MAX_GRAPH_RECORDS)` で検査する。**query の残りの records に従う**（K1/6 が A3 の preflight で固定したのは bytes の `2,097,152 B` で、行数 `512` は固定していない）。lane は `admit_rows` の呼出し 3 か所（`:1035,1167,1185`）が数えるものを確認する。512 を残す案は proposal/8 の選択肢にする。GraphLimits の既定値の検査（`narrative_nir1.rs:257,635-637`）は Entity と edge の値に従う。
- 根拠（records。倍率は「要点」の表）: 候補 B の in-process で、50 場面の全 seed（5+15 の 6 seed、8+40 の 48、12+80 の 92）が available（R2-1）。100 場面の大 cast は届かない。node ごとに records×16 B を先に計上するので、Entity 50 のとき最大 1,638,400 B（retained 上限の 26%）を先取りする。100 ms を残す限り、records は時間より先には当たらない（100 ms が当たる付近で 738）。
- 根拠（pages）: 実測の最大は 38（Entity 23）、200 場面の既定 cast で 43。Entity 50 は推定 83〜93（Entity ごとに 1.65〜1.85 pages。測っていない）。128 は 38 の 3.4 倍、推定の 1.4〜1.5 倍。pages は読出し回数の遮断で、records と独立に当たりうるので、独立の N／N+1 試験を置く（「受入れ」）。
- 対案と影響: 別の値の結果は「要点」の表。4,096 の先取り 3,276,800 B（上限の 52%）は計算値で、build は測っていない。Revision も 2,048 にそろえると、B-close の入力の形が変わり、B の再認定が要る（U6 に反する）。

### steps

- 現行→推奨: `100,000` → `600,000`（`nir1_graph.rs:78`）。取消の確認は `1,000` steps ごとのまま。
- 根拠（倍率は「要点」の表）: この機の 100 ms は約 165,000〜175,000 steps（m1・36 場面で 165,336 steps／98.6 ms）で、その 3.4×。**100 ms を残す限り、steps は時間より先には当たらない。** 先に当たるのは、この機より約 3.4 倍速い機か、200 ms の構成。速い機は測っていない。

### Entity、edge

- 現行→推奨: Entity `12` → `50`、edge 展開 `144` → `512`（`narrative_nir1.rs:30-31`。`nir1_graph.rs:2059,2079`、frame 側 `worker_frame.rs:337,931,1341,1368`）。Scene `8` と 2 hop は変えない。
- 根拠（倍率は「要点」の表）: 超えたら今どおり Graph 全体を出さない（SB-5）。edge は Entity と対で効く。edge を 144 に残すと Entity 約 19〜30 で先に当たる（推定。m1 の 99 edge／13 Entity と、8+40 の 108 edge／22 Entity の比から）。Entity 100 は未測定。

### worker のメモリ（Q、Native 領域、registration、frame）

K1/6 の Q `4,718,592 B` と Native `1,572,864 B` は実装上の防御上限で、緩めるには再確認が要る（S `64 MiB` と preflight は変えない）。各案の結果は「要点」の表。日数は推定で、試験と記録を含む。

- 変更範囲: P7 案 2〜5 は `bin/support/c_query_fixed_allocator.rs:18`（Q）と `nir1_graph/c_query_worker.rs:29`（Native の `PARENT_BYTES`）。P7 案 4 はさらに、registration の呼出し側 `nir1_graph.rs:613`、`nir1_graph/candidates.rs:306`、**NOMEM を起こす読取の関数** `nir1_entity_relation_index.rs:1040`（`read_revision_input_stats`）、`:1276`（`preflight_revision_source_basis`）、`:2075`（`is_complete_registered_with_scratch`）。この index は B と共有なので、B への影響が lane の確認項目になる。
- 根拠: Q 16 MiB は、測った最悪の形（payload 形、A2 が上限のとき約 12.2 MB。推定）の 1.4×、製品形（7.2 MB）の 2.3×。**1.4× は小さい余裕で、測っていない形では足りないことがありうる。** そのときは worker が起動せず、Graph が unavailable で R+IR に戻る（fail-safe）。32 MiB は余裕が大きいが、実行ファイルが約 17 MB 余計に増える。
- Native 3 MiB: 実測の最大 frame は 1,481,356 B（m2、2000 字、50 場面）の 2.1×、製品形の上限の frame 1,958,008 B の 1.6×。frame はほぼ records に比例する（1 record あたり約 1,532 B）ので、records 2,048 の最悪は約 3.14 MB で、frame の上限（`PARENT_BYTES` から 16,616 B 引いた約 3,129,112 B）と同程度。A2 の合計が入力の論理上限に届く約 1,700 records では約 2.6 MB。**どちらも推定で未測定**（peak の台帳が先に止める可能性もある）。 lane は frame 上限の N の正例を必ず取る。超えたら frame 超過として worker が終了し（SIGABRT ではない）、Graph は unavailable になる。
- registration の検査の設計（P7 案 4）: Revision ごとに A2 の admission bytes を、parse と Q の確保の前に数える（checked arithmetic）。**これは preflight の A2 側の部分集合で、A2 が `2,097,152 B` を超えれば preflight も必ず超える**（A3 側の行は数えない）。超える Revision は Q に載せない。その Revision に達する query は、今どおり preflight で全体を拒否する。**載せない Revision が、それを通る seed の結果から何も言わずに欠けてはならない**（reverse index の候補に印を残すなど。lane が設計し、試験で確かめる）。確かめられなければ、worker を READY にしない typed refusal に倒す（P7 案 3 と同じ結果）。
- 対案: registration の増幅（payload 形で A2 の 5.8 倍）自体を減らす。SQLite の JSON の中間 buffer が主因とみられる（推定）が、未調査で、この proposal では扱わない。preflight を `1,048,576 B` に下げる案は、確認済みの値を下げ、A3 の開示の preflight の意味を変える。
- P7 案を選ぶ場合の影響: P7 案 1 は製品形の正例が [precheck] のまま残る。P7 案 2〜3、5 は、writer の上限（6 MiB）まで保存できる Revision 1 件で project 全体の Graph が止まる（安全側だが、1 件の貼り付けで全部が止まる）。P7 案 5 は実行ファイルが約 27.5 MiB 増える（arena を .bss に置けば増えない見込みだが、未確認）。どの案でも worker の RSS の上限は保証しない（U6）。S は変えない。

### Revision の数え方（RB-1）

- 現行: 契約は writer の counted（`512 records`／`6,291,456 B`）で書くが、B は保存した payload と envelope を成分ごとに `6,291,456 B` で数える。envelope は counted の 1.03〜1.06 倍（製品形）〜2.03 倍（試験形）で、counted が上限の内でも B が publish できない Revision がある（acceptance §7.1）。
- 推奨: writer に、保存する payload_json と envelope_json がそれぞれ `6,291,456 B` 以下かの検査を足す。数値は変えない。契約の正例を「counted が上限の内で、保存した payload と envelope がそれぞれ 6,291,456 B 以下、かつ whole-set の内なら publish される」に直す（§7.1 の 1-B と 1-D）。
- **保存範囲が狭まる**（緩和ではない）: counted が上限の内でも、保存形が `6,291,456 B` を超えると保存できなくなる（試験形で counted 約 3.05 MB 超、製品形で約 6.15 MB 超）。実測の Revision は最大 115,679 B で、この fixture では当たらない。この閾値は envelope／counted の比から出ており、X1-3 は envelope の bytes を変える（X1/1 の「integrator の判断」の Q7）ので、保存できなくなる counted の境界も動きうる。再測の対象にする（「受入れ」）。
- `typed-revision-material` の行は変えない（K1/6: /4 が参照する validator の byte 上限はこの行の値に従う）。X1/1 の確認済みの差分とは独立。
- 既存のデータ: 検査は新しく保存するものにだけ効く。すでに保存された Revision は変えず、読取（A2 の reader）は従来どおり。B の扱いは B-GUARD の現行のまま（変更なし）。
- 対案と影響: 契約の文言だけを直す（1-D のみ）。writer は変わらず、巨大な Revision を保存でき、承認されると project の B build が止まる（現行）。B の成分 guard を counted まで上げる（1-C）は、B-close の測定範囲を外れるので勧めない。

### 時間（result lease）

- 現行→推奨: `100 ms` → 変えない（SB-4。ユーザーが防御として残すと決めた）。parent の受付から有効な result lease まで。startup と cleanup は含めない。必要な時間は 20 場面 66 ms、30 場面 84 ms、50 場面 163 ms、100 場面 273 ms（表 A。in-process の最大）。
- 対案と影響: `200 ms` は 50 場面（in-process の最大 163 ms）と、70 場面の m1・c01（186.9 ms、181.0 ms。m2 は未測定で約 195 ms と推定）まで届く見込み（in-process）。100 場面は worker 経路の最大 300.5 ms（R1）を超えるので、約 350 ms 以上（推定）が要る。worker の占有、窓外率の前提（K6/2 の「根拠: ユーザー決定（逐語）」の U2 の行、graph-eval-procedure の「区分と許す改訂」の未成立の条件 (a)）、日数は P7-1。

### 凍結済みの評価 fixture（G-03）

- 現行: `evals/nir1-graph/g03-bounded-two-hop.v1.json` の variant `frontier-exceeded` は、Wren に knows-Relation を 14 本足して Entity 16 件を発見させ、`graph.status=unavailable`、`reasonClass=graph-limit-exceeded`、`limit=12` を期待する（`:843-844`、`:912-917`）。base variant も `frontier.limit=12` を持つ（`:768`）。`schema.v1.json:858` は `limit` を `const 12` とし、`scripts/quality/nir1-graph/contract.mjs:539` は `limit: 12` を計算する。この fixture は `freeze.v1.json` で独立レビューの後に凍結され、sha256 `50270567…`（g03）などが記録されている。
- 問題: Entity の上限を 50 にすると、16 件は上限の内なので実機は available（node 16）を返し、凍結済みの期待値と食い違う。観測は Hold になる。K1/6（proposal-6-draft:82）は「G-01〜G-08 の判定」を変えないと書く。**判定（超えたら Graph 全体を unavailable にし、部分 Graph を出さない）は変わらず、変わるのは超過を作る件数だけ**だが、凍結済みの期待値の変更なので、黙って通さずこの確認の対象にする（GDX-PRECHECK-001）。
- 推奨: variant を、上限 50 を超える件数に作り直す。発見 54 件（上限 +4。現行の 16＝12+4 と同じ流儀）、edge 展開は 512 の内。`limit` を 50 に、schema、`contract.mjs`、README の上限の記述（`:23`、`:125`）を 50 と 512 に合わせる。**変更後の fixture は、Graph の観測の前に新しい freeze と独立レビューを経る**（現行の freeze は `graphRuntimeObservedBeforeFreeze: false`）。
- 影響: この variant は事前の期待値が Graph unavailable なので、K6/2 の窓外率の pool（K6/2 の graph-eval-procedure の「区分と許す改訂」の (a)。unavailable でない variant の sample だけ）に入らない。作り直しの後も入らないので、pool と窓外率の測り方は変わらない。
- 対案: 期待値を「available、node 16」に書き換える。G-03 から超過の検査が消え、16 node の経路の期待値を足して独立レビューを経る必要があり、この variant が pool に入る（勧めない）。fixture を触らない選択は、観測が Hold になるので採れない。

## graph-limited-binding の差分

proposal/6 の `#graph-limited-binding` を baseline とし、資源の値と、それに伴う防御と受入れだけを改訂する。proposal/6 のその他の条項は変えない。

- Baseline (approved; limited): `nir1-l6-l9-contract-proposal/6#graph-limited-binding`（SHA-256 `5528f4e0…`。2026-10-12 23:58 JST に確認）。Revision `512 records`／`6,291,456 B`、per-Revision preflight `2,097,152 B`、read／admission `512`、batch `16x32`、SQL `100,000 VM steps`、lease `100 ms`、reader／busy wait `0`、2hop／12／144／8、worker の Q `4,718,592 B` と S `64 MiB`、Native `1,572,864 B`。
- Delta (L6-L9 resource limits; proposal/7 draft): 「何を変えるか」の値（proposal/6 の確認済みの名前では、read／admission `512`→`2,048`、batch `16x32`→`16x128`〔1 page 16 件×128 page。「pages」と同じ〕、SQL `100,000`→`600,000 VM steps`、Entity `12`→`50`、edge 展開 `144`→`512`〔2hop と Scene `8` は変えない〕、worker の Q `4,718,592 B`→`16 MiB`、Native `1,572,864 B`→`3 MiB`。対応は「何を変えるか」の下の表）と、registration の検査、RB-1 の writer の検査、G-03 の frontier-exceeded の作り直しを加える。それ以外は変えない。
- Trusted actors／Untrusted actors: proposal/6 と同じ（Trusted は Native／DB builder、C-query の Native owner、A1／A2 の authority、sealed D1 head。Untrusted は renderer の query／seed、保存データの中身と長さ、worker の出力）。
- In-scope attacks: proposal/6 のものに加えて、大きい保存済み Revision による registration の枯渇で project 全体の Graph が止まること、上限を上げたことで frame や retained や peak が肥大すること、registration の検査で Revision が結果から黙って欠けること、保存形が B の guard を超える Revision を writer が通すこと、評価 fixture の期待値を観測に合わせて読み替えること。
- Out-of-scope attacks: proposal/6 と同じ（同じ OS ユーザーの悪意あるプロセスによる物理メモリの枯渇、プロセス全体の RSS の絶対上限、allocator や SQLite の不具合、cleanup が 100 ms の内に終わる保証）。
- Mandatory defenses: proposal/6 の Mandatory defenses を保持する。加えて次を必須にする。
  - registration は READY の前に、Revision ごとの A2 admission bytes を parse と Q の確保の前に数え（checked arithmetic）、`2,097,152 B` を超える Revision を Q に載せない。これは preflight の A2 側の部分集合で、A2 が超えれば preflight も超える。
  - 載せない Revision に達する query は、preflight で全体を typed に拒否し、Graph の寄与を 0 にして R+IR に戻す。載せない Revision が、それを通る seed の結果から何も言わずに欠けることはない。確かめられない設計は採らず、worker を READY にしない typed refusal にする。
  - writer は、保存する payload_json と envelope_json がそれぞれ `6,291,456 B` を超えるときに保存せず、typed に拒否する（RB-1）。
  - 上限を超えたら全体を拒否し、部分 Graph を出さない。worker は signal で終わらない（NOMEM を含む確保の失敗は typed な終了）。
  - per-Revision preflight（`2,097,152 B`）は緩めない。A3 の開示の行数は query の残りの records に従う（上の「records と pages」）。
  - G-03 の fixture は、新しい freeze と独立レビューの前に Graph の観測へ使わない。期待値を観測の結果に合わせて直さない。
- Acceptance implications: 「受入れ」の節のとおり。Recovery は proposal/6 と同じ。
- Lane unlocked if confirmed: CQ-LIM-1〜4（「lane」）。PUB-G はこの lane の実装を待つ見込み（K2/4 の「critical path への影響」の「Session B2 の置き方」）。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-l6-l9-contract-proposal/7 for contractId graph-limited-binding.`

## 変えないもの（と足さないもの）

- fail-safe: 上限を 1 超えたら、部分 Graph・partial generation・部分的な pack を出さず、Graph は unavailable（寄与 0）にして R+IR（Chronicle が止まっていれば exact R）に戻す。reader と busy は待たない（`0`）。取消は `1,000` steps ごと。入力と保持見積り `6,291,456 B`（peak の台帳。長い summary で 93% まで使う）、request `8,192 B`、同時 1 query、startup `30 s`、cleanup `500 ms`、S `64 MiB`、Scene `8`、2 hop も同じ。
- B の whole-set は B-close の数値のまま（qualified material `8,192`、current Revision `1,024`、Source 入力 `16 MiB` など）。B の build は測っていない。50 場面・2000 字の A2 の合計は最大 3,545,258 B（16 MiB の 21%。100 場面は 7,042,501 B で 42%）。whole-set は live Source と metadata も数えるが、その分は未測定なので、whole-set に対する余裕は見積もらない。超えたときの typed refusal と旧 sealed の保持は、今の試験で確かめられている。
- 足さないもの: 新しい authority、schema、consumer、persistent adjacency、製品入口。Graph と local 送信の入口は閉じたまま（A-1）。frame の版（NQG3）と運ぶ内容は変えない。物理メモリの証明、Native fixed-area packing、B の再認定は求めない。

## 受入れと lane

**受入れ**（N は上限ちょうど、N+1 は 1 超。時間は、機械と負荷で動くので pass／fail にしない）

- 正例（pass／fail）: lease を長くした構成（10 s の build。時間の検査と分けるため）で、records 2,048／pages 128／steps 600,000／Entity 50／edge 512／frame 上限の N が available になる。50 場面の主人公級と大 cast（8+40、12+80）の全 seed が、in-process で available（R2-1 で確認済み）。worker 経路で available なのは、R2-2 で測った seed（5+15 の m1〜m5 と c01、8+40 の m1〜m3、c01、m5、12+80 の m1、m2、c01、m5）。**それ以外は未測定で、lane の試験で取る**（records 2,048 かつ長い summary の frame を含む）。P7 案 4 では、製品形の A2 `2,097,152 B` の Revision が worker 経路で available（R2-3 で、上限の 2,094,797 B まで確認済み）。payload 形の A2 2.03 MB が available（R2-5）。**A2 が preflight を超える保存済み Revision がある project でも、worker が READY になり、その Revision に達しない query は available（P7 案 4 の実装後。未測定）。** G-03 は、作り直した frontier-exceeded が unavailable（発見 54 件）、base variant が `limit=50` で、新しい freeze と独立レビューの後に通る。
- 報告する値（pass／fail にしない）: 100 ms 維持のとき、30 場面・場面ごと review の主人公級の lease。この機の 1 分負荷平均 2.0〜2.3 で m1 83 ms、c01 75 ms（p50。表 B）。
- 負例（pass／fail）。次はそれぞれ**独立の試験**で、query 全体が typed unavailable になり、Graph の寄与 0 で R+IR に戻る: records 2,049、**pages 129**、steps 600,001、Entity 51、edge 513、frame が上限を 1 超える、preflight `2,097,153 B`（既存）。pages は Entity の数に連動して records より先に当たりうるので、records の試験で代えない。加えて、registration の preflight 超過は NOMEM に至らず typed に扱われる。**載せない Revision（A2 が `2,097,152 B` 超）に達する seed の query は、全体が typed unavailable（寄与 0、R+IR）で、その Revision を除いた node／edge の available を返さない**（独立の試験。対の正例: 達しない seed は available）。保存する payload または envelope が 6,291,457 B になる Revision を writer が保存しない。worker は signal（SIGABRT）で終わらない。
- 未測定を受入れに加える: 製品形の Revision が複数ある project を Q 16 MiB で、Entity が場面ごとに違う project を含めて（R2-4 は同じ Entity 12 件を場面ごとに review した project で、A2 948,772 B×4 件と 2 件の上限形まで）。payload 形の Revision が複数ある project。大 cast と 2000 字の組合せの peak と frame。
- 回帰: 現行の上限の内で available だった query の node・edge・順序は変わらない。既存の 24 件と G-01〜G-08 の Graph arm で確かめる。**上限を超えて unavailable だった query は、期待値が変わりうる。** G-03 の frontier-exceeded は上の作り直しで扱う。上限の値（12／144／512／100,000 など）を期待値に持つほかの試験は、lane が洗い出して同期する（`scripts/quality/nir1-graph/contract.test.mjs` など）。
- 再測: X1-3 の merge 後に、`harness/` の手順で表 A と表 C（R2-3、R2-5 を含む）を取り直す。RB-1 の閾値（counted 約 3.05 MB／約 6.15 MB）も、X1-3 が envelope の bytes を変える（X1/1 の「integrator の判断」の Q7）ので、envelope／counted の比から取り直す。**次のどれかなら、その lane は [precheck] で止まり、報告し、新しい draftRef を求める**: records・steps・Entity・edge・pages のどれかの余裕が 1.5 倍を割る、50 場面の seed が available でなくなる、registration の使用量が Q の 85% を超える、frame が上限の 85% を超える、RB-1 の閾値が上の値から動いて、確認時の保存範囲の説明（「何を変えるか」の RB-1 の行）と合わなくなる。今は payload 形の上限で Q の 73%（推定）、製品形の frame は 63%。peak の台帳（`6,291,456 B`）は値を変えないので対象外だが、報告する。

**lane**（名前は仮。C-resource の追補）

| lane | 変更 | 日数（推定） |
| ---- | ---- | ------------ |
| CQ-LIM-1 | `MAX_GRAPH_RECORDS` を Revision 用と query 用に分け、使用箇所を分類（上の分類）。records・pages・steps・Entity・edge を変え、frame と projection の検査を追従させる。N／N+1 の試験（pages を含む） | 2 |
| CQ-LIM-2 | Q、Native 領域、registration の検査。製品形と payload 形の正例（preflight 上限）、複数 Revision、超過 Revision がある project（達する seed は全体 typed unavailable、達しない seed は available）、frame 超過の試験。B への影響の確認。mutation の前に、CP-2a／CR-1 の owner／lifecycle matrix へ新しい終端（READY 前の typed refusal、NOMEM の exit 1）を足す | 3.5 |
| CQ-LIM-3 | RB-1 の writer の検査、acceptance 台帳（G-1、G-2 の [precheck]）、l6-l9 の表、品質試験の期待値の同期 | 1 |
| CQ-LIM-4 | G-03 の作り直しと同期: `g03-bounded-two-hop.v1.json`、`schema.v1.json`、`README.md`、`scripts/quality/nir1-graph/contract.mjs`／`contract.test.mjs`。新しい freeze と独立レビュー（Graph の観測の前） | 1.5 |

合計は約 8 日（推定）。CP-4 は X1-2 と X1-3 を待つ（K6/2）。CQ-LIM-4 は CP-4 の G-03 の観測の前に終え、K2/4 の addendum を作る CP-4 の観測前の commit より前にも終える（CQ-LIM-4 は `evals/nir1-graph/freeze.v1.json` の sha256 を変え、K2/4 の addendum は新しい freeze の sha を引く。「他の draft との関係」）。この lane は X1-3 と並行して実装に着手できるが、merge は X1-3 の後の再測を終えてからにする。PUB-G はこの lane の実装を待つ見込み（K2/4 の「critical path への影響」の「Session B2 の置き方」）。

## 他の draft との関係

| draft | 引いている箇所（節・項目の名前） | 影響 |
| ----- | ---------------------- | ---- |
| K2/4 `nir1-c-body-disclosure-proposal/4` | 「状態と示す場」、「/3 からの差分」の「資源」、「資源（K1 に従う）」の worker の query の項、「setup の addendum」の固定の時期と方法、「critical path への影響」の「Session B2 の置き方」 | worker の query は「確認済みの `graph-limited-binding` の版の値に従う」（K2/4 の「資源（K1 に従う）」の worker の query の項）。proposal/7 が確認されればその値になる。Scene `8` と frame の association 件数は変わらない。**確認の順序についてだけ互いに依らない**（K2/4 の「状態と示す場」と「Session B2 の置き方」）。**実装の順序と、参照している sha は依る**: CQ-LIM-4（G-03 の再 freeze）は `evals/nir1-graph/freeze.v1.json` の sha256 を変える（G-03 の fixture、schema、README、期待値レビューの記録の sha を束縛するため）。K2/4 の addendum は CP-4 の観測前の commit が作り、`freeze.v1.json` の sha256 を引くので、CQ-LIM-4 を CP-4 の観測前の commit より前に終え、addendum は新しい freeze の sha を引く。K2/4 の「freeze 済みの file を変えない」（G-02、G-07、G-08 の fixture 3 件と、freeze が束縛する schema、README、期待値レビューの記録）のうち、fixture 3 件は proposal/7 でも変わらないが、schema、README、期待値レビューの記録と freeze は CQ-LIM-4 で変わる（K2/4 は G-03 を変えない）。提示の順は integrator が決める |
| K6/2 `nir1-final-request-eval-proposal/2`（確認済み。ただし条件付きの 2 行は条件の成立まで効かない） | 「根拠: ユーザー決定（逐語）」の U2 の行（100 ms の lease の前提）、「nir1-final-request-packing-eval（新規）」の「変えないもの」（G-01〜G-08）、「graph-eval-procedure（新規・条件付き）」の「区分と許す改訂」の条件 (a)（未成立の条件付き行。窓外率 1% の判定。CP-4 と G-01〜G-08 の pool） | `100 ms` を変えない前提と合う。時間を 200 ms にする選択は、U2 の行の前提と未成立の条件 (a) に触れるので、K6/2 の扱いを別に決める。**G-03 の frontier-exceeded は上限の変更で期待値が変わる**（上の「凍結済みの評価 fixture」）。K6/2 は自分では G-01〜G-08 を変えないと言う（「変えないもの」）ので、この変更は proposal/7 の確認で行う。pool は unavailable を期待する variant を含まないので、作り直した variant は pool に入らず、窓外率の測り方は変わらない。上限の内の query の結果は変わらない（lane の回帰試験で確かめる） |
| X1/1 `nir1-scene-scope-projection-proposal/1`（確認済み） | 「scope-storage-authority」の節の、新しい上限や期限を足す場合の項、「integrator の判断」の Q7、「X1 の外に残る問題」の「資源の値」の項、「ほかの draft との関係」の「そのほか」の「K1 と proposal/7」の項、「確認後の記録」の CR-2 の境界の試験の項 | 「値は proposal/7 が見直す」に対し、投影の key と token の bytes の値は決めない。**Q7（X1-3 を含む候補での実測）は、この実測が X1-3 の前なので満たせない。** X1-3 は A2／A3 の Revision ごとの費用と envelope の bytes を変える（Q7）ので、必要量が動きうる。確認する側はこれを承知で確認する。補うのは「受入れ」の再測で、余裕が 1.5 倍を割れば lane は止まる。`typed-revision-material` の行は変えない（RB-1 の writer の検査は validator の byte 上限〔`6,291,456 B`、K1/6〕に保存形の検査を足すだけで、K1/6 は「/4 が参照する validator の byte 上限はこの行の値に従う」と定める）。X1/1 の差分（current Scope token の読み方）とは独立 |
| K4/3（確認済み）、K3/2、K5/3 | K4/3 の「要点」の「数値」の項と「11. 数値（1 turn の予算は K1b、有効期間はこの行）」。K3/2 と K5/3 は K1 を依存として参照 | history の予算は変えない（HC-1a の実測は X1-3 の後）。proposal/7 は Revision の上限（`512 records`／`6,291,456 B`）を変えないので、S6-1 の見積りの前提（Revision 入力の最大数など）は動かない見込みだが、K4/3 の「11. 数値」は proposal/7 の値が決まった後にその前提が変わらないかを確かめるとしており、確かめる作業は K4/3 の側に残る。K3/2 と K5/3 は値を引かず、影響なし |

## 確認後の記録（この draft の外で行う）

- 台帳: `graph-limited-binding` の行の draftRef と confirmedRef を proposal/7 にし、この draft の SHA-256 と確認文を記録する。`nir1-defensive-resource-limits` の行は proposal/6 のまま。固定値の列挙は、proposal/6 の「確認後の固定値」の名前（seed-local query の read／admission、batch、SQL、2hop／Entity／edge 展開／Scene、worker の Q、Native 領域）で書き、「query の records」「pages」の別名では書かない（対応は「何を変えるか」の下の表）。
- l6-l9 の proposal/6 の節の固定値と実装上の防御上限の表を、proposal/7 の値で更新する（proposal/6 の節は履歴として残す）。acceptance 台帳の RB-1、RB-2、G-1、G-2 を更新し、`scripts/quality/quality-workflow.test.mjs` など 512／100,000／12／144 を期待値に持つ試験を同期する。`evals/nir1-graph` の README、freeze、review の sha を CQ-LIM-4 の同期の対象にする。
- 確認されなかったときは、HOLD 表の [precheck]（G-1、G-2）を残し、lane は現行の値で止める。G-03 の fixture は凍結版のまま（現行の上限 12 と整合する）。

## 確認文

確認は contractId ごとに次の 1 文で行う。`nir1-defensive-resource-limits` は変えないので、確認文はない。

- I confirm draftRef nir1-l6-l9-contract-proposal/7 for contractId graph-limited-binding.
