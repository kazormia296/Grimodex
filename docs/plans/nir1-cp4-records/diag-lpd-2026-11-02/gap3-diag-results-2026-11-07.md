# CP-4 隙間 3 の dev 診断の結果（LP-D 4、run `lpd-diag-6-{1,2,3}`）

dev 専用の枝 `claude/cp4-lp-diag`（HEAD `8cf81725`、merge しない・push しない）の記録。
**integrator だけが見る診断で、CP-4 の判定・集計・閾値の選択に使わない**（DR-CP4-LPD-1 の (4)）。
製品のコード・契約・閾値・Gold・S2／S4 は変えていない。cargo・Electron の起動・run はしていない
（記録を読むだけ）。正本は設計草稿 改訂 3（枝 `claude/cp4-lapse-design`）の §9（特に §9.6）と §11、
計装の設計は [lpd-gap3-commit-instrumentation-2026-11-07.md](lpd-gap3-commit-instrumentation-2026-11-07.md)、
以前の診断は contracts の `diag-lpd-2026-11-02/README.md`、決定は master の `cp4-decisions.md` の
DR-CP4-LPD-1・DR-CP4-LAPSE-1〜3。

以下、**事実**（記録から数えたもの）・**推論**・**推奨**を分けて書く。

## 0. 入力と集計の方法

| 項目 | 値 |
| --- | --- |
| run | `lpd-diag-6-3`（2026-11-06 22:39:57Z 開始）、`-1`（22:56:53Z）、`-2`（23:13:14Z）。各 200 cycles、約 16 分。run 3 は eval build と smoke の直後に走った（開始時の load 0.56／2.76／4.30。run 1 は 0.34／0.37／1.61、run 2 は 0.88／0.82／1.02） |
| build | eval build（`8cf81725`、feature `nir1-graph-eval`）。`.node` sha256 `8b2b7ae4…6c7f`、run が使った worker sha256 `15e5a189…70c3`（eval build の受領書の worker は `1bc2014b…bc70`。以前の診断と同じく feature つきで作り直したものと読む〔推論。作り直しの記録は見ていない〕） |
| 記録の sha256 | run 1 `observation.json` `825f7f70…07af`、run 2 `b8cf0d2d…5929`、run 3 `3f8538c9…7e83`（`receipt.json` `ec68393e…a2fe`）。run 1・2 は受領書なし（§1） |
| 集計 script | `.artifacts/cp4/analyze-gap3.mjs`（sha256 `477019b9a26ecd4e587b8d0ef55e885370036715f67fe8b0c3c9fb943a58a935`）→ `.artifacts/cp4/gap3/summary.json`（`0d67a4c6…3592`）。harness の関数で行を作り直す補助 `.artifacts/cp4/gap3/rows-probe.mjs`（`55189e818c6e63447f5fd72b468128fedf84beb511411567eeca482fa21d4db0`）。どちらも gitignore 対象で、読むだけ |

- 時刻は native の eval clock（ns）で揃える。Graph の窓（ticket の `lpd.window`・`prepare`・`query`、
  `lpd.joins`）も commit の記録も同じ clock なので、以前の診断の「±5 ms の時刻の写像」は要らない。
  renderer の時刻（fetch、通知、開始時の封印）を当てるときだけ、begin の組から求めた
  （native − renderer）の幅（run ごとに約 5〜14 ms）の中点を使う。
- 窓の定義（ticket ごと。201 件×3 run）：

  | 名前 | 区間 | 中央値（3 run） | 意味 |
  | --- | --- | --- | --- |
  | 全体 | begin〜合流の終わり | 39.8〜40.2 ms | 依頼の「begin〜join」 |
  | 窓の前 | begin〜`open_window` の開始 | 15.2〜15.6 ms | gate の lease の前（begin 自身の audit を含む） |
  | 待ち | `open_window` の開始〜終わり | 0.001 ms（最大 47 ms） | gate の Graph の待ち |
  | lease の間 | `open_window` の終わり〜合流の終わり | 24.5〜24.8 ms | gate が Freshness を止める区間 |
  | 登録 | worker の prepare の開始〜READY | 11.6〜11.8 ms | post-flight の identity drift が起きる区間 |
  | query | worker の query の開始〜終わり | 5.0〜5.1 ms | query の時点の drift が起きる区間 |
  | token | worker の query の開始〜合流の終わり | 12.9〜13.0 ms | `freshness-token` の不一致が起きる区間 |

- commit が窓に「入った」は、commit の記録の `tEndedNs`（COMMIT の直後）が窓の中にあること。
  区間の重なり（`tStartedNs`〜`tEndedNs` が窓と交わる）でも数え直した（登録・query・lease の間は 3 run とも 0 で同じ）。
  区間だけの書き手（`maintenance-cycle`、`dfinal`）は重なりで数える。
- この build では、親の Graph が **親の合流の中で**（claim `pending`、Graph の窓 40 ms）表示される。
  以前の診断（第 1〜5 回）の主な欠落の場だった child（`cached`）の合流は、1 run に 0〜1 件しか起きない（§2.3）。
  これは master の DR-IRW-1〜3（#802、D を 10.84 ms から 40 ms に）を取り込んだための変化。

## 1. ring と `commitsDropped` の意味、取りこぼし

**計装のコード（事実）**：

- ring は `grimodex-db` の `nir1_lpd_diag::CommitRing`（上限 1,024）。満杯なら最も古い記録を捨てて `dropped` を 1 増やす。
- 読み（`nir1GraphEvalSamples` → `commit_log_snapshot`）は **drain しない**。その時点の最新 1,024 件の写しと `dropped` を返す。
- `commitsDropped` は **`nir1GraphEvalClearSamples`（`clear_samples` → `commit_log_clear`）からの累積**。区間の値ではない。
  `seq` は clear で戻らない（`next_seq` は clear しない）。
- harness は trace の mount の前に 1 回 clear し（run 1・2・3 の clear の時刻 1.86／1.84／1.90 s）、cycle ごとに 1 回と最後に 1 回読む（202 回）。

**取りこぼしの検査（事実）**：

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| seq で重複を除いた一意の commit | 2,766（seq 8〜2,773） | 2,766（7〜2,772） | 2,762（7〜2,768） |
| [最小, 最大] の中の欠け | 0 | 0 | 0 |
| 隣り合う読みの間の欠け（次の読みの最初の seq > 前の読みの最後の seq + 1） | 0 | 0 | 0 |
| 同じ seq の記録の不一致 | 0 | 0 | 0 |
| 読みの間に増えた記録の最大 | 16 | 16 | 17 |
| `commitsDropped` の最大（累積） | 1,742 | 1,742 | 1,738 |
| 各読みで「件数＋`commitsDropped`＝最後の seq − 最初の seq＋1」 | 成り立つ | 成り立つ | 成り立つ |

- ring が満杯になったのは 76 回目の読みから。満杯でも、読みの間の新しい記録は最大 17 件で 1,024 に遠く、
  読みを seq で合わせれば **trace の間の commit は 1 件も欠けていない**。
- 欠けたのは、clear の前（seq 0〜6／0〜7。prep と index の build の頃）だけ。最初の ticket（2.54〜2.59 s）より前なので、窓には効かない。
  最後の読みは最後の合流の終わりの約 2.7〜2.8 s 後で、窓の間に始まって終わっていない区間は無い。
- **結論：取りこぼしは分析の結論に効かない。**

## 2. run 1・2 の problems（exit 1）と、各 run が分析に使えるか

### 2.1 run 1・2：harness の集計の precheck（N-7）

- 中身（事実）：`[precheck] the product joined a Graph result later than t_raw_ready + D beyond the boundary tolerance (suspected N-7)`。
  run 1 は K6/2 の集計（`summarizeTraceK62`）、run 2 は K6/4 の集計（`classifyFollowUp`）の `classifyJoin` で投げた。
  run の後の集計で止まったので、`observation.json` と `run-report.json` は書かれ、`receipt.json` は書かれていない。
- 原因（事実）：harness の `GRAPH_EVAL_D_MS = 10.84`（`constants.mjs`。枝と master で同じ）に対し、製品の Graph の窓は
  `RELATED_SCENES_IR_EXTRA_WAIT_MS = 40`（#802）。harness の関数で行を作り直すと（`rows-probe.mjs`）、
  親の Graph が合流した行の **全部**が raw-ready の 10.84 ms より後に届いている：run 1 は 200/200（18.9〜29.0 ms、中央値 24.0 ms）、
  run 2 は 201/201（19.3〜33.3 ms、中央値 24.1 ms）。最初の行で投げる。
- これは master の `irw-decisions.md` の 31 行目が予告した形（「この変更を含む候補で CP-4 を取り直すときは、手順の新しい版が要る。
  今の版のままでは precheck で止まる」）。**run の失敗ではなく、手順の版と製品の D の不一致**。
- 分析に使えるか：**隙間 3 の分析には使える**（native の記録・commit の記録は完全。harness の時計の対応も成り立つ：
  run 1 は 202 begin＝202 記録、run 2 は 201＝201）。harness の失効の分類（K6/2・K6/4）は得られない。

### 2.2 run 3：exit 0 だが harness の行は作られていない

- 事実：run 3 は begin が 206 回、native の記録が 202 件で、harness の対応（`alignSeededBegins`）が
  「206 seeded begins, 202 records」で成り立たない。201 行すべてが `rowError` で、Graph の欄が無いので `classifyJoin` が呼ばれず、
  precheck に届かなかった。受領書の `summary` は 402 件の「lacks the snapshot record／start-time A3 record」で `invalid`。
- **exit 0 は run 1・2 より「きれい」という意味ではない。** 隙間 3 の分析（native の記録）には使える。
- 余った 4 回の begin は §2.3 の 4 件。

### 2.3 失効・表示の欠落にあたる事象（native と renderer の記録。harness の分類ではない）

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| Graph の ticket が available（run 3 の 201 件は親 197 件と、§2.3 の取り直し 4 件） | 201 | 201 | 201 |
| 登録の拒否・query の drift（`registration-unavailable`、`worker-registration-drift`） | 0 | 0 | 0 |
| 合流の無効化（`edge-holds-false` など） | 0 | 0 | 0 |
| prepare の失敗 | 0 | 0 | 0 |
| 親が `graph-ready` で表示 | 200 | 201 | 196 |
| 親が `graph-late`（窓 40 ms の後に届いた。後の `graph-ready` の取り直しの child は available） | 1 | 0 | 1 |
| 親が `graph-unavailable:cancelled`（Graph の ticket なし） | 0 | 0 | **4** |
| gate：`graphWaited`／`graphWaitExpired`／`leaseExpired`／`deferred`／`overridden` | 1／0／0／0／0 | 1／0／0／0／0 | 5／0／0／0／0 |

- **`graph-late` の 2 件**（run 1 の ticket seq 166、run 3 の 143）：begin から窓の開始まで 258／469 ms（中央値 15 ms の群から外れた「遅い群」）、
  その後 gate の待ち 47／46 ms。合流は `await-graph`／`cancelled`、取り直しの `cached` の合流は available。無効化ではなく遅れ。
- **`cancelled` の 4 件（run 3 だけ）**：4 件とも、開始時の封印の before／after の両方で Chronicle が `dirty`（B は clean）、
  begin の `initialSnapshot.indexUsable = false`、IR は `index-unavailable`。その cycle の保存の後の Chronicle の publish（tc 9）が、
  親の呼出しの **45〜135 ms 後**に来た（ふつうの cycle では親の約 400 ms 前に終わる）。publish の直後に `index-ready` が届き、
  hook の取り直し（親の 0.46〜0.54 s 後）は `graph-ready`。native の Graph の ticket は作られていない（Graph の窓が存在しない）。
  - 保存→Chronicle の publish の遅れ（tc>0 の対）：中央値 194〜202 ms、400 ms 超は run 1／2／3 で 3／2／5 cycle。
    遅い cycle は 3 run ともあるが、親の begin を越えたのは run 3 の 4 件だけ。
  - 推論：保存 → Freshness の poll の位相（1 s）→ Freshness の予約・publish → Chronicle の build（約 270 ms）→ publish の鎖が、
    hook の 400 ms の debounce より長くなった回。run 3 の load が高かったこととの関係は未確認。
  - harness の `lapseKind`（`join.mjs`）に当てはめると (i)（`i-chronicle-stop` か `i-b-seal`）に入る形（推論。run 3 は harness の行が無いので確かめていない）。
- **隙間 3 と結びつく失効は 0 件**（3 run とも、drift・無効化の失効が 0 件なので、突き合わせる相手が無い）。

## 3. 隙間 3 の頻度（書き手ごと、窓の中の commit）

### 3.1 書き手ごとの全体（事実）

| 書き手（closed word） | run 1／2／3 の記録数 | うち tc>0 | `totalChangesDelta` | `dataVersionDelta` | 区間の長さ p50／max（run 1） |
| --- | --- | --- | --- | --- | --- |
| `body-save` | 600／600／600 | 200 | 0 が 400、1 が 200 | すべて 0 | 0.41／43.7 ms |
| `freshness-commit` | 1,160／1,162／1,157 | 400 | 0 が約 760、5 が 200、>5 が 200 | すべて 0 | 0.52／199.6 ms |
| `chronicle-publish` | 208／208／207 | 200 | 0 が 7〜8、>5 が 200 | すべて 0 | 6.9／281.3 ms |
| `audit-append` | 798／796／798 | 全部 | 2 と 3 が半々 | すべて 0 | 0.79／434.9 ms |
| `maintenance-cycle` | 0／0／0 | — | — | — | — |
| `dfinal` | 0／0／0 | — | — | — | — |
| `migration` | 0／0／0 | — | — | — | — |
| `trusted-sql` | 0／0／0 | — | — | — | — |
| MCP（記録なし） | — | — | — | — | — |

- `PRAGMA data_version` は、3 run の全記録の before／after（run 1・2 は 5,532 値、run 3 は 5,524 値）で **ずっと 2**。
  推論：4 種の書き手は同じ接続で書いていて（別の接続なら互いの commit で値が増える）、**trace の間に他の接続
  （MCP の別 process、maintenance の接続など）の commit は 1 回も無かった**。
- `maintenance-cycle`・`dfinal`・`migration`・`trusted-sql` は記録 0：この trace はこれらの書き手を動かしていない
  （migration は clear の前）。**「0 回だった」は「安全だった」ではなく「試していない」**。
- `audit-append` のうち 402／run は begin 自身の 2 回（後述）、残り約 394 は cycle の中ほど（保存の約 2.5 s 後）。

### 3.2 窓の中の commit（事実。tc>0。ticket 201 件×3 run）

| 書き手 | 窓 | run 1 | run 2 | run 3 | 窓 1 つあたりの最大 |
| --- | --- | --- | --- | --- | --- |
| `audit-append` | 全体（begin〜join） | 402（201 窓、書き手の 50.4%） | 402（201 窓、50.5%） | 402（201 窓、50.4%） | 2 |
| 〃 | 窓の前 | 402 | 402 | 402 | 2 |
| 〃 | 待ち・lease の間・登録・query・token | 0 | 0 | 0 | 0 |
| `freshness-commit` | 全体 | 6（4 窓、0.5%） | 3（2 窓、0.3%） | 17（10 窓、1.5%） | 2 |
| 〃 | 窓の前 | 4（3 窓） | 1（1 窓） | 11（9 窓） | 2 |
| 〃 | 待ち（gate が Graph を待たせた区間） | 2（1 窓） | 2（1 窓） | 6（5 窓） | 2 |
| 〃 | lease の間・登録・query・token | 0 | 0 | 0 | 0 |
| `body-save` | すべての窓 | 0 | 0 | 0 | 0 |
| `chronicle-publish` | すべての窓 | 0 | 0 | 0 | 0 |
| 他の 4 種 | すべての窓 | 0（記録なし） | 0 | 0 | 0 |

- 窓の中の commit の `dataVersionDelta` は全部 0、`totalChangesDelta` は audit が 2／3、Freshness が 5／>5。
- **drift が起きる区間（登録・query・token）と gate の lease の間には、3 run の 603 件で、どの書き手の commit も 0 件**
  （区間の重なりで数えても 0）。
- 窓の中の Freshness 以外の commit は、begin 自身の audit の 2 回だけで、全部が窓（lease）の前。
  D′ は begin の audit の commit の後まで待つ設計（設計草稿 §3.0 の「仕組みの欠落」）なので、窓の外に置かれている。
- 窓の中の Freshness の commit は gate の待ちと窓の前だけ。gate の待ちは 7 回とも 50 ms 未満で、期限切れ（隙間 1）は 0。

### 3.3 「遅い群」の正体（副次の事実。§3.4 で未調査だったもの）

- begin から窓の開始まで 60 ms を超えた ticket：run 1／2／3 で 5／5／7 件（最大 274／255／469 ms）。
- 17 件中 16 件で、その区間に重なる最も長い区間は **begin 自身の `audit-append`**（58〜294 ms）、1 件は Freshness の予約（232 ms）。
  重なりの和は区間の 83〜99.5% を覆う。
- 推論：遅い群は、begin の audit の区間（`BEGIN IMMEDIATE` の前から COMMIT の後。durable commit なら fsync を含む）が
  長い回に一致する。区間のどこが長いか（lock の取得、fsync）は計装が分けていない。`graph-late` の 2 件はこの群に入る。

### 3.4 3 run の差

- 隙間 3 の数は 3 run とも 0 で差が無い。
- run 3 は、gate の待ち（5 回。run 1・2 は各 1）、窓の中の Freshness（17。run 1・2 は 6／3）、Chronicle の未 publish の親（4。run 1・2 は 0）が多い。
  run 3 は build の直後で 15 分の load が 4.30 だった（log）。関係は未確認。

### 3.5 一様に来たと仮定したときの比較（推論）

- Freshness 以外の tc>0 の commit（begin 自身の audit を除く）は 1 run に 794〜796 件、lease の間の和は 4.87〜4.92 s／約 961 s、
  登録＋query の和は 3.39〜3.42 s。位相が一様なら lease の間に約 4.0 件／run、登録＋query に約 2.8 件／run 入る見込み。
  実測は 3 run とも 0（一様のポアソンなら 1 run で 0 になる確率は約 2%、3 run 続けてなら約 6×10⁻⁶）。
- つまり **この dev trace では、保存・Chronicle・audit の commit が編集の cycle に位相を固定されていて、Graph の窓から構造的に離れている**。
  0／603 は「この trace の拍子では入らない」ことを示すが、位相の固定されない書き込み（AI の書込み、別の window の保存、
  MCP、別の Scene の Chronicle の build、maintenance）での頻度は示さない。
- 参考の見積もり（推論）：位相が一様な Main の接続の commit が毎秒 r 回あると、1 query が登録か query の区間（約 17 ms）で
  drift に当たる確率は約 0.017·r。物差し（1%）に相当するのは r ≈ 0.6 回／s。token の区間で合流を無効化するのは
  `freshness-token` を動かす commit（Freshness の publish）だけと読める（以前の診断の第 2 回）。

## 4. 設計 §9 の問いへの材料

### 事実

1. 隙間 3 はどの書き手から来るか：この dev trace（603 件）では、drift の区間と lease の間に入った書き手は **無い**。
   Freshness 以外で窓（begin〜join）に入るのは begin 自身の audit だけで、全部 lease の前。`body-save`・`chronicle-publish` は 0。
   `maintenance-cycle`・`dfinal`・`migration`・`trusted-sql`・MCP は、この trace では動いていない（記録 0、`data_version` は不変）。
2. 頻度：隙間 3 による失効 0／603（95% 上限は片側で約 0.5%＝3/603。dev fixture・dev build・3 run）。
   ただし §3.5 のとおり trace の拍子による 0 で、位相の固定されない書き手の頻度の上限にはならない。
3. 隙間 1（X+ の対象）：`graphWaitExpired` 0／603、gate の待ちは最大 47 ms。この 3 run は X+ が要る材料を出していない。
4. 隙間 3 以外に、表示の欠落の形が 2 つ見えた：(a) Chronicle の publish が親の begin より後になる（run 3 で 4／201。
   harness の規則なら (i) に入る形〔推論〕で、1 run で正式の物差し 2 件を超える数）、(b) begin 自身の audit の区間が長く、
   Graph が窓 40 ms に間に合わない `graph-late`（2／603）。どちらも gate の外の機構で、隙間 3（窓の中の commit）ではない。
5. 今の harness の手順（D＝10.84 ms）は、master の製品（D＝40 ms）では集計の precheck で止まる（§2.1、`irw-decisions.md` の予告どおり）。
   正式の再測定（§8.2 の手順）には、手順の新しい版が先に要る。

### 推奨（integrator の意見。判断はユーザー）

- 隙間 3 のために製品を変える理由は、この診断からは出ない。§11 の決定（X+ は採らない、HOLD のまま設計に戻る規則は維持）を変える材料も無い。
- 隙間 3 の上限を言いたいなら、自然な trace をこれ以上回すより、§9.6 の (2) の**注入の表**（窓の中で書き手を 1 種類ずつ動かす）か、
  位相を固定しない書き手（AI の書込み、MCP、maintenance）を含む trace が要る。自然な trace の 0 は、拍子が同じなら何回回しても同じになりやすい。
- 正式の再測定より前に見るべきは、隙間 3 より **(a) Chronicle の未 publish の親**。dev の 1 run で 4 件出ていて、正式の trace の拍子で
  同じことが起きれば物差しに直接効く。頻度（追加の dev run での再現）と、hook の debounce と Chronicle の build の鎖の関係を、dev で確かめるのがよい。
- 手順の版（D＝40 ms）の改訂と CP-4 の取り直しはユーザーの決定（DR-IRW-3）。この診断はその前提を確かめただけ。

## 5. 計装の限界

- **取りこぼし**：trace の間は 0（§1）。clear の前の 7〜8 件だけ欠け、窓より前。
- **時刻のずれ**：dev build では renderer 起点の SQL（読み取りを含む）ごとに、ロックの中で `total_changes()` と `PRAGMA data_version` を読む。
  その費用はこの記録から分けられない。ticket の settle の中央値は 32.4／32.5／32.6 ms（以前の第 5 回は 33.4 ms）だが、
  製品も master の取り込みで変わっているので、計装の影響と分けられない。race が原因の事象は計装でずれうる（DR-CP4-LPD-1 の限界）。
- **commit の時点**：`tEndedNs` は COMMIT の後の値の複製の後。点で数えたときの誤差は µs のオーダーで、区間の重なりで数えても結論は同じ。
- **MCP と他の接続**：MCP は計装していない。`data_version` が全記録で不変なので、trace の間に他の接続の commit は無かったと読めるが、
  検出の時刻の分解能は記録の間隔（数百 ms〜数 s）までで、窓の中の時刻は決められない。この trace は MCP を動かしていない。
- **動かしていない書き手**：`maintenance-cycle`、`dfinal`、`migration`、`trusted-sql` は記録 0。0 は「試していない」。
- **dev build と正式の候補の違い**：計装の入った `.node`・worker（feature つき）で、正式の候補の bytes と違う。dev fixture は S4b'''' の凍結した trace と違う。
- **harness の分類が無い**：run 1・2 は precheck（D の不一致）、run 3 は対応の不成立で、3 run とも K6/2・K6/4 の失効の数を持たない。
  この記録の「失効」は native の ticket・合流の結果と renderer の `graphOutcome` から読んだもの。
- **回数**：3 run。run 3 は load が高い状態で走った。
