# NIR-1 C-body 契約提案 proposal/4（draft）: Graph が追加する Scene の本文開示と Scene Scope v2

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-c-body-disclosure-proposal/4`。`nir1-c-body-disclosure-proposal/3`（と、/3 が置き換えた /2）を置き換える（「/3 の扱い」） |
| contractId | `graph-target-scene-body-disclosure`（新規）、`scope-storage-authority`（`nir1-l6-l9-contract-proposal/3` の確認済み行への差分。Scene Scope v2 の保存）。X1/1 も `scope-storage-authority` に別の差分（Scope 世代と Scene Scope 投影）を持つ。confirmedRef が違う別の行で、この draft の差分とは互いを前提にしない（「確認の扱い」） |
| 状態と示す場 | draft。未確認。この draft は確認文ではない。継続計画 §1 の SB-1〜SB-5 はユーザーの選択や指示で、確認ではない。Session B2 で示す（資源の proposal/7 と一緒に示すか、先に単独で示すかは integrator が決める。「critical path への影響」） |
| 起案日と基点 | 2026-10-14 に /3 からこの /4 へ改めた。コードと master の文書の事実は origin/master `14fd3cfc`（#662 X1-1 の merge。Tree `ab048e0b`）で `git grep` と `git show` によって確かめ、行番号はこの commit のものを書く。`l6-l9:N` は `14fd3cfc` の [L6〜L9 実行計画](nir1-l6-l9-execution-plan.md)（sha256 `5257fe1d…`）、`post-B` は [残工程実装計画](nir1-post-b-execution-plan.md)（`2cdea44b…`）、`候補` は [Scene 接続候補](nir1-c-scene-connection-candidate.md)（`ebba78c6…`）、`cont:N` は `docs/plans/nir1-continuation-2026-10.md`（`672801fe…`。この branch にはない）の、`14fd3cfc` の版の行番号と節である。この branch の作業ツリーにある同名の file（l6-l9、post-B、候補）は `a153743b` の版で、行番号が違う（/3 はその版の行番号で引いていた。引き直しの対応は「/3 からの差分」） |
| 整合を取った文書 | Session B1 の提示版: K3/2（`nir1-d2a-activation-proposal/2`。[draft](nir1-d2a-activation-proposal-2-draft.md)）、K4/3（`nir1-d2b-history-mapping-proposal/3`。[draft](nir1-d2b-history-mapping-proposal-3-draft.md)）、K5/3（`nir1-d2b-local-send-proposal/3`。[draft](nir1-d2b-local-send-proposal-3-draft.md)）、K6/2（`nir1-final-request-eval-proposal/2`。[draft](nir1-final-request-eval-proposal-2-draft.md)）、X1/1（`nir1-scene-scope-projection-proposal/1`。[draft](nir1-scene-scope-projection-proposal-1-draft.md)）、DSN（`nir1-dsn-2026-10`。[draft](nir1-dsn-2026-10.md)）。どれも未確認で、並行して最後の仕上げ中であり、同じ commit で示される。下の「引用の約束」のとおり引く。sha256 で引くもの: K2/3（`nir1-c-body-disclosure-proposal/3`。[draft](nir1-c-body-disclosure-proposal-3-draft.md)。未確認。`b847ca02…`）、K4/2（`nir1-d2b-history-mapping-proposal/2`。未確認。`c4d6a153…`。K4/3 が置き換える）、K1（`nir1-l6-l9-contract-proposal/6`。2行とも 2026-10-12 23:58 JST に確認済み。`14fd3cfc` の `docs/plans/nir1-l6-l9-contract-proposal-6-draft.md`、sha256 `5528f4e0…`。branch の commit `ba7ceb46` の版と同じ bytes）。G-01 の fixture `evals/nir1-g01/fixture.v1.json`（`996ef1c0…`）。CP-0 の fixture（C16）。SPIKE S1 の報告（2026-10-13、作業記録。C14） |
| 確認済み baseline | `nir1-l6-l9-contract-proposal/3#scope-storage-authority`（l6-l9:129、:143-152）。関連する確認済み行（l6-l9 の proposal）: /3 の `caller-profile-egress`（l6-l9:130、:154-163）、/4 の `typed-revision-material`（l6-l9:131、:165-175）、/6 の `graph-limited-binding`（K1。l6-l9:132、:250-316。/5 の資源の値を改訂した行）と `nir1-defensive-resource-limits`（K1b。l6-l9:133、:318-357） |
| 確認を求めるもの | Option B（作者が本文全体を宣言する）の2行。Graph が Related Scenes に追加する Scene の本文を開示する authority と、その宣言を保存する Scene Scope v2 の差分 |
| 変えないもの | Gold、G-01 の fixture v1 と指標、CP-0（#639）が固定した G-02〜G-08 の fixture、Gold、期待値、前提条件（`evals/nir1-graph/freeze.v1.json` が束縛する file）、P の固定値、K1 の値、`nir1-l6-l9-contract-proposal/3`〜`/6` の他の条項、X1/1 の差分（Scope 世代を進める writer の範囲、本文 Source の token の単調な変化、Scene Scope 投影）、R と R+IR の結果、Graph と local 送信の製品入口（A-1。閉じたまま）。AI 送信、Packing、履歴、export には開示しない |
| /1 と /2 の扱い | `nir1-c-body-disclosure-proposal/1`（2026-09-25 の Codex draft、sha256 `904adad5…`）とその確認の記録は、U1 により参照にとどめる。この draft は /1 の文面を使っておらず、/1 の確認を根拠にしない。`nir1-c-body-disclosure-proposal/2`（2026-10-12、未確認。`c8a44283…`）は /3 が置き換えた。どちらの本文も書き換えていない |
| /3 の扱い | `nir1-c-body-disclosure-proposal/3`（2026-10-14、未確認。`b847ca02…`）を置き換える。/3 は確認を求めておらず、未確認のまま superseded にする。/3 の本文は書き換えていない。この /4 は /3 の本文を引き継ぎ、「/3 からの差分」の表の点だけを直した |
| 版の経緯 | 2026-10-12 に /2 を、2026-10-14 に /3（K3 を O-2、K5 を C に書き直した SB-1 と、Web Editor の廃止の SB-2 に合わせた版）を起案した。この /4 は 2026-10-14 に、X1/1 の「ほかの draft との関係」の K2 の表、K3/2 の「区分の構成」の「宣言 UI（本文の宣言と取消）」の行、DSN §7.3 の `BodyDeclaration` の行、K6/2 の「/1 からの差分」の #39 の求め、K4/3、`14fd3cfc` までに merge されたもの（CR-2、CQ-OPT、DOC-REC、B-GUARD、X1-1）に合わせた。確認はこの /4 に対して、改めて逐語の確認文で行う。2026-10-17 に、確認前の review の P3 の指摘 4 点（取消の入口に grant を要する案の日数、freeze 済みの `setupOrder` との関係、K2/3 を引く Session B1 の提示版の読み替えの表、要点の「ユーザーが選ぶ点」の表）を直した。さらに最終確認の指摘で、frame の版の記述（NQG2→NQG3）、選ぶ点の呼び名（K2-1〜K2-3）、資源の proposal/7 が確認された場合に freeze が変わりうることの一言を足した。確認の意味と選択肢は変えず、addendum の参照先の条件（新しい freeze の sha256）を明記した |

断りがなければ、コードの場所は `src-tauri/crates/grimodex-db/src/` からの相対パス。

引用の約束: Session B1 の提示版（K3/2、K4/3、K5/3、K6/2、X1/1、DSN）は、文書名と、節・項目の名前や番号で引く（例: 「X1/1 の『ほかの draft との関係』の K2 の表」）。sha256 と行番号は書かない。各ファイルの sha256 は、integrator が作る `docs/plans/nir1-session-b1-manifest.md` に記録される。K2/3、K4/2、確認済みの文書（K1）は sha256 で引き、master の文書（`l6-l9:N` など）とコードは commit と行番号で引く。Session B1 の提示版が K2/3 を引く箇所は、確認で凍結されて直せないので、この K2/4 を引くものと読む。対応は「ほかの draft との関係」の表にある。

用語:

- **Graph-only target** は、Graph の path が到達した Entity に pin された Scene のうち、R+IR の結果にないものを指す。Related Scenes の共通追加1枠に入りうる（l6-l9:653、DSN §2.3）。R+IR にすでにある Scene には、この draft の判定を使わない（既存の excerpt と anchor のまま。Graph は path の Evidence を足すだけ）。
- **v1 の token**: Scene ごとの A1 の binding（`narrative-scene-scope/1`）の `source_token`。registry と、A1 の状態、incarnation、version、updated_at の digest である（C2）。X1/1 は binding の version を「Scope 世代」と呼ぶ。
- **本文 Source の token**: 本文の Source `project:scene:<id>` の token `v{tree_nodes.version}@{updated_at}`（C3）。
- **X1-2 の前、X1-2 の後**: X1-2 は、X1/1 が確認された後に、v1 を進める writer を Scope に効く編集に限り、本文 Source の token の単調な変化を Native が保証する段階である（X1/1 の「先に進める部分と `[precheck]` で止める部分」）。「X1-2 の前」は、X1-1（#662）が merge された今の master（`14fd3cfc`）の挙動を指す。X1/1 が確認されない場合も、この挙動が続く。
- **観測前の commit**: CP-4 が、G-01 と G-02、G-07、G-08 の Graph arm を最初に観測する前に入れる commit（「確認の扱い」）。

## /3 からの差分

この /4 は、/3 を次の点で直した。Graph-only の excerpt の開示の範囲、v1 の宣言の値、veto、利用時の判定、COMMIT の結果が分からないときの扱い、canonical locator、G-01 と G-02／G-07／G-08 の addendum が宣言する Scene と値、Option B を推奨することは変えない。

| 項目 | /3 | /4 |
| ---- | -- | -- |
| draftRef と確認文 | `…/3` | `…/4` |
| コードと master の文書の基点 | コードは `a153743b`。`87f0da94` で確かめ直し、位置が変わった引用に `87f0da94` の行番号を併記した。l6-l9、候補、post-B は `a153743b` の版の行番号で引いた | コードも master の文書も `14fd3cfc` で確かめ直し、行番号をこの commit のものに揃えた。l6-l9 は :28→:40、:97→:129、:108→:141、:110-119→:143-152、:113→:146、:136→:169、:431-432→:576-577、:460-476→:605-621、:471→:616、:506→:653、:560→:707、:620→:762。候補は冒頭に G0 の注記が 2 行入ったので、:215-216→:217-218、:233→:235、:240-241→:242-243。post-B は節で引き、引いた §4.4、§7.1〜§7.3 の文は `14fd3cfc` の版でも同じである。K1 は master の file（`5528f4e0…`）で引く |
| 引用する draft | K3 の /2 を sha256 `305ab2b4…` で、DSN を作業ツリーの sha256 `19316bdd…` で引き、整合の基準にする DSN の版を選んでいた | Session B1 の提示版（K3/2、K4/3、K5/3、K6/2、X1/1、DSN）は、文書名と節・項目で引き、sha256 と行番号を書かない（「引用の約束」）。DSN の版を選ぶ記述は外した |
| ユーザー決定の呼び名と時刻 | UB1（2026-10-13 19:41 JST）、UB2 | 継続計画 §1 の SB-1〜SB-5 に改めた。時刻は §1 の表記（SB-1 は 2026-10-13 19:40 JST、SB-2 は 2026-10-14 04:06 JST、SB-3〜SB-5 は 2026-10-14 10:02 JST）。/3 の UB1 は SB-1、UB2 は SB-2 にあたる。SB-3〜SB-5 の行を足した（「根拠」） |
| 前提（コード） | C1〜C16（`a153743b`。一部に `87f0da94` を併記） | `14fd3cfc` で C1〜C16 を確かめ直した。中身が変わったのは C2（X1-1 の folder の refresh を足し、project snapshot の本文の restore は binding を作り直すと改め、X1-2 の後の挙動を書いた）、C8（X1-1 で tree の世代が project の token から外れた。本文の保存での全件 stale は X1-2 まで残る）、C10（schema は 42 のまま。X1 の設計 A との採番）、C14（B-GUARD）。ほかは行番号の引き直しである。C17（feed の transaction は kind を問わず Index を dirty にする）と C18（grant なしに宣言を失効させられる既存の入口）を足した |
| X1 への整合: 本文と title による失効の根拠 | 本文、title、A1 の変更は同じ transaction で v1 の version を進めるので、失効した宣言は戻らない（/3 の「失効」の最初の項） | X1-2 の前は v1 の token で、X1-2 の後は本文 Source の token と title の digest で失効し、本文 Source の token が同じ restore epoch の中で以前の値に戻らない（X1/1 の Delta の 1）ので戻らない、と書き分けた。restore は宣言を消すので、restore を跨いで token が戻ることは宣言に響かない。X1/1 が確認されない場合と、X1/1 の Q1〜Q3、Q6 で別の案が選ばれた場合に変わる箇所を、「X1 への依存」として新設した |
| X1 への整合: C2、C8、C15 | C2 は、本文の保存、rename、AI Apply、bulk、順序と story time の操作、Codex の rename の波及、本文版と project snapshot の restore が v1 を進めるとした。C8 は、本文の保存で v1 と tree が進み、承認済みの Revision がすべて stale になるとした | C2 を、今の master の writer（X1-1 の folder の refresh を含む）と、X1-2 の後の writer（X1/1 の「writer の網羅表」）に書き分け、project snapshot の本文の restore は binding を作り直す（X1/1 の F19）とした。C8 を、X1-1 の後の project の token の式（tree の世代を含まない）と、X1-2 の前の事実（binding の refresh による全件 stale）に改めた。C15 は v1 の token の照合の記述として有効で、行番号だけを直した |
| X1 への整合: 失効の表 | 本文の保存、AI Apply、rename の行は「v1 の token が変わり」。registry の行は project の全件失効 | 「X1-2 の前」と「X1-2 の後」の列に分けた。本文の保存と rename は、X1-2 の後は「本文の Source（rename は title の digest も）が変わり」。AI Apply は Scope に効く更新（parentId、sortOrder、archivedAt）のときだけ v1 を進め、題名だけの更新では title の digest と本文 Source の token で失効する。章（folder）の構造の変更の行（X1-1）を足した。project snapshot の restore の行は、本文を含む scope では binding の行が作り直される（X1/1 の F19）と書き、宣言のクリアは scope によらず project の宣言を NULL にすると明記した。registry の行は X1/1 の Q2 に従う（「X1 への依存」の XK-3） |
| X1 への整合: 失効の範囲、変更前後、`scope_extension_digest` | 「v1 の token を進める既存の操作（本文の保存、registry の変更など）は宣言を失効させる」「v1 の version と token: 設定の変更、本文の保存などで進む」「v1 の binding、reader、token の計算、A1 の保存の payload、project の Scope authority の digest は変えない」 | 「Scope に効く編集と registry の変更は v1 を進めて宣言を失効させ、本文と title の更新は本文 Source の token と title の digest で失効させる（X1-2 の前は、本文と title の更新も v1 を進める）」「設定の変更と Scope に効く編集で進む（X1-2 の前は、本文の保存と Scene の patch でも進む）」「宣言の書込みは `scope_extension_digest` の入力を変えない」に改めた（X1-1 が tree の世代の引数を外した） |
| 章（folder）の構造の変更 | 記述なし | X1-1 で、生きた Scene を含む folder の移動、並べ替え、archive とその戻しが配下の Scene の v1 を進めるので、配下のすべての宣言が失効し、戻しても戻らない。可用性、ダイアログの文面、失効の表、addendum の「宣言の後に変えないもの」に足した |
| 取消の入口の grant | grant を要さない。K3 の /2 の行は「K3 の /1 の同じ行と byte 同一」で、「2つの入口をまとめて grant を要し」と書くが、取消は要さない、とした | K3/2 の「区分の構成」の「宣言 UI（本文の宣言と取消）」の行は、本文の宣言の入口は K2 の Main grant（`BodyDeclaration`）を要し、取消の入口の grant は K2 の確認に従う、と改められた（K3 の /1 の同じ行とは違う）。/3 の 2 つの記述を直した。取消の入口に grant を要さないことを、乗っ取られた画面が grant なしに取消を呼べる場合と grant を要する場合の影響と利用者の負担を比べて決めた（`scope-storage-authority` の「writer」の「取消の入口と grant」）。DSN §7.2 と §7.3 と食い違わない |
| grant の束縛 | OCC は v1 の version と、宣言の現在の token か NULL | OCC に v1 の token を足した。X1 で binding の版（v1 の version）が進む編集が変わること（X1-1 で章の構造の変更でも進み、X1-2 の後は題名と表示の更新では進まない）と、grant の束縛と宣言の失効の関係を書いた（「Main の一回限りの確認」の「X1 と grant の束縛」） |
| 宣言の feed と Index の dirty | 「この kind の event だけで…Index（B の Graph index と Chronicle の IR の Index）の Freshness も dirty にならず」と要件だけを書いた | 今のコードでは、feed の transaction ごとに、kind を問わず Chronicle と Graph の Index が dirty になる（C17）。宣言の kind の event だけの transaction を dirty から外すことを、この差分の変更として明記し（委任ではなく、この行の確認の範囲）、試験を足した。X1/1 の X1-5（Q6）とは互いを前提にしない |
| 観測前の commit の担い手 | S1 の harness を取り込む lane（`G01-RM` か CP-4）が、Graph arm を最初に観測する前に入れる commit | CP-4 が、Graph arm を最初に観測する前に入れる commit に改めた。K6/2 の「選択肢と推奨（測り直しの lane）」の案2（S1 の harness の取り込みを DA-1 に前倒しする）では /3 の定義が合わない、という K6/2 の #39 の求めへの答えで、どの案でも担い手は CP-4 の1つになる |
| addendum | — | 宣言の段の前後で B と Chronicle の sealed generation が変わらないことを、測定の receipt で確かめる項を足した（C17 の手当ての確認）。宣言の後に変えないものに、宣言した Scene を含む folder の構造を足した |
| K4 の引用 | VerifiedWorkspaceBinding は K4 の durable identity で要る（K4 の /2） | K4/3 の §7 の durable workspace identity（workspace ID の digest と canonical locator の digest の組。DSN §7.3 の VerifiedWorkspaceBinding にあたる）に改めた。canonical locator の節は /3 から変えていない（K4/3 の「確認に出す前の照合」の (14) が照合した規則のまま） |
| 選択肢と critical path | 計画の目安に置き、`87f0da94` までの merge（CP-0、CP-1、CP-2a、B-ROUTE、DT-1〜3、HP-1、CR-REC）を書いた | CR-2、CQ-OPT、B-GUARD、X1-1 の merge、X1/1（確認されれば CP-4 は X1-2 と X1-3 の merge を待つ）、SB-4 と SB-5（proposal/7）、Session B2 の置き方を見直しの前提に足した。Option A の評価の改訂がまだ起案されていないことを、Option A の日数に書いた。推奨は Option B のまま（「選択肢と推奨」） |
| 資源 | `graph-limited-binding`（proposal/6）の固定値に従う | 確認済みの `graph-limited-binding` の版の値に従う（今は proposal/6。proposal/7 が確認されれば、その値）と改めた。この draft の確認は proposal/7 に依らない |
| Out-of-scope と受入れ | — | 乗っ取られた画面による Graph-only の開示の妨害（取消、本文の再保存など。可用性）を Out-of-scope に足した。In-scope に取消の入口の悪用を足した。題名の A→B→A と割り込み、章の構造の変更、取消の入口、Index の dirty の試験を受入れに足した |
| 確認後の記録 | — | X1/1 の差分との並び、DSN の改訂の項（v1 の token、X1 の注記）、X1-2 と X1-3 の TASK に写すこと、CB-1 の TASK の Index の dirty の除外、K3/2、K4/3、K6/2 への申し送りの扱いを足した |

## 要点

### ユーザーが選ぶ点とその推奨

| 呼び名 | 選ぶ点 | 選択肢 | 推奨 | 選ぶと変わること | 詳細 |
| - | ------ | ------ | ---- | ---------------- | ---- |
| K2-1 | C-body の方針 | Option B（作者が本文全体を宣言する）／Option A（fail-closed のまま、G-01 の評価を改訂する） | Option B | A は PUB-G を約3日早めうる（推定）が、評価の改訂は未起案で、B2 の後の確認の往復で利得は打ち消されうる。E は計画の目安の下では早まらない見込み。B は宣言の失効が多く、可用性が低い | 「選択肢と推奨」、「critical path への影響」 |
| K2-2 | 確認する行（Option B のとき） | 2文とも確認する／`scope-storage-authority` の1文だけ確認する | 2文とも | 1文だけでは CB-1（保存とクリア）しか始められず、宣言の writer（CB-2）と reader（CB-4）は始めない | 「確認の扱い」 |
| K2-3 | 取消の入口に grant を要するか（Option B のとき。2文の確認で、この点も推奨どおりに決まる） | 要さない／要する | 要さない | 要する場合は CB-2 に +1〜2 日（推定）、PUB-G の目安は D+21〜27 になりうる。DSN §7.2〜§7.3 の改訂も要る。守れる範囲は増えない | 「scope-storage-authority」の「writer」の「取消の入口と grant」 |

ユーザーが選ぶのは上の K2-1〜K2-3 の3点だけである（K2- の接頭辞は、同時に示す proposal/7 の選ぶ点 P7-1〜P7-4 と取り違えないための呼び名）。Session B2 で資源の proposal/7 と一緒に示すか単独で示すか、委任で決める技術判断（「委任で決めること」）、X1/1 の確認は、ここに含めない。

### 規則と評価の要点

- 推奨は Option B。作者が Scene の本文全体（title を含む）について開示の宣言をし、Main の一回限りの確認を経て Native が保存する。Graph-only target は、宣言が current で、利用時の判定をすべて通ったときだけ、title、本文の先頭の非空行の excerpt、その anchor への遷移を出す。
- v1 で宣言できる値は G-01 subset（story・auto・phase は independent、reveal は non-secret、POV は independent）だけ。ほかの値は writer が拒否し、reader は unavailable にする。
- 本文は worker ではなく parent が読む。frame の token と宣言の束縛に exact に一致することを確かめてから読み、query ごとに最大1件にする（DSN §2.3）。
- Graph-only の候補が不適格なときは、判定のどこで外れても、上限を超えても、追加1枠を出さないだけにする。R+IR とその path の付加は変えず、renderer へ返す理由は候補がない場合と同じ1つの code にする（DSN §2.3 の all-or-nothing を R+IR の path の付加に限る。K1 の C-body の fail-safe と同じ）。
- veto に使う記録は、target に掛かる secret の foreshadow、target を reveal の Scene に指定したか target に結ばれた secret な Chronicle event、Scene と beat の POV である。
- 宣言は、本文、title、A1、incarnation、workspace のどれかが変わると、束縛の不一致で失効する。本文と title の変更による失効は、X1-2 の前（今の master）は v1 の token と本文 Source の token で、X1-2 の後は本文 Source の token と title の digest で決まり、どちらでも戻らない（X1-2 の後は X1/1 の Delta の 1 の保証に依る）。生きた Scene を含む章（folder）の移動、並べ替え、archive とその戻しは、配下のすべての Scene の宣言を失効させる（X1-1。#662 で merge 済み）。timeline、worldline、layer の registry を変えると、project のすべての宣言が失効する。restore と Safe Mode からの restore は、Ready の前に宣言を消す。
- 宣言の操作（宣言、取消、クリア）は行の宣言の2列だけを書き、v1 の列（version、token、`updated_at` を含む）を書き換えない。feed は A1 とは別の object kind で書き、その kind の event だけの transaction では Index を dirty にしない（今のコードは kind を問わず dirty にするので、CB-1 で外す。C17）。このため、承認済みの Revision を巻き込んで失効させず、pending にもせず、Graph と IR を止めない（C15、C17）。
- 取消の入口は grant を要さない。乗っ取られた画面が grant なしに取消を呼べても、できるのは開示を止めることだけで、同じことは grant のない既存の入口（本文の再保存、title の変更、A1 や registry の変更、veto の記録の追加。C18）でもできる。害は作者が改めて宣言する手間（Scene ごとの確認）で、取消に grant を要しても防げる範囲は増えず、開示を止める操作にダイアログの手間が加わる。取消にも grant を要する案を選ぶと、CB-2 に +1〜2 日（推定）が加わる（`scope-storage-authority` の「writer」の「取消の入口と grant」）。
- 宣言を書く COMMIT の結果が分からなければ、exact な識別子で読み直す。それでも決まらなければ、その workspace での宣言の書込みと開示を再起動まで止める。pending marker は作らない。
- PUB-G までは、宣言の入口（preview、宣言、取消）を Native の gate で閉じる。PUB-G より前に開くのは、評価用の CI seam が有効な起動だけである。この seam の owner token と nonce は秘密ではないので、packaged でない起動で env をそろえた者は、ダイアログなしで宣言を承認できる。これは残余として受け入れる（その者は DB を直接書ける。`graph-target-scene-body-disclosure` の Out-of-scope）。
- G-01 の正例と、G-02／G-07／G-08 の追加 Scene の正例は、この2行に加えて、B の sealed binding を正規の経路で確立できること（計画の B-ROUTE）に依存する。S1 で、`a153743b` の製品にその経路がないと分かり（C14）、B-ROUTE がそれを足した（#643 で merge 済み。gate は既定で閉じる）。B-GUARD（#660）で、setup に残る下書きや却下の Revision が B の build を止めることもなくなった。この経路で確立できることは、CP-4 の前提条件（`b-sealed-binding`）で確かめる。確立できなければ、宣言があっても G-01 は Hold のまま（候補 :242-243）、G-02〜G-08 の variant は `blocked:b-sealed-binding` と記録される（CP-0 の前提条件）。X1/1 が確認されれば、CP-4 は X1-2 と X1-3 の merge も待つ（K6/2 と X1/1 の「確認後の記録」）。
- 宣言する Scene は `g01-mira` だけではない。CP-0（#639）が固定した G-02 base、G-07 base、G-08 の base-usable と graph-recovered も、Graph-only の追加 Scene を期待値に持つ（`g02-tamsin-first`、`g07-pell-dock`、`g08-cass-attic`。C16）。固定済みの `setupOrder` に宣言の段はなく、宣言がなければこれらは返らず Hold になる。Option B では、評価の setup の addendum の対象をこの4つの Scene に広げる。値は G-01 と同じ v1 の subset で、4つとも veto に当たる記録を持たない。fixture、期待値、前提条件は変えない。addendum は観測前の commit（CP-4）で固定し、critical path には載らない（0.5〜1 日、並行。推定）。
- X1/1 は `scope-storage-authority` に別の差分を持つ。2つの差分は互いを前提にせず、どちらの順で確認されても合わさる。この draft の規則と試験は、X1/1 が確認されない場合（X1-2 の前の挙動が続く）も、推奨どおり確認された場合（X1-2 の後）も成り立つように書いた（「X1 への依存」）。
- Option A（fail-closed のまま、G-01 の評価を改訂する）は、Graph の公開（PUB-G）を3日前後早めうる（推定）。ただし Option A の評価の改訂（`g01-eval-revision` の新しい draftRef と、CP-0 が固定した G-02、G-07、G-08 の改版）はまだ起案されていない。Session B2 で Option A が選ばれると、その後に起案、独立した期待値の review、確認の往復が要り、その利得を打ち消しうる。NIR-1 の完了（E）は、計画の目安（PUB-G D+20〜25、PUB-L D+30〜35）の下では、Option A でも早まらない見込みである（「critical path への影響」）。Option A は、Graph が新しい Scene を見つける機能を失う。Option B も、G-02、G-07、G-08 には宣言の addendum が要る（観測前に固定し、critical path には載らない）。

## 確認の扱い

- 確認は contractId ごとに、末尾の「確認文」の 1 文で行う（l6-l9:141）。1 文で確認されるのはその contractId の行だけで、もう一方の行や依存する契約は確認されない。
- 2文はどちらも Option B を確認する。Option B の実装には2文とも要る。`scope-storage-authority` だけが確認された場合は CB-1（保存とクリア）だけを始められ、宣言の writer（CB-2）と reader（CB-4）は始めない。
- Option A を選ぶ場合は、どちらの文も出さない。C-body は fail-closed のまま閉じ、G-01 の評価の改訂（指標の変更）を、contractId `g01-eval-revision` の新しい draftRef として観測前に起案して確認する。K6/2 の `g01-eval-revision` の行は S1 による改訂だけを扱い、指標の変更を含まない。CP-0（#639）が固定した G-02、G-07、G-08（usable の状態）の期待値も Graph-only の Scene の追加を含むので、Option A の改訂は G-01 だけでは済まない（下の Option A）。この改訂はまだ起案されていない。
- X1/1 との関係: X1/1 も `scope-storage-authority` の差分（confirmedRef `nir1-scene-scope-projection-proposal/1#scope-storage-authority`）を持つ。この draft の `scope-storage-authority` の文は X1/1 の差分を確認せず、X1/1 の文もこの draft の差分を確認しない。2つの差分は互いを前提にせず、どちらの順で確認されても合わさる。
  1. この draft の差分が書くのは、binding の行の宣言の2列と、その writer（宣言、取消、restore のクリア）と、宣言の feed の kind だけである。宣言の writer は、v1 の列（version、source token、updated_at）、A1 の意味の列、registry を書かない（C15）。
  2. X1/1 の差分が変えるのは、v1 を進める writer の範囲、本文 Source の token の単調な変化の保証、型付き Revision の Scope の Source（Scene Scope 投影）である。宣言の2列には触れない。投影に入れる情報に宣言はない（X1/1 の「Scene Scope 投影の定義」）ので、宣言の書込みで投影は変わらない。
  3. この draft の失効の規則と試験は、X1-2 の前の挙動でも後の挙動でも成り立つように書いた（「X1 への依存」）。X1/1 が先に確認されても、この draft が先に確認されても、片方だけが確認されても、もう一方の行の文はそのまま読める。
  4. 実装の順（CB-1〜4 と、X1-2、X1-3）によらず、後に merge する側が、先に入った側の試験を通す（X1/1 の受入れの試験 14 の writer の網羅と、この draft の失効の試験。「X1 への依存」の XK-1、XK-5、XK-6 と「確認後の記録」）。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答は、確認として扱わない。2026-09-25 の確認の記録も、この draft の確認にならない（U1）。継続計画 §1 の SB-1〜SB-5（cont:31-35）は、この draft を書き直す指示とユーザーの選択であり、確認文ではない。
- どちらの行も Graph の製品公開を許可しない。公開には Graph の製品公開条件（A3 + B + C + D2a、l6-l9:576）と Session C-1 の承認が要る。
- この2行の確認は、B-ROUTE（B の build を正規の経路に配線する。#643 で merge 済み）と S1 の harness の取り込み（S1 の setup、決定論の provider の G-01 の対応表の置き場所）を確認しない。どちらも各レーンで、確認済みの契約の範囲の中で進める（計画は B-ROUTE を、l6-l9 の proposal/5 の B の build の owner/lifecycle と B-close の数値に従い、C-product の前提として委任で進める作業とする。計画の :251、cont:76）。CP-0 の #639 は G-02〜G-08 の固定と P harness の足場までで、S1 の harness の取り込みは CP-4 へ移された（`evals/nir1-graph/README.md` の「CP-0 で行わなかった作業」。`14fd3cfc` の :216-226）。K6/2 は、取り込む lane を独立 TASK `G01-RM`（推奨）か、DA-1 への前倒しとする（K6/2 の「選択肢と推奨（測り直しの lane）」の案1 と案2）。
- 観測前の commit: この draft は、addendum の file（宣言する Scene と値、診断用の負例）、宣言の場所（「Main の一回限りの確認」の「測定の workspace」の (i) か (ii)）、B の seal の手順と、それらの独立 review の記録を、CP-4 が G-01 と G-02、G-07、G-08 の Graph arm を最初に観測する前に入れる commit（観測前の commit）に置く。宣言の段、receipt の記録、測定の workspace で宣言が current であることの照合を harness に実装し実行するのも CP-4 である。S1 の harness を取り込む lane が `G01-RM`、DA-1、CP-4 のどれであっても、担い手は CP-4 の1つにする。/3 は担い手を「S1 の harness を取り込む lane」としていたので、K6/2 の案2 で取り込みが DA-1 に移ると定義が合わなかった（K6/2 の「/1 からの差分」の #39 の求め）。`G01-RM` と DA-1 は R と R+IR だけを測り、Graph arm を観測しないので、観測前の commit を待たない（addendum は R と R+IR を変えない）。CP-4 より前に、これらの case の Graph arm（R+IR+Graph の membership）を観測する run を置く lane があれば、その run は観測前の commit の後に取る。CB-4 の受入れは、失効した宣言で開示しない試験までを担い、測定の workspace の照合は担わない。G-01 の正例と G-02／G-07／G-08 の追加 Scene の正例は、これらにも依存する（C14）。
- K1 の2行は確認済みである（冒頭の表）。このため、C-body で足す上限の数値は、K1b の規則に従って integrator が実測から選び、PR に記録する（数値ごとの確認は要らない。緩めるには再確認を要する）。この2行の確認は K1 の行を変えない。資源の proposal/7（SB-4、SB-5）は、この draft の確認の前提ではない（「資源」）。
- 確認された行は、この draft の bytes の SHA-256 と確認文を台帳に記録する。本文は編集せず、内容を変えるときは新しい draftRef で起案する。
- 示す場は Session B2 である。X1/1 は Session B1 で示されるので、この draft を示す時点で X1/1 の確認が済んでいることもありうる。どちらでも、この draft の文はそのまま読める（上の X1/1 との関係）。

## 根拠: ユーザー決定（逐語）

継続計画（`14fd3cfc` の `docs/plans/nir1-continuation-2026-10.md`、sha256 `672801fe…`）の §1 の正本から、ユーザー自身の文言を写す（cont:21-35）。ID、時刻、逐語は §1 のとおりで、SB-4 と SB-5 の逐語は §1 の文字（半角の空白と括弧）で書く。「この draft での読み方」は起案者の解釈で、ユーザーの発言ではない。

- ID と時刻の対応: /3 は SB-1 を UB1、SB-2 を UB2 と呼び、UB1 の時刻を 19:41 JST と書いていた（integrator の作業記録の受信の時刻）。この /4 は §1 の ID と時刻（SB-1 は 19:40 JST）に揃えた。K3/2 は同じ決定を UB1・UB2、K5/3 は SB-1 を UB-K5 と呼ぶ（cont:17）。

| ID | 対象と時刻（JST） | 回答（逐語） | この draft での読み方 |
| -- | ----------------- | ------------ | --------------------- |
| U1 | 9/25-26 の承認と WIP（2026-10-12 17:22。cont:21） | 「使わずに計画し直す」 | /1、その確認の記録、WIP の文面を使わず、最新 master を前提に起案し直す。WIP から移すコードは新しい候補として再試験・再レビューする |
| U2 | 2 MiB／8 ms（同日 17:22。cont:22） | 「2MiB/8ms はキツすぎてCodexでは達成できませんでした。何かいい案があれば挑戦してもいいかもしれませんが、現状は達成不可能です。」 | C-body の資源を 2 MiB／8 ms に結び付けない（master にある旧 C-body の draft はこれを前提にしている）。資源は K1 に従う |
| U3 | #610 型の技術委任を NIR-1 の残レーン全体へ広げる（選択肢 1。同日 17:22。cont:23） | 「1でRalphを使ってやるかどうかは任せます。」 | 委任は技術判断に限られる。新しい authority、保存範囲の拡大、新しい信頼境界は委任の外なので、この2行はユーザーの確認を要する |
| U4 | 到達点（同日 17:22。cont:25） | 「merge まで進める」 | C-body を含めて merge まで進める。この2行が確認されなければ、G-01 の正例と G-02／G-07／G-08 の追加 Scene の正例、PUB-G、E が止まる |
| U6 | 資源契約（同日 17:31。cont:27） | 「防御用の上限だけに簡素化（推奨）」 | C-body で足す上限は、`nir1-defensive-resource-limits`（K1b。確認済み）の規則に従う |
| SB-1 | K3 と K5 の書き直しの提案への返答（2026-10-13 19:40。cont:31） | 「それで行きましょう。K5はCで。ローカルLLMを使う人は基本的にリテラシーが高いと思うので釈迦に説法でしょう。」 | K3 は O-2、K5 は C で書き直す。K2 の開示の範囲と宣言の規則は変えない。この draft で SB-1 に依るのは、評価用の CI seam が承認する grant が `BodyDeclaration` だけになること（K5 の C で `LocalSendConsent` の grant がなくなる）、宣言と取消の入口の区分を K3/2 の表で引くこと、renderer が表示した excerpt を利用者の入力として送ることを K5/3 の残余と同じく防がないこと、Option の日数の見直し（SB-1 の影響は日数にしない）である |
| SB-2 | Web Editor の廃止（2026-10-14 04:06。cont:32） | 「web editorは廃止し、再公開の予定もないのでhandoffの考慮は不要です」 | Web Editor の handoff の取込みは、この draft の考慮の対象外とする。それに依る脅威、防御、試験を置かず、失効の表にも行を置かない |
| SB-3 | 本文の保存で型付き Revision が全件失効する件（X1。2026-10-14 10:02。cont:33） | 「依存するものだけ失効」 | X1 は新しい draftRef（X1/1）で起案され、Session B1 で示される。この draft は X1/1 の確認を代行せず、X1/1 もこの draft の確認を代行しない。この draft は、X1/1 の「ほかの draft との関係」の K2 の表に合わせて、宣言の失効の根拠を X1-2 の前と後に書き分けた（「X1 への依存」） |
| SB-4 | 中心人物で records 512 と steps 100,000 に当たる件（同日 10:02。cont:34） | 「実測から決め直す (推奨)」 | 資源の値は proposal/7 で決め直す。この draft の上限は K1b の規則で integrator が選ぶもので、proposal/7 の値に依らない。worker の query の値は、確認済みの `graph-limited-binding` の版に従う（「資源」）。proposal/7 は C の受入れに効き、Option A と B に同じだけ効く |
| SB-5 | 2 hop で Entity が 12 を超える件（同日 10:02。cont:35） | 「上限を上げる (推奨)」 | 値は proposal/7 で実測から決め、それでも超えたら Graph 全体を出さない規則は変わらない。この draft の Graph-only の判定は、worker の列挙が完了した後の段で働くので、この規則に触れない |

これらは確認文ではない。確認は、この /4 に対して、改めて逐語の確認文で行う。

## 前提: 現行のコード（`14fd3cfc`）

C1〜C18 の行番号は `14fd3cfc` のもの。/3 は `a153743b` で書き、`87f0da94` で確かめ直していた。`87f0da94` から `14fd3cfc` までに変わった file のうち、この draft が引くものは、`domain_writes.rs`、`migrate.rs`、`narrative_extraction/scene_scope.rs`、`narrative_extraction/project_scope_authority.rs`、`narrative_extraction/nir1_entity_relation_index.rs`、`narrative_extraction/nir1_graph.rs` と、master の文書の l6-l9 と継続計画である（`git diff --name-only 87f0da94 14fd3cfc`）。ほかに引いた file は、`87f0da94` の版と同じ bytes である。どの事実もコードの読取からの導出で、断りがなければ実行では確かめていない。

| # | 事実 | 根拠 |
| - | ---- | ---- |
| C1 | Graph-only target の本文は開示できない。A1 の binding（`narrative-scene-scope/1`）は timeline、worldline、layer、holder、audience だけを持ち、本文の story、auto、phase、reveal、POV を表す欄がない。parent 側の `validate_scene_scope` は、Entity と Relation の POV と phase、project の authority、reveal、lifecycle を確かめないと明記している。CB-4 が使う前提で CP-1 が用意し、製品の build ではまだ使われていない（`expect(dead_code)`） | `src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs:84-97`、`narrative_extraction/nir1_graph/scenes.rs:776-847`（:780-786）、l6-l9:40 |
| C2 | v1 の token は、registry と、A1 の状態、incarnation、version、updated_at の digest（`source_token` 自身は入らない）。今の master では、次の writer が同じ transaction で v1 の version、token、updated_at を進める（`refresh_scene_scope_source_token_in_tx`）: 本文の保存、Scene の行へのどの patch でも（field を問わない）、AI Apply の apply と undo、Codex の rename の波及、物語時間と Chronicle の日時の操作とその restore、Chronicle の一括操作、本文版の restore。X1-1（#662）で、生きた Scene を含む folder の parentId、sortOrder、archivedAt が実際に変わったときに、配下の Scene（変更の前と後の生きた Scene の和集合）の binding も進むようになった（`tree_node_patch` と AI tree plan の apply、undo、redo）。refresh とは別に、A1 の設定、registry の変更（project のすべての binding）、Codex の人物の restore による A1 の無効化が進める。project snapshot の本文の restore は、v1 を進めるのではなく binding を作り直す（`tree_nodes` の行を消すと binding の行も外部キーの CASCADE で消え、入れ直した Scene ごとに新しい incarnation、既定の A1、世代 1 で作ってから refresh する。X1/1 の F19）。backup の restore は DB を丸ごと置き換えるので、v1 も本文も backup の時点の値に戻る。X1-2 の後は、本文の保存、題名と表示 metadata の patch、Codex の rename の波及、本文版の restore は v1 を進めず、Scope に効く編集だけが進める（X1/1 の「writer の網羅表」） | grimodex-core `narrative_scene_scope.rs:176-199`、`narrative_extraction/scene_scope.rs:568-615`。呼出し元: `scene_body.rs:801-807`、`domain_writes.rs:3852-3863`、:5570、:5955、:1049-1059、`narrative_extraction/temporal_operations.rs:199`、:268、:575、:679、:733、`chronicle_bulk.rs:952`、`revision_restore.rs:270-276`。X1-1: `domain_writes.rs:3934-3955`、:5641、:6005、`narrative_extraction/scene_scope.rs:661-683`。A1: :1187、registry: :1366（:1454-1477）、人物: :1067（呼出し元 `agent_writes.rs:2750-2756`）。project snapshot: `project_snapshots.rs:2791-2797`、:2931-2963、`migrate.rs:4077-4078` |
| C3 | 本文の Source は、key `project:scene:<id>`、revision token `v{version}@{updated_at}`、storage digest、canonical digest、正規化の版、UTF-16 長で表される。上限付きの reader は Electron の Native の build だけにある（feature `native-current-human-capture`） | `narrative_extraction/retrieval_admission/scene_source.rs:14-61`、:63-80 |
| C4 | Graph-only target の excerpt の候補は、canonical な本文の先頭の非空行。G-01 の `g01-mira` の本文は1行なので `[0,78)` になる | `narrative_extraction/nir1_graph/scenes.rs:728-762`、`evals/nir1-g01/fixture.v1.json` |
| C5 | `narrative_scene_scope_bindings` は table 単位で保護され、generic SQL、MCP、renderer からは書けない。A1 の writer は期限なしで DB mutex を待つ（`db.with_conn`） | `policies/narrative/protected-writers.json:469-475`、`narrative_extraction/scene_scope.rs:1217` |
| C6 | LiveBinding の locator は、open の要求の path を Native がそのまま使い、`to_string_lossy` した文字列である。Native は canonicalize しないので、正規の形になるかは呼出し側の path に依存する（struct の comment は canonical と書いている）。workspace ID は `.grimodex/workspace.json` の id で、folder を複写すると同じ値になる。DB file の identity（dev と inode、volume と file index）は process の中の照合だけに使う | `electron/native/grimodex-node/src/workspace_lifecycle_view.rs:1067-1097`（:1075）、`electron/native/grimodex-node/src/lib.rs:9907-9920`、`open.rs:1073-1082`、`workspace_lifecycle.rs:99-113`、`state.rs:86-111`（どれも `87f0da94` から変わっていない） |
| C7 | worker は本文を読まない。frame（現行は NQG3。`14fd3cfc` の時点は NQG2 で、`df40eec8` は NQG3 であり、NQG2 は退役している。Scene association の中身は同じ。DSN の案を CP-1〔#641〕が実装した）は Scene association として scene ID、incarnation、source token、scope token、pin の照合値、path を返す。parent が返却時と click 時に再検証する | DSN §2.1〜§2.3、`narrative_extraction/nir1_graph.rs:250-264`（`Nir1GraphSceneAssociation`）、`narrative_extraction/nir1_graph/worker_frame.rs:194-203` |
| C8 | project の Scope authority の revision は、live な Scene の reading の DFS 順と story の key（base）と、registry（revision と source token）と各 Scene の binding（version、source token、updated_at を含む）の拡張 digest から作られる。tree の各 node の version と updated_at は、X1-1 で入力から外れた。A3 は Revision の Entity の `authorityRevision` がこれと等しいことを要求する。今の master では、本文の保存と Scene のどの patch もその Scene の binding を refresh する（C2）ので、project の token が変わり、承認済みの型付き Revision はすべて A3 で stale になる（X1/1 の F9 は、これを spike の1回の実行で観測した）。X1-2 の後は本文と表示の更新で project の token が変わらず、X1-3 の後は型付き Revision が anchor ごとの投影に束縛される（X1/1）。宣言の writer は v1 の列を書かないので、X1 の前でも後でも、宣言で project の token は変わらない | `narrative_extraction/project_scope_authority.rs:8-15`、:193-238、`narrative_extraction/scene_scope.rs:709-864`、`narrative_extraction/nir1_entity_relation.rs:2353` |
| C9 | secret の判定に使える記録は2種類ある。(1) foreshadow: `foreshadows.secret`（新規の table では既定 1、既存 DB へ足した列では既定 0 なので、legacy の行は secret でない）、旧式の `foreshadows.payoff_scene_id`、`foreshadow_setups.scene_id`、`foreshadow_payoffs.scene_id`。(2) Chronicle event: `events.secret`（既定 0）、`events.reveal_scene_id`（秘密を明かす Scene の作者の指定）、Scene と event を結ぶ `scene_events`。secret な event は、書いている Scene が reveal の Scene より読む順で前の間だけ AI から隠される。reveal の指定がなければ、event を結んだ Scene のうち読む順で最初のものが reveal になる。POV の記録: `tree_nodes.pov_character_id`、保存本文の `sceneBeat` の `pov` 属性と、そこから導いた `scene_beat_pov_cache` | `migrate.rs:546`、:1532-1589（:1538、:1543、:1556）、:1695-1696、:1761-1766、:2444-2511（:2465-2466、:2505-2511）、:2528-2539、:3030-、`src/features/chronicle/chronicleSecrecy.ts:8-89`、`scene_body.rs:742-779`、`src/features/editor/sceneBodySnapshot.ts:148-154` |
| C10 | schema の版は 42 で、CR-1（#636、`75074118`）が `narrative_proposal_decisions` の index 2 本に使った。その後 `14fd3cfc` まで変わっていない。この draft の schema の版の既定は v43 になる。X1/1 の Q1 で設計 A が選ばれると、X1 も binding に列を1つ足して版を上げるので、採番は merge の順で integrator が決める。G-01 の fixture v1 は「実行結果を見た後に query、corpus、seed、Gold、順序、指標を変えない」と定める | `src-tauri/crates/grimodex-core/src/lib.rs:3`、`evals/nir1-g01/fixture.v1.json` の `observationPolicy` |
| C11 | feed の object kind は閉じた集合で、未知の kind の event は、検証、project の照合、canonical snapshot、Source の対応付けで拒否される。Revision の pending 判定は、検証に通らない event と Source の対応付けの失敗を `PendingUnknown` にし、全体の評価を要する event を `PendingGlobalChange` にする。kind が `scene-scope` か `scope-registry` の event は、内容によらず project の Scope authority の変更として扱われ、`scope-dependency:v1:` に依存する Revision を `PendingRelevantChange` にし、Scope authority の identity を freshness で dirty にする。A1 の writer の feed event は、`scene-scope` の kind で `scopeAuthorityChanged: true` を固定で入れる | `narrative_extraction/change_feed.rs:1699-1708`、:1827-1831、:1958、:3234-3259、`canonical_feed_snapshots.rs:427`、:640、`narrative_extraction/incremental_freshness.rs:3576-3578`、:3602-3633、:3701-3707、:3754-3760、`narrative_extraction/revision_eligibility/pending.rs:79-109`（:89-91）、`narrative_extraction/scene_scope.rs:617-642` |
| C12 | Scene の title は作者のデータで、AI Apply（Scene の作成と title の更新）と Codex の rename の波及でも書き換わる。AI Apply の writer は title が空でないことだけを確かめ、改行、制御文字、長さを制限しない | `domain_writes.rs:43-48`、:5302、:5329-5331、:842-862 |
| C13 | 検索の評価の setup と測定は、standard build（`pnpm napi:build` → `pnpm electron:build`）の receipt を必須にし、その build の製品 Main を起動する。評価に要る差し替えは、製品 Main の中の、env で gate された seam で行う。決定論の provider は packaged でない起動と exact な env の値を要し、maintenance の seam はさらに `CI=true`、owner token、起動ごとの nonce を env で要して、使ったことを Main の receipt に残す。owner token は source にある公開の定数（`c2-5b-product-journey-owner-v1`）との一致を見るだけで、nonce は形式が UUIDv4 なら任意の値でよい。どちらも秘密ではない。P の paired harness は、setup の DB だけを別の path に書き出して開く | `scripts/quality/setup-nir1-retrieval.mjs:66-76`、`scripts/quality/run-nir1-retrieval.mjs:150-177`、`docs/plans/nir1-standard-build-producer.md:3`、`electron/main/productJourneyAi.ts:74-84`、`electron/main/narrativeMaintenanceCiSeam.ts:60-61`、:267-275、:282-348、:369、`scripts/quality/nir1-retrieval/paired.mjs:118-140`（どれも `87f0da94` から変わっていない） |
| C14 | SPIKE S1（2026-10-13、`a153743b`）は、standard build と同じ command の build、pin 済みの model、通常の writer、決定論の provider で G-01 を setup し、R＝R+IR＝`[g01-question]`（共通追加枠は未使用）を実 runtime で観測した。(a) IR の Index は fresh だったが、query との cosine 0.61294 が英語の IR floor 0.66 を下回り、IR は空で、結果の基底は `raw` だった（候補 :235 の「IR は control への付加」とは違う）。(b) B の Graph index を publish する呼出しは試験と診断用のコードにしかなく、製品の経路で B の sealed binding を確立できなかった（候補 :217-218 の setup を満たせない。計画は B-ROUTE を追加した）。B-ROUTE は #643（`532fd927`）で merge され、maintenance の cycle の中の gate 付き route（work kind `nir1-graph-index-build`）が publish を呼ぶ。gate は既定で閉じ、検証済みの journey seam でだけ開く。B-GUARD（#660、`85090886`）で、B の whole-project build は、承認されていない Revision を大きさに関わらず除いて続け、承認済みで成分を超える Revision だけを typed に拒否するようになった（setup に残る下書きの Revision が B の seal を止めない）。(c) 決定論の provider の対応表は 24 件の corpus だけを読み、本文が一致する Scene にしか答えないので、G-01 の本文には答えない。S1 は setup 専用の Main で import を1つ差し替え、計測には差し替えのない main を使った。(d) S1 の setup では、全 Scene の story_time_order が NULL、POV は未設定で、A1 は初期値（compatibility marker が unknown、registry が空）から明示に設定した。setup の選択（Scope の ref、query の Scene の title など）は観測の前に固定した（S1 の `SETUP_DECISIONS`、preregistration `c6739191…`） | S1 報告 §1〜§5、§8。`policies/narrative/nir1-related-scenes-ranking.json:4`、`electron/native/grimodex-node/src/related_scenes/scoring.rs:79-84`、`src/features/related-scenes/nir1RelatedScenesFusion.ts:26-27`、`narrative_extraction/nir1_entity_relation_index.rs:2407`、:2421、`narrative_extraction/nir1_capacity.rs:1123-1158`、`narrative_extraction/nir1_graph_index_maintenance.rs:924`、`electron/main/productJourneyNir1Ai.ts:1`、:40-41、`scripts/quality/nir1-retrieval/setup-evidence.mjs:96`。B-GUARD は #660 の commit 本文 |
| C15 | v1 の token は、行の `updated_at` を入力に含む（C2）。v1 の binding を読む経路は、行の列から token を計算し直して保存値と照合する。(1) `read_binding_in_tx` は、違えば `NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID` で失敗する。これを通るのは、A1 の reader と writer、`scene-scope` の kind の feed の snapshot（v1 の DTO で、`updatedAt` を含む）、source token の refresh（C2 の writer が同じ transaction で呼ぶ）、registry の変更（project のすべての binding を読む）、Codex の人物を戻すときの A1 の無効化である。(2) project の Scope authority の拡張 digest（`scope_extension_digest`）は、照合に外れた行を `unavailable` の項目に置き換え、照合に通った行は `updatedAt` を含めて入れる。(3) material の Scope の読取は、照合に外れた Scene を unavailable にする。既存の writer は、行を書き換えるときにどれも `updated_at` も書き換える。このため、token を計算し直さずに `updated_at` だけを書き換えると、その Scene の本文の保存、A1 の読み書き、project の registry の変更が失敗し、project の Scope authority の revision が変わる（今の master では、C8 により承認済みの Revision は A3 で stale になる）。token も計算し直せば、v1 の token を進めたことになる。X1 はこの照合を変えない（X1/1 の「変えないもの」の v1 の token の式） | grimodex-core `narrative_scene_scope.rs:84-97`、:176-199（:196）、`narrative_extraction/scene_scope.rs:254-334`（:321-325）、:344-389、:391-398、:568-615（:581、:586-599）、:716-864（:827-831、:834-842）、:1067-1169（:1110、:1116-1141）、:1187-（:1222、:1258-1263）、:1366-（:1424、:1454-1477）、:1615-（:1793-1797）、`scene_body.rs:802`、`agent_writes.rs:2750-2756` |
| C16 | CP-0（#639、`6bdf61e9`）が freeze した G-02、G-07、G-08 は、Graph-only の追加 Scene を期待値に持つ。variant ごとの `appendedSceneId` は、G-02 base が `g02-tamsin-first`、G-07 base が `g07-pell-dock`、G-08 の base-usable と graph-recovered が `g08-cass-attic`（excerpt の範囲は `[0,78)`、`[0,70)`、`[0,64)`）。G-08 の3つの unusable variant と G-03〜G-06 は追加 Scene を期待しない。3件の fixture の `measurementBoundary.setupOrder` に宣言の段はない（宣言の段は addendum が `setupOrder` の外に挟む。「setup の addendum」の「freeze 済みの `setupOrder` との関係」）。fixture は POV、story time、Chronicle event を設定しない。foreshadow は G-07 の3件（すべて secret）だけで、その payoff の Scene は `g07-rhea-reveal`、`g07-late`、なしであり、`g07-pell-dock` を参照しない。追加 Scene の A1 は explicit で、reading は query（100）より前（20〜40）。G-02 の mutation は Codex の Relation の型の編集、G-08 の mutation は Codex の entry の summary の編集と IR の承認撤回で、G-07 に mutation はない。どれも追加 Scene の本文、title、A1 に触れない。前提条件 `cb4-inputs` が追加 Scene の部分期待値を `blocked:cb4-inputs` にするのは、CB-4 が POV か story position を要求した場合だけである。宣言がなく追加 Scene が返らないことはこれに当たらず、Hold になる。manifest の isolation は、case と variant ごとに新しい workspace を使う。S1 の harness の取り込みは CP-4 へ移された | `evals/nir1-graph/g02-directed-relation.v1.json`（sha256 `c9e9ea0c…`）、`g07-reading-before-reveal.v1.json`（`385eaa73…`）、`g08-graph-index-fallback.v1.json`（`0415561e…`）の `variants[].expectations`、`scenes`、`foreshadows`、`mutations`、`measurementBoundary.setupOrder`。`freeze.v1.json`（`45d8a055…`）。`manifest.v1.json`（`76ca8040…`）の `preconditions.definitions[cb4-inputs]` と `isolation`。`evals/nir1-graph/README.md`（`14fd3cfc`）の :92、:205-214、:216-226 |
| C17 | feed の transaction を書く `append_narrative_change_transaction_in_tx` は、最後に、event の kind を問わず `suspend_project_in_tx` を呼び、その project の Chronicle の IR の Index と B の Graph index の metadata に dirty を立てる。Graph の登録は dirty の間は完全とみなされず（`is_complete_registered` は `!binding.dirty` を返す）、dirty は B の publish でだけ消える。このため、今のコードのまま宣言の writer が feed の transaction を書くと、宣言、取消、クリアのたびに Graph と IR が次の publish まで unavailable になる。/3 の「この kind の event だけで…Index の Freshness も dirty にならず、B の sealed binding は current のままであること」は、この呼出しを宣言の kind について外す変更を要する（この draft の `scope-storage-authority` の差分。CB-1）。X1/1 の F8 も同じ事実を書く | `narrative_extraction/change_feed.rs:2457`、:2841、`narrative_extraction/nir1_chronicle_index/invalidate.rs:12-34`、`narrative_extraction/nir1_entity_relation_index.rs:2152`、:2585-2590 |
| C18 | renderer は grant なしに、宣言を失効させるか veto に当てる既存の入口を呼べる。本文の保存（`save_scene_body_bundle`）、Scene の patch（`tree_node_patch`）、A1 の保存（`narrative_scene_scope_update`）、registry の変更（`narrative_scene_scope_registry_update`）、伏線の作成と更新（`foreshadow_create`、`foreshadow_update`）、Chronicle の一括操作（`chronicle_bulk_mutate`）は、Main の route の台帳で `internal` に分類され、restricted でも通る（restricted で拒否されるのは、旧 AI の経路、`plaintext-publication`、`external-url`、未分類だけ）。K3/2 も、宣言 UI（Scope）の行を restricted で `internal` のまま通し、Native の入口で登録済み caller と workspace を確かめるとする。本文と title の変更は束縛の不一致で、A1 と registry の変更は v1 の token で宣言を失効させ、secret の伏線と POV は veto に当たる | `electron/main/profileEgress.ts:155-385`（:192、:230、:242、:295-296、:338、:370）、:496-526、:675-712。伏線の作成の payload は `payoff_scene_id` と `secret` を持つ（`foreshadow.rs:511-537`）。K3/2 の「restricted 下の route 区分」の「区分の構成」の「宣言 UI（Scope）」の行 |

### X1 への依存

X1-1 は #662 で merge 済みで、今の master（`14fd3cfc`）の挙動に入っている。X1-2 と X1-3 は、X1/1 が確認された後に実装される。この draft の規則は、次の表の「X1-2 の前」の列でも「X1-2、X1-3 の後」の列でも成り立つように書いた。X1/1 の Q1〜Q3、Q6 の名前は X1/1 の「選択肢と推奨」のもの。

| ID | この draft が依ること | X1-2 の前（今の master。X1/1 が確認されない場合もこのまま） | X1-2、X1-3 の後（X1/1 を推奨のまま確認） | X1/1 で別の案が選ばれた場合 |
| -- | --------------------- | ------------------------------------------------------------ | ---------------------------------------- | --------------------------- |
| XK-1 | 本文と title の変更で宣言が失効し、元に戻しても再び一致しないこと | Scene の行を書くどの writer も v1 の version を進める（C2）。宣言は v1 の token と本文 Source の token の不一致で失効し、v1 の version は同じ incarnation の中で減らないので戻らない | 本文と title の更新は v1 を進めない。宣言は本文 Source の token（本文と題名のどちらでも）と title の digest で失効する。本文 Source の token は、同じ restore epoch の中では、`version` を進める writer では `version` で、進めない writer（`tree_node_patch` の `bumpVersion=false` の patch と、Chronicle の一括操作の forward と undo）では `updated_at` の時刻としての厳密な前進で、以前の値に戻らない（X1/1 の Delta の 1）。title を A→B→A に戻し `updatedAt` も前の値に戻しても、割り込み（`tree_node_patch`〔未来の `updatedAt`〕→ Chronicle の一括操作 → `tree_node_patch`〔同じ `updatedAt`〕）を挟んでも、宣言は再び一致しない。保証は restore epoch を跨がないが、restore は宣言を消す（明示的なクリア）ので響かない | X1/1 が保証を外した版（/2）で確認された場合、または X1-2 が保証を `tree_node_patch` だけに課して merge された場合（X1/1 は「ほかに検討して採らない案」でこの方式を退けている）は、題名の A→B→A や割り込みで宣言が再び一致しうる。この draft は再び一致することを許容しない（l6-l9:146 の「clear／undoは旧資格へ戻さず」と、`graph-target-scene-body-disclosure` の Mandatory defense 5）。そうなる変更は、この draft の失効の試験（「失効」）で落ちるので、その PR を `[precheck]` で止め、宣言に別の単調な目印を足す新しい draftRef（K2/5）を起案する |
| XK-2 | Scope に効く編集で宣言が失効し、戻らないこと | A1 の設定、registry、人物の restore による A1 の無効化、Scene の patch（field を問わない）、生きた Scene を含む folder の構造の変更（X1-1）で v1 が進む | A1 の設定、registry、人物の restore による A1 の無効化、Scene の parentId、sortOrder、storyTimeOrder、archivedAt、POV（Codex の人物の削除による NULL 化を含む）、生きた Scene を含む祖先 folder の構造の変更で v1 が進む（X1/1 の Delta の 1 の (a)〜(e)）。undo journal の経路での人物の参照は X1-2 が J1 か J2 で扱う（同じ (c)）。project snapshot の本文の restore は binding を作り直す（同じ (f)） | Q1 の設計 A: binding の version は移動でも進める（X1/1 の Q1 の「選んだときに変わる箇所」の (1)）ので、宣言の失効は変わらない。X1 が binding に列を1つ足すので、schema の版の採番が merge の順で決まり（C10）、宣言の writer はその列も書かない（宣言の2列のほかの列は byte 同一。`scope-storage-authority` の Mandatory defenses）。この draft の文は変わらない |
| XK-3 | registry の変更で project のすべての宣言が失効し、往復で戻らないこと | registry の writer が project のすべての binding の version と token を進める（`narrative_extraction/scene_scope.rs:1454-1477`） | 同じ（Q2 を推奨のまま） | Q2 の対案（参照しない binding の版を進めず、`source_token` だけを計算し直す）では、registry を A→B→A と戻すと、参照しない Scene の v1 の token が A の時点の値に戻り、宣言が再び一致しうる。X1/1 の Q2 の表は、X1/2 が (i) 参照しない binding の版も進めるか、(ii) v1 の token の式に registry の単調な版を入れるかを本文にするとする。(i) ならこの draft は変わらない。(ii) なら、registry の変更で全 Scene の v1 の token が変わり、版は戻らないので、この draft の「project のすべての宣言が失効し、戻らない」はそのまま成り立つ（失効の表の registry の行の「version と token を進める」を「token が変わる」と読む）。どちらでもない形なら、この draft の失効の試験で落ちるので `[precheck]` で止め、K2/5 を起案する。registry の変更での宣言の失効を、変わった ref を参照する Scene に絞ることは、失効を減らす変更なので、この draft では行わず、行うなら K2/5 が要る |
| XK-4 | 宣言の書込みが project の token と型付き Revision を巻き込まないこと | 宣言の writer は v1 の列を書かないので、`scope_extension_digest` の入力は変わらない（C8、C15） | 同じ。加えて、投影は宣言の2列を入れない（X1/1 の「Scene Scope 投影の定義」）ので、宣言で投影は変わらない | Q3 の対案（版 1 の型付き Revision を project の token で照合する経路を残す）でも、宣言は project の token を変えないので同じ。Q1 の設計 A の投影の新しい列も、宣言の writer は書かない。この draft の文は変わらない |
| XK-5 | 宣言の feed の kind が、pending、Freshness、Index を巻き込まないこと | 新しい kind は Source を持たず、Scope authority の変更に数えず（C11）、その kind の event だけの transaction は Index を dirty にしない（C17。CB-1 で外す） | X1-3 は feed の routing を identity で絞り、分類できない event を pending にする（X1/1 の Delta の 4）。宣言の kind は、閉じた集合に登録した、Source を持たない kind として扱い、投影の identity に写さない（宣言は投影に入らない）。CB-1 と X1-3 の後に merge する側が、この分類を試験で固定する | Q6 で X1-5 を含めると、Graph の Index の dirty が B の入力の event に絞られる。宣言の kind は B の入力ではないので、X1-5 の下でも dirty にならず、この draft の除外と食い違わない。Chronicle の Index は X1-5 では絞られないので、この draft の除外（宣言の kind の event だけの transaction）は X1-5 の有無によらず要る。2つは互いを前提にしない |
| XK-6 | X1-2 の writer の網羅の試験と、この draft の writer が両立すること | 該当なし（X1-2 の前） | X1-2 は、binding を書く production の writer を網羅し、表にない writer が binding を書けば落ちる試験を置く（X1/1 の受入れの試験 14）。この draft の宣言、取消、restore のクリアの writer は、binding の行の宣言の2列だけを書き、Scope 世代を進めない。X1-2 の表には「Scope 世代を進めない writer」としてこれらを載せるか、試験が数える対象を Scope の列（version、source_token、updated_at と A1 の意味の列）を書く writer に限る。CB-1／CB-2 と X1-2 のどちらが先に merge されても、後に入る側の PR で合わせる | 同じ |
| XK-7 | CP-4（G-01 と追加 Scene の正例の測定）の開始条件 | X1/1 が確認され、X1-2 と X1-3 が merge されるまでは、K6/2 の `graph-eval-procedure` の条件の判定に使う診断は `[precheck]` に回り、その条件の CP-4 は HOLD になる（K6/2 の「確認の扱い」の「承認の失効への対応」）。X1/1 が確認されない場合の CP-4 の扱いは K6/2 とユーザーの判断に従い、この draft は決めない | X1/1 が確認されれば、CP-4 は X1-2 と X1-3 の merge を待ち、X1 を含む候補で取る（K6/2 と X1/1 の「確認後の記録」）。日数は「critical path への影響」 | Q1 の設計 A は X1-3 を 1〜1.5 日延ばす（X1/1 の見積り）。Q6 で X1-5 を含めると X1-5 の 1 日が加わる |
| XK-8 | 宣言とは別の理由での Graph の可用性 | どの Scene の本文の保存でも承認済みの型付き Revision がすべて stale になり（C8）、B の再 build と再承認まで Graph の寄与がなくなるので、宣言が current でも Graph-only の追加は出ない | X1-3 の後は、anchor の Scope に効く変更でだけ型付き Revision が失効する。宣言した Scene の本文を変えると宣言は失効するが、ほかの Scene の本文の保存では、宣言も Revision も失効しない。Index の dirty による一時的な停止は残る（X1/1 の「X1 の外に残る問題」の 1） | Q1 の設計 A では、章の組み替えで型付き Revision が失効しない（宣言は XK-2 のとおり失効する） |

X1/1 が確認されない場合に変わる箇所: この draft の規則と試験は変えない。「X1-2 の後」と書いた文は適用されないだけで、宣言は本文、title、表示 metadata、Scene のどの patch でも v1 の token で失効し続ける。Graph は、どの本文の保存でも型付き Revision が stale になるので、執筆中はほとんど使えない（XK-8）。CP-4 の扱いは K6/2 とユーザーの判断に従う（XK-7）。

X1/1 の Q1〜Q3、Q6 で別の案が選ばれた場合に変わる箇所: X1/1 は /2 になる（X1/1 の「確認の扱い」）。この draft の文を変える必要があるのは、Q2 の対案で、registry の往復で v1 の token が戻る形が選ばれた場合だけで、そのときは K2/5 を起案する（XK-3）。Q1 の設計 A は schema の採番だけ（XK-2）、Q3 の対案は影響しない（XK-4）、Q6 は除外の範囲を変えない（XK-5）。

## graph-target-scene-body-disclosure（新規）

- Baseline (approved; limited): この contractId に確認済みの行はない。Graph-only target の本文は fail-closed で、l6-l9:40 の HOLD（「作者宣言などの未確定契約は明示確認後」）にある。確認済みで関連する行は、どれも Graph-only target の本文を開示する根拠にならない。/4 `typed-revision-material` が扱うのは path の Entity／Relation と、Codex の名前・要約の Evidence だけである（l6-l9:169）。/3 `scope-storage-authority` は A1 の保存（l6-l9:143-152）、`graph-limited-binding`（/5。資源の値は K1 の /6 で改訂済み）は Graph の binding と資源を扱う。Graph の製品入口は閉じている（A-1）。master にある旧 draft 2 本（`nir1-c-scene-body-disclosure-delta-draft.md`、`nir1-c-target-scene-body-authority-proposal-draft.md`）は確認の対象になったことがなく、論点の参照にとどめる。
- Delta (C-body authority / disclosure / lifecycle; proposal/4 draft): 作者による本文全体の宣言を、Graph-only target の本文を開示する唯一の authority として新しく置く。宣言は、Main の一回限りの確認を経て Native writer だけが保存する（保存は `scope-storage-authority` の行）。取消は確認を要さない（開示を止める向き）。利用時は parent の reader が判定する。開示するのは、Related Scenes の共通追加1枠に出す title、本文の先頭の非空行の excerpt、その anchor への遷移だけで、AI 送信、Packing、履歴、export には使わない。v1 で宣言できる値は G-01 subset に限る。評価の setup の addendum は、G-01 と、CP-0 が固定した G-02、G-07、G-08 の追加 Scene（4つ）を宣言し、観測前の commit（CP-4）で固定する。返却時と click 時に再検証し、Graph-only の候補の失敗は追加1枠を出さないことだけにとどめる（R+IR とその path の付加は変えない）。PUB-G までは、宣言と取消の入口を Native の gate で閉じる。COMMIT の結果が分からなければ読み直し、決まらなければ再起動まで quarantine する。pending marker は作らない。資源は K1 に従う。詳細は下の節。
- Trusted actors:
  - Native の reader と writer（grimodex-db の Scene Scope の writer と parent の target 本文 reader、grimodex-node の Related Scenes と C-query の製品 owner）。
  - Main（確認ダイアログ、sender と window の束縛、grant の発行）。
  - Main のダイアログを確定した操作者。これを作者とみなし、その宣言を本文全体の分類として信じる。これは新しい信頼仮定で、宣言の内容が真であることは検証しない。
  - 評価用の CI seam が有効な起動では、その起動の env を設定した runner（評価の harness）を、ダイアログを確定する操作者の代わりとみなす。seam が有効になるのは、packaged でない起動で、`CI=true`、owner token、起動ごとの nonce が env にそろったときだけである。ただし owner token は source にある公開の定数で、nonce は形式が UUIDv4 なら任意の値でよいので、どちらも秘密ではない（C13）。これらは誤った起動で偶然に有効になることを防ぐ印にとどまり、認証にはならない。実効的な境界は、packaged でないことと、その起動の env（`CI=true` を含む）を設定できることである。したがって、ここで信じているのは「packaged でない起動の env を設定できる者」で、その残余は下の Out-of-scope の最初の項目に書く。評価では standard build の receipt と組にする（下の「Main の一回限りの確認」）。
  - 既存の authority（live な project Scope authority、A1 の binding、A2／A3、B の seal、workspace の lifecycle Core）と、SQLite の transaction の原子性。
- Untrusted actors:
  - renderer が渡す値のすべて（宣言の値、Scene ID、token、digest、excerpt、eligible の申告、navigation handle の再送、宣言の ID や時刻）。
  - model の出力と、AI Apply が書いた本文。MCP、generic SQL、A1 の保存の経路。
  - worker の frame。NQG3 の association（NQG2 から中身は変わらない）は候補で、parent が確かめるまで信用しない。
  - 次 query 用の cache と、表示中の結果。
  - restore、backup で戻ってくる DB の中身（過去の宣言を含む）。workspace の複写や移動、symlink、path の綴りの違い。
  - 派生した記録（`scene_codex_mentions`、`scene_beat_pov_cache`）を、本文の分類を認める根拠に使うこと。
  - lifecycle の edge と COMMIT の時間的な重なり。
- In-scope attacks:
  - renderer、MCP、model、A1 の保存の経路による宣言の偽造。eligible や excerpt の申告。
  - 確認の偽造、再送、別の窓での流用。期限切れ、OCC の変化、digest の不一致のある古い確認の利用。同時に開いた確認の取り違え。
  - title や本文に由来する文字列による、確認のダイアログの文面の偽装（改行、制御文字、双方向の制御、長い title、固定の文言をまねた title）。
  - 評価用の承認の seam を、通常の起動、packaged の起動、renderer から使うこと。PUB-G の前に、通常の起動で宣言の入口（preview、宣言、取消）を使うこと。
  - 宣言の後の変更（本文の編集、AI Apply、bulk、rename、A1 の変更、POV の設定）の後に、古い宣言で開示すること。
  - restore、複製、ID の再利用、workspace の複写や移動による宣言の持ち越し。同じ bytes や同じ token（`v{version}@{updated_at}` の ABA）による救済。
  - 片方の列だけの宣言、未知の版、未知の欄、token の不一致など、壊れた宣言の利用。
  - 宣言で A1 を緩めること。unknown、legacy、unresolved を any として扱うこと。reading の順が query と同じか後の Scene の開示。
  - secret の foreshadow、secret な Chronicle event、POV の記録と矛盾する宣言による開示。
  - worker の snapshot と parent の読取の混用（frame の token が古い、pin の移動・削除・再挿入）。path の A3 を target 本文の根拠に流用すること。pin を本文の Evidence として扱うこと。
  - 返却の後、click の前の変更（TOCTOU）。
  - unavailable の理由、event、診断、cache を通じた、target の識別子、本文、候補の有無、veto の種別の漏れ。Graph-only の候補の失敗で Graph の寄与の全体や R+IR の path の付加を変え、それを通じて候補の有無を漏らすこと。excerpt が、Native が組む AI の request、Packing、履歴、export、audit に入ること。
  - COMMIT の結果が不明なときの誤った成功・失敗の判定。COMMIT と lifecycle の edge（restore、切替、shutdown）の競合。
  - 取消の入口の悪用: PUB-G の前に gate を迂回して書くこと。取消の応答や event で、Graph の到達、候補の有無、veto の種別を漏らすこと。取消の undo や再送で宣言を戻すこと。宣言がない Scene の取消で feed や idempotency の記録を積むこと。
  - 巨大な本文、多数の veto 行、巨大な宣言による OOM やフリーズ。取消の無視。
- Out-of-scope attacks:
  - OS、Main、Native、backend の侵害。同じ OS ユーザー権限で動く悪意ある process による DB の直接編集や、app を起動する env の設定（評価用の seam の有効化を含む）。seam の owner token と nonce は秘密ではないので、packaged でない起動（開発の起動と、評価で standard build を起動する場合）では、env を設定できる者が、PUB-G の前でも宣言の入口の gate を開き（Mandatory defense 10）、ダイアログなしで `BodyDeclaration` を承認できる。これを残余として受け入れる。その者は同じ権限で DB を直接書けるので、seam は新しい能力を与えない。packaged の起動では seam は働かない。
  - app の外での workspace の file の差し替え（同じ path への外部の restore、sync tool による置換）。この場合も宣言は束縛した本文の bytes にだけ当たるので、その範囲で作者の宣言として扱う。
  - 作者の宣言の誤り（本文に実は秘密がある、など）。veto は既知の記録との矛盾だけを拒否する。
  - 宣言した操作者の本人確認。解錠済みの端末で app を操作する人を作者とみなす。
  - 作者がエディタで Scene を開くことや、tree で title を見ること。通常の閲覧は変えない。renderer は project の tree（Scene の ID と title）をすでに持っている。
  - renderer が、表示中の excerpt や title を、利用者の入力として chat や local 送信に写して送ること。renderer は Scene の本文をもともと読める（renderer の Drizzle が `tree_nodes.content` を読む。`src/features/tree/api.ts:1000-1009`。K3/2 も、restricted で renderer が読む現在の原稿を `tree_nodes`〔protected 表ではない〕と書く。K3/2 の「restricted で閉じる既存機能への対処」の 3）ので、この開示は renderer が読める範囲を広げない。K5/3 は、利用者の入力が renderer の渡す任意の文字列で、画面が読める平文を含みうることを残余として受け入れている（K5/3 の「B-1」の残余の (3)）。この契約が守るのは、Native が組む AI の request と記録に excerpt を載せないことまでである（Mandatory defense 2）。
  - 意味の品質（excerpt が役に立つか）。
  - 処理時間の差（Graph の結果が D の窓に間に合うかどうか）から、Graph-only の候補の有無を推測すること。parent の判定は K1b の上限で有限にするが、時間を一定にはしない。
  - AI 送信、Packing、履歴、export の可否。それぞれの契約で扱い、この行はどれも開かない。
  - v1 で受け付けない値（条件付きの story、auto、phase、reveal の条件、特定の人物の POV）の意味の設計。
  - 乗っ取られた renderer による Graph-only の開示の妨害（可用性）。宣言の取消（grant を要さない）、本文の再保存、title の変更、A1 や registry の変更、veto の記録（secret の伏線や Chronicle event、POV）の追加で、宣言を失効させるか veto に当て、追加1枠を出なくすること。どれも開示を止める向きで、平文の出口も宣言も増やさない。同じことは、grant のない既存の入口で restricted でもできる（C18）。作者は CB-3 の UI で宣言の状態を見て、改めて宣言できる。害は宣言のやり直しの手間である（`scope-storage-authority` の「writer」の「取消の入口と grant」）。
- Mandatory defenses:
  1. 開示の根拠は、`scope-storage-authority` の writer が Main の確認を消費して保存した宣言だけにする。renderer の申告、pin、path の A3、Relation の Evidence、本文の一致、派生した記録を根拠にしない。
  2. 開示は下の「開示の範囲」に限る。Native が組む AI の request と、Packing、chat の履歴、export、audit、event、診断、log、次 query 用の cache、永続の記録に、excerpt と判定の結果を載せない。renderer が表示した excerpt を利用者の入力として渡すことは、この防御の対象外である（Out-of-scope attacks）。診断に載せてよいのは、target を識別しない Native の allowlist の counter（件数だけ）に限る。excerpt や本文の digest、range、長さ、Scene ID は、Eligible の結果のものも診断に載せない。Eligible の結果の excerpt の digest は request-local な binding にだけ置き、renderer へは「開示の範囲」の値と opaque な handle だけを返す。不適格になった候補（下の「利用時の判定」の手順 4 で本文を読んだ後に外れた場合を含む）については、本文、title、それらの digest、range、長さ、Scene ID を、判定の外へ出さない（Mandatory defense 9 の counter だけを残す）。
  3. 判定は parent が、Related Scenes の participant の新しい read transaction の中で行い、下の「利用時の判定」をすべて満たしたときだけ Eligible にする。R+IR の Scene に付ける path の association で frame の値と parent の読取が食い違えば、DSN §2.3 の all-or-nothing のとおり、その query の Graph の寄与を全体で 0 にする。Graph-only の候補で食い違えば、その候補を採らない。Graph-only の候補についての失敗は、追加1枠を出さないことだけにとどめ、R+IR とその path の付加を変えない。本文の読取は query ごとに最大1件。
  4. v1 で受け付ける値は G-01 subset だけ。ほかの値は writer が拒否し、reader は unavailable にする。reading-before と A1 は宣言で外さない。secret の foreshadow、secret な Chronicle event、POV の記録は veto にする（下の「宣言の値」）。
  5. 返却時と click 時に、新しい read identity で再検証する。古い proof、同じ ID、同じ bytes、cache した digest、似た文字列で救済しない。
  6. 宣言は workspace ID と canonical locator の digest に束縛する（下の「canonical locator」）。どちらかを求められなければ unavailable にする。
  7. 宣言の書込みは、Main の一回限りの確認を writer の前に消費し、有限の待機の中で、宣言、OCC、feed を一つの transaction で書く（`scope-storage-authority` の「writer」）。COMMIT の結果が分からなければ下の「COMMIT の結果が分からないとき」のとおり読み直し、決まらなければ再起動まで quarantine する。暗黙の再試行と pending marker は作らない。COMMIT と lifecycle の edge の順序を固定する方法と、終端の証拠の型は、mutation の前に CB-2 の有限の owner/lifecycle matrix に書く（GDX-PRECHECK-001）。
  8. 上限は K1b（K1 の `nir1-defensive-resource-limits`。確認済み）の規則に従い、allocation の前に検査する。Graph-only の判定の中で超えたら、その query の Graph-only の追加を出さず、R+IR とその path の付加は変えない（K1 の表の C-body の行「その Graph 追加候補を出さない。R+IR の結果はそのまま残る」）。取消を処理の境界で観測し、部分的な結果を出さない。
  9. Related Scenes が renderer へ返す応答と event に出す unavailable の理由は、閉じた集合の code だけにする。Graph-only の追加については、候補がない場合と、候補があっても不適格な場合を区別しない1つの code にまとめる。不適格には、下の「利用時の判定」の手順 3 と 4 のどれに外れた場合も含める（宣言がない、veto、reading、A1、束縛の不一致、quarantine、frame と parent の読取の不一致、pin と path の再検証の失敗、本文の照合の失敗、K1b の上限の超過）。Graph-only の候補についての失敗では、Graph の寄与の全体を 0 にせず、R+IR の path の付加も変えず、Graph 全体の理由 code（DSN §1.5 の案の `invalidated`、`limit` など）も使わない。Graph 全体の理由 code を使うのは、B の seal、R+IR の Scene の path の再検証、worker の状態など、Graph-only の候補に依存しない原因のときだけにする。どの code にも、target の ID、title、件数、本文、veto の種別、宣言の有無を含めない。この区別は Native の診断 counter（allowlist。理由の種別ごとの件数だけを持ち、target の ID、title、digest、range、長さを持たない。renderer への応答と event には載せない）にだけ残す。次の4つは、この集約の対象外で、それぞれ閉じた集合の code にする。宣言の入口が、作者が選んだ Scene について返す拒否の理由（preview と writer）。取消の入口が、作者が選んだ Scene について返す結果（取り消した、宣言がない、拒否の理由）。作者が開いた Scene の宣言の状態を CB-3 の UI に出す読取。click 時に、表示中の Graph-only の行の再検証に失敗して遷移しないときの応答。前の3つは Scene を指定した別の typed な経路で、Graph の到達と宣言の状態を結び付けない（取消の結果が示す宣言の有無は、CB-3 の読取が示す範囲と同じである）。4つ目は、すでに表示した行についての応答なので、候補の有無を新たに漏らさない。
  10. PUB-G までは、宣言の入口と Graph-only の表示を製品で閉じる（A-1）。宣言の入口の gate は Native の中に置き、既定で閉じる。Native の preview（`BodyDeclaration` の grant の preview）、宣言の writer（grant の consume）、取消の writer は、gate が閉じていれば DB を読む前に typed に拒否する。PUB-G より前に gate を開けるのは Main だけで、起動時に評価用の CI seam が有効であることを確かめた場合に限る（下の「Main の一回限りの確認」の gate の条件）。Main は Main 専用の N-API（`NAPI_COMMANDS` に載せない。DSN §7.2）で、その process の間だけ gate を開く。renderer、preload、IPC からは開けない。Main も、gate が閉じていればダイアログを出さずに typed に拒否する。restore と Safe Mode からの restore のクリアは入口ではないので、gate によらず働く。PUB-G で開く製品の gate は、PUB-G の承認の範囲で作り、この行は開かない。単体試験は試験 build の入口を使ってよい。standard build で行う評価（G-01 と、G-02／G-07／G-08 の追加 Scene の setup と測定）は、CI seam で gate を開いた起動に限って入口を使い、確認を通す。どちらも renderer と通常の起動からは選べない（post-B §4.4）。
- Acceptance implications:
  - Positive: 下の「setup の addendum」のとおりに `g01-mira` を宣言し、B の sealed binding を正規の経路（B-ROUTE）で確立すると、R+IR+Graph が `[g01-question, g01-mira]` になり、`g01-mira` の excerpt が exact な範囲 `[0,78)` で出る。G-02 base、G-07 base、G-08 の base-usable と graph-recovered も、それぞれの追加 Scene（`g02-tamsin-first`、`g07-pell-dock`、`g08-cass-attic`）を宣言すると、CP-0 が固定した期待値のとおり、観測した R+IR の末尾に1件が加わり、excerpt が exact な範囲 `[0,78)`、`[0,70)`、`[0,64)` で出る。宣言の段は standard build の製品 Main で行い、確認は下の「Main の一回限りの確認」の CI seam で通す。測定に使う workspace で宣言が current であること（workspace ID と canonical locator の digest が宣言の束縛と一致すること）を、Graph arm の最初の query の前に receipt で確かめる（測定する lane で、観測前の commit も作る CP-4 の TASK。CB-4 の受入れではない。「Main の一回限りの確認」の測定の workspace）。path の Evidence（Relation と Entity）と本文の anchor は、別の Evidence として出る。返却時と click 時の再検証を通る。同じ workspace を閉じて開き直しても（新しい authority instance）、app を再起動しても、宣言は有効なまま。Windows、macOS、Linux のそれぞれで「宣言 → 閉じて開き直す → 有効」が成り立つ（Windows の `\\?\` の形、macOS の `/private` 配下の temp、Linux の symlink 経由の open を含める）。R+IR の membership、順位、excerpt は変わらない（Raw が満杯の場合も、IR が補完済みの場合も、IR が空で結果の基底が Raw だけの場合も。C14）。X1/1 が確認されれば、この測定は X1-2 と X1-3 を含む候補で行う（「X1 への依存」の XK-7）。
  - Negative: 次の場合は、どれも Graph-only の行を出さず、R+IR は変わらない。
    - 宣言がない。片方の列だけがある。未知の版、未知の欄、token の不一致がある。v1 で受け付けない値がある（writer は拒否し、DB に直接入れた場合も reader が拒否する）。
    - A1 が explicit でない、unresolved がある、query と一致しない。reading の順が query と同じか後。
    - secret の foreshadow の setup、payoff、旧式の payoff が target にある。secret な Chronicle event の `reveal_scene_id` が target である。`scene_events` が secret な Chronicle event を target に結んでいる。Scene の POV か beat の POV がある。宣言の後にこれらの記録を target に掛けた場合（既存の foreshadow や event を secret にした場合を含む）も、reader が拒否する。
    - 宣言の後の本文の保存（同じ文字列での再保存を含む）、AI Apply、bulk、順序と story time の操作、rename、Codex の rename の波及、A1 の変更、表示 metadata の変更。宣言した Scene を含む生きた章（folder）の移動、並べ替え、archive とその戻し（X1-1）。
    - 宣言の後に title を A→B→A と戻し、`updatedAt` も前の値に戻した `tree_node_patch`（`bumpVersion=false`）の後。`tree_node_patch`（未来の `updatedAt`）→ Chronicle の一括操作 → `tree_node_patch`（同じ `updatedAt`）の割り込みの後。どれも宣言は再び一致しない（X1-2 の前は v1 の token で、後は本文 Source の token で。「X1 への依存」の XK-1）。
    - 本文版、project snapshot、backup の restore、Safe Mode からの restore（宣言は Ready の前に消える）。複製、削除と同じ ID での再作成、ごみ箱からの復元。
    - workspace の複写と移動、workspace ID の変更、canonical locator を求められない path。移動した folder を元の path へ戻し、workspace ID も元のままなら、同じ bytes の宣言が再び有効になることを同じ試験で確かめる（下の「失効」）。
    - pin の移動、削除、再挿入。Scene の archive と削除。frame の token と parent の読取の不一致。どれも、Graph-only の候補ならその候補を採らず、R+IR とその path の付加は変わらない（R+IR の Scene の path の association の不一致では、Graph の寄与が全体で 0 になる）。返却の後、click の前の変更（click で遷移しない）。
    - renderer、MCP、model、A1 の保存による偽装。確認の期限切れ（60 秒）、再利用、別の sender か window、OCC の変化、digest の不一致、2件目の同時の確認、lifecycle の edge による取消。
    - 評価用の CI seam を、packaged の起動、`CI` のない起動、owner token の env がないか定数と違う起動、renderer の IPC から使うこと（どれでもダイアログなしの承認ができない）。owner token の照合は誤った起動を防ぐ印で、秘密による認証ではない。packaged でない起動で env をそろえた場合に承認できることは、この負例に含めない（Out-of-scope の残余）。
    - PUB-G の前の通常の起動（CI seam が無効）と packaged の起動で、宣言の入口（preview、宣言の writer、取消）を使うこと。どれも DB を読む前に typed に拒否され、ダイアログは出ない（Mandatory defense 10）。
    - 上限を超える本文、veto 行、宣言（allocation の前に拒否する）。読取の途中の取消（部分的な結果を出さない）。Graph-only の判定の中で超えた場合は、追加1枠だけを出さず、R+IR とその path の付加は変わらない。
    - 制御文字、改行、双方向の制御文字、64 個を超える長さを含む title でも、ダイアログの title は固定のラベルの付いた1行に収まり（置き換えと切り詰めの印が付く）、固定の文字列の行は変わらない。
    - excerpt が、Native が組む AI の request、Packing、履歴、export、audit、event、診断、log に現れないことも確かめる（renderer が表示した excerpt を利用者の入力として渡す経路は、試験の対象外。Out-of-scope attacks）。不適格になった候補（「利用時の判定」の手順 4 で本文を読んだ後に外れた場合を含む）の本文、title、それらの digest、range、長さ、Scene ID が、診断、log、event、Related Scenes の応答に現れないことも確かめる。この照合は文字列だけでなく、digest と range の値でも行う。Related Scenes の応答と event に、候補の有無、veto の種別、宣言の有無、reading、束縛の区別を表す値が現れないことも確かめる。あわせて、候補がない場合、「利用時の判定」の手順 3 と 4 のどこかで不適格になった場合、Graph-only の判定の中で K1b の上限を超えた場合のどれでも、理由の code、Graph の全体の状態、R+IR の path の付加が同じになることを確かめる（Graph の結果が D の窓に間に合う条件で比べる。処理時間の差は Out-of-scope）。
    - 宣言の取消: 宣言がない Scene の取消は何も書かない（feed も idempotency の記録も書かない）。取消の応答と event に、Graph の到達、候補の有無、veto の種別が現れない。取消の undo と、同じ要求の再送で宣言が戻らない。restricted では、登録されていない caller と別の workspace からの取消を拒否する。PUB-G の前の通常の起動での拒否は、上の「PUB-G の前の通常の起動」の項（Mandatory defense 10）のとおり。
  - Recovery: unavailable の後も R+IR はそのまま残り、次の query は最初から判定する。restore、workspace の移動の後は、作者が改めて宣言する。COMMIT の結果が分からないときは、その workspace での宣言の書込みと Graph-only の開示を再起動まで止める。再起動の後は DB の状態だけで判定する（marker はない）。
  - Lane unlocked if confirmed: `scope-storage-authority` の行とあわせて、CB-2（宣言の writer と MG-1 の BodyDeclaration）、CB-3（UI）、CB-4（parent の reader と再検証）、CP-3 の Graph-only 追加1枠、G-01 の正例と、G-02／G-07／G-08 の追加 Scene の測定（CP-4）。どれも通常の依存（DT-1 の seam、CP-1 の frame〔NQG2 を実装し、現行は NQG3〕、K1b の規則で integrator が選んで記録した数値）を満たしてから始める。G-01 の正例と追加 Scene の測定には、B-ROUTE による B の sealed binding と、X1/1 が確認された場合は X1-2 と X1-3 の merge もさらに要る（C14、「X1 への依存」の XK-7）。Graph の製品公開には、A3 + B + C + D2a と Session C-1 の承認がさらに要る。
- 受入れへの影響（l6-l9:762）:
  - 新しい authority と信頼境界: 作者の本文全体の宣言が新しい authority になる。Main の確認ダイアログと Native writer が新しい境界になる。評価用の CI seam は、ダイアログの代わりに承認できる経路で、packaged でない起動で `CI=true` などの env をそろえたときだけ働く（Mandatory defense 10）。seam の有効化は env の設定だけで決まり、秘密による認証ではない（Trusted actors と Out-of-scope の残余）。取消は確認を要さない（開示を止める向き。`scope-storage-authority` の「writer」の「取消の入口と grant」）。renderer は引き続き信用しない。
  - 品質閾値: 変えない。G-01 の Gold、query、corpus、seed、順序、指標、期待値、既存の 24 件、CP-0 が固定した G-02〜G-08 の fixture、Gold、期待値、前提条件、判定、P、K1 の値はそのまま。G-01 の setup と、G-02、G-07、G-08 の追加 Scene を持つ variant の setup に、観測前に固定する addendum（宣言の段）を足す。足すのは宣言の段だけで、fixture、期待値、前提条件、`setupTimeline` は変えない。
  - データの種類と送信先: 送信先は変えない。excerpt は Related Scenes の表示と遷移にだけ使い、AI 送信、Packing、履歴、export に出さない。renderer へ excerpt を返す経路（`related_scenes_begin`、`related_scenes_continue`、Graph の待受けの command、`nir1_evidence_qualify`）は、K3/2 の「restricted 下の route 区分」の「区分の構成」の表で、Related Scenes と Graph の行のとおり、unrestricted でも restricted でも `nir1-publication` に分類される。この行はその区分を変えない。K3 の O-2（外へ出ない自分のデータの閲覧を restricted でも開く）も、この経路の区分を変えない。renderer が表示した excerpt を利用者の入力として送ることは、この契約では防がない（Out-of-scope attacks。K5/3 の「B-1」の残余の (3) と同じ）。
  - 保存範囲: `scope-storage-authority` の差分（宣言と束縛の digest だけ。本文、excerpt、proof は保存しない）。
  - 受入れに加えるもの: 上の正例、負例、復旧。経路ごとの失効の試験（下の「失効」。title の A→B→A と割り込み、章の構造の変更とその戻しを含む）。3 OS の canonical locator。確認（grant）の試験。宣言の入口が unrestricted と restricted のそれぞれで、K3/2 の「区分の構成」の「宣言 UI（本文の宣言と取消）」の行のとおりの検査（登録済みの caller の確認は restricted だけ）で動く試験と、取消の入口が grant なしで動く試験（宣言がないときに何も書かないこと、応答の code、undo で戻らないことを含む）。ダイアログの title の表示規則の試験。評価用の CI seam が通常の起動と renderer から働かないことの試験。PUB-G の前の通常の起動で宣言の入口（preview、宣言の writer、取消）が typed に拒否される試験。測定に使う workspace で宣言が current であることの照合と、宣言の段の直前と直後で Index の metadata が同じであることの記録（CP-4 の TASK）。COMMIT の結果が不明なときの試験。excerpt がほかの出口に出ないことの試験と、不適格になった候補の本文、title、digest、range、長さ、Scene ID が診断と log に出ないことの試験。renderer へ返す理由の code の粒度の試験。
  - 変えないもの: R と R+IR の結果、既存の Related Scenes の excerpt と anchor、path の A3、A-1、Graph の製品公開条件。
  - 可用性: v1 で開示できるのは、POV を持たず、secret の foreshadow と secret な Chronicle event が掛からず、A1 が explicit な Scene に限る。本文、title、表示 metadata、A1 を変えるたび、restore のたび、workspace を動かすたびに失効し、作者が改めて宣言する必要がある。生きた Scene を含む章（folder）を移動、並べ替え、archive すると、戻しても、配下のすべての宣言が失効する（X1-1。#662 で merge 済み。今の製品には宣言の実装がないので、利用者が今失うものはない）。timeline、worldline、layer の registry を1つ変えるだけでも、project のすべての Scene の v1 の token が進むので、project 内の宣言がすべて失効する（下の「失効」）。R+IR の Scene の path の再検証が途中で食い違った query では、Graph の寄与が全体で 0 になる。Graph-only の候補の判定が食い違った query では、追加1枠だけが出ない。X1-2 の前は、どの Scene の本文の保存でも承認済みの型付き Revision がすべて stale になるので、宣言とは別の理由で Graph の寄与がなくなる（「X1 への依存」の XK-8）。

### 変更前後

| 項目 | 現行（`14fd3cfc`） | proposal/4（Option B） |
| ---- | ------------------ | ---------------------- |
| Graph-only target の本文 | 開示しない（authority がない。l6-l9:40） | 作者の宣言が current で、利用時の判定をすべて通ったときだけ、excerpt と anchor への遷移を出す |
| Graph-only target の title と locator | 出さない | Eligible のときだけ出す |
| 本文を読む場所 | —（worker は本文を読まない） | parent。frame の token と宣言の束縛に exact に一致したときだけ |
| 宣言と取消の入口 | なし | 宣言は Main の一回限りの確認 → Native writer。取消は確認を要さない。PUB-G までは、どちらも Native の gate で閉じ、評価用の CI seam が有効な起動でだけ開く |
| AI 送信、Packing、履歴、export | 閉じている | 閉じたまま（この開示を使わない） |
| G-01、G-02、G-07、G-08 の追加 Scene | Graph-only の追加ができない。G-01 は HOLD、G-02 base、G-07 base、G-08 の base-usable と graph-recovered は、C-body が Hold の間は返らず Hold になる（C16） | addendum の setup（宣言の段）で、固定済みの期待値に届きうる（実測は CP-4。B-ROUTE による B の sealed binding が前提。X1/1 が確認されれば X1-2 と X1-3 の後。C14、C16、XK-7） |

### 開示の範囲（excerpt、anchor、title、locator）

| 項目 | Eligible のとき | Unavailable のとき |
| ---- | --------------- | ------------------ |
| excerpt | canonical な本文の先頭の非空行の exact な文字列と、UTF-16 の range。表示上の折り畳みは、検証した文字列と range を変えない | 出さない |
| anchor への遷移 | click 時の再検証を通ったときだけ、その range へ遷移する | 遷移の handle を出さない |
| title | 宣言で束縛した title（現在の title の digest が宣言と一致するもの） | 出さない |
| locator（Scene ID、遷移の handle、pin の Entity との対応、tree の中の位置） | Scene ID と opaque な handle を出す。pin の対応は path の Evidence の一部として出す | 出さない。件数も出さない |
| path の Evidence | 既存の A2／A3 のとおり、Relation と Entity の Evidence を本文の anchor と分けて出す | Graph の寄与が 0 のときは出さない |
| 理由 | — | 閉じた集合の code だけ。Graph-only の追加については、候補の有無と不適格の理由を区別しない1つの code にし、target を識別する情報を含めない（Mandatory defense 9） |

- この行が扱う開示は、Scene を Graph の結果として query に関係づけて示すことである。tree の表示や、エディタで Scene を開くことは変えない。
- Graph-only の行から、chat の context や Packing へ渡す操作を作らない。
- event には target の情報を載せない。`related-scenes:graph-ready` の payload は projectId だけにする（DSN §3.4）。
- excerpt と本文は cache しない。返却のたびに parent が読み直す。次 query 用の cache（DSN §3.3）が持つのは worker の DTO だけ。
- 原稿そのものの通常の export（本文の書き出し）はこの契約の対象外で、変わらない。

### 宣言の値（v1 は G-01 subset）

宣言の対象は、保存された本文（`tree_nodes.content`）の全体と title。unplaced beats（`unplaced_beats_doc`）とメモは開示しないので、対象に含めない。1回の確認で宣言できるのは1つの Scene だけ。

| 軸 | v1 で受け付ける値 | 作者の宣言の意味 | Native の確認 | v1 で受け付けない値（fail-closed） |
| -- | ----------------- | ---------------- | ------------- | ----------------------------------- |
| reading | （宣言しない） | — | target の reading rank が query より小さいこと。live な project Scope authority から、両方を同じ read の中で導く。等しい、不明、曖昧なら拒否 | 宣言で外すこと |
| story | `independent` | story time の前後に関係なく、本文全体を開示してよい | 宣言を信じる | 特定の Scene より後でだけ開示する、などの条件 |
| auto | `independent` | phase の解決の軸（reading と story）に関係なく開示してよい | 宣言を信じる | 条件付きの値 |
| phase | `independent` | Codex の phase に関係なく開示してよい | 宣言を信じる | phase の集合を条件にすること |
| reveal | `non-secret` | 本文全体に、まだ明かしていない秘密を含まない | veto: 次のどれかがあれば拒否する。secret の foreshadow の setup、payoff、旧式の payoff が target を参照している（abandoned や payoff の確定の有無を問わない）。secret な Chronicle event の `reveal_scene_id` が target である。`scene_events` が secret な Chronicle event を target に結んでいる（reveal が読む順のどこにあるかを問わない。C9） | 明かす foreshadow や event を列挙して条件にすること |
| POV | `independent` | 視点に限られた知識を含まず、どの視点の query にも開示してよい | veto: Scene の POV、保存本文の `sceneBeat` の `pov`、`scene_beat_pov_cache` のどれかがあれば拒否 | 特定の人物の視点に限ること |
| A1（timeline、worldline、layer、holder、audience） | （宣言しない） | — | marker が explicit で、query identity の3軸が exact であること。query と一致すること（`validate_scene_scope`）。宣言で緩めない | — |

- `independent` と `non-secret` は作者の明示の宣言で、未入力や既定値として扱わない。
- veto に使うのは、本文そのものを分類している記録（この Scene に掛かる foreshadow と Chronicle event、この Scene の POV）だけ。Chronicle event の秘匿は、正本の `events` と `scene_events` で確かめ、そこから導いた抽出の Revision は使わない。phase の anchor のように Entity の側を表す記録は、宣言を覆す根拠にしない。記録がないことを、秘密がないことや視点がないことの証明として扱わない。
- veto は writer（宣言の時）と reader（返却時と click 時）の両方で確かめる。宣言の後に foreshadow や Chronicle event を secret にした場合も、target に掛けた場合も、reader が拒否する。
- 受け付けない値の意味を足すときは、新しい draftRef で起案する。

### 利用時の判定（parent で読む）

返却時は、worker の lease を drop した後、Related Scenes の participant の新しい read transaction の中で次の順に行う。DSN §2.3 の順序に従い、Graph-only の候補の失敗の扱いだけを変える（手順の後の「Graph-only の候補についての失敗の扱い」）。

1. B の seal が frame の値と一致することを確かめる（DSN §2.3 の (a)）。一致しなければ、Graph の寄与を全体で 0 にし、手順 2 以降に進まない。
2. R+IR の Scene に付ける path の association を、DSN §2.3 の (b)、(c) で再検証する。どれか1つでも食い違えば、DSN §2.3 の (d) のとおり Graph の寄与を全体で 0 にし、手順 3 に進まない。
3. 共通追加1枠の条件を満たすときだけ、R+IR にない Scene を frame の tuple の順に判定する。条件は、IR が共通追加枠を使っていないこと（kind が `ir` の行がない。IR が空で結果の基底が Raw だけの場合を含む。C14）と、Raw が 8 件未満であること。各 Scene に本文を読まない次の判定を行い、どれかに外れた Scene は採用せず、次の候補へ進む。最初にすべてを通った1件を採用して止める。
   - Scene が同じ project にあり、live で archive されていない。
   - A1 の条件（上の表）と reading-before を満たす。
   - 宣言の2列がそろい、版が既知で、JSON が閉じた型として正しく、token が JSON から計算し直した値と一致する。値が v1 の subset に入る。
   - 宣言の束縛が現在の値と一致する: incarnation、v1 の token、本文の Source の token、title の digest、workspace ID、canonical locator の digest。
   - veto に当たらない（secret の foreshadow、secret な Chronicle event、Scene の POV、`scene_beat_pov_cache`）。
   - その workspace が quarantine 中でない（下の「COMMIT の結果が分からないとき」）。
   - frame の値（incarnation、source token、scope token）が parent の読取と一致する（DSN §2.3 の (c)）。
   - `recheck_scene_pin`（`narrative_extraction/nir1_graph/scenes.rs:559`。CP-1 が parent 側の再検証用に用意した）が通る（同じく (c)）。pin は locator としてだけ使う。
   - 代表 path の material binding の token が current である（DSN §2.3 の (b)。既存の A2／A3 の revalidate）。path の A3 は query の Scene のものとして扱い、target 本文の根拠に流用しない。
4. 採用した1件の本文を K1b の上限の内で読み、次を確かめる。storage digest、canonical digest、正規化の版、UTF-16 長が宣言の束縛と一致する。保存本文の `sceneBeat` に `pov` の指定がない。本文が空でない。excerpt は canonical な本文の先頭の非空行にする。どれかに外れたら、2件目の本文は読まず、その query の Graph-only の追加を出さない。
5. 結果は `Eligible`（title、excerpt、UTF-16 の range、excerpt の digest、request-local な binding）か `Unavailable`（理由）。request-local な binding は返却と click の照合にだけ使い、永続化しない。renderer には opaque な handle だけを渡す。`Unavailable` の理由は Native の中だけで使い、renderer へは Mandatory defense 9 のとおりにまとめた code だけを返す。

Graph-only の候補についての失敗の扱い:

- その query の Graph-only の追加を出さないことだけにとどめる。手順 3 と 4 のどれに外れた場合も、手順 3 と 4 の中で K1b の上限を超えた場合も同じで、手順 1 と 2 で決まった Graph の全体の状態と R+IR の path の付加は変えない。途中で止めた判定の結果は使わない。
- DSN §2.3 との違い: DSN は、採用した Graph-only の association の (b)、(c) の不一致と本文の token の不一致でも、Graph の寄与を全体で 0 にする。この draft はそれを採らない。全体を 0 にすると、R+IR に path の付加がある query ではそれが消え、ない query では Graph の全体の理由 code が変わるので、Graph-only の候補があったことを renderer が判別できる（Mandatory defense 9）。
- 根拠: K1 で確認された `nir1-defensive-resource-limits` の C-body の行（「その Graph 追加候補を出さない。R+IR の結果はそのまま残る」）と一致する。DSN §2.3 でも、本文を読まない判定で不適格な候補は飛ばすだけで、Graph の寄与を 0 にしない。この draft は、再検証の失敗と上限の超過も、同じ「追加しない」の側に寄せる。
- partial Graph にあたらないこと: worker の列挙は完了しており、R+IR の path の付加は手順 2 で全件を再検証済みなので、`graph-limited-binding` が禁じる partial Graph（列挙を打ち切った結果）にはあたらない。採用する1件は、手順 3 と 4 で parent の現在の読取とすべて照合してから使うので、worker の snapshot と parent の読取を未検証のまま混ぜることにもならない。
- 作業量: pin の再読取、path の再検証、本文以外の判定は、それぞれ frame の件数 N_F（今は 8。「資源」）以下、本文の読取は1件以下で、DSN §2.3 の見積りの範囲に収まる。

click 時は、navigation handle から新しい read transaction で、その Scene について手順 3 の各項目（共通追加1枠の条件と tuple の順の走査は除く。frame の値の代わりに、返却時の request-local な binding と照合する）と手順 4 をやり直し、excerpt と range が返却時と一致するときだけ遷移する（既存の `nir1_evidence_qualify` を拡張する。DSN §2.3）。一致しなければ遷移しない。宣言の取消やクリアを feed で知らせて表示中の行を消す方法は CP-3 で決めるが、click 時の再検証はそれとは独立に働く。

### Main の一回限りの確認

DSN §7 の共通の grant の上に、種類 `BodyDeclaration` を置く。

- 要件: 有効は 60 秒。同時に1件（process 全体で、種類を問わない）。sender（WebContents）と window に束縛する。u64 の値（lifecycle の revision、authority instance）は Native の中だけに置き、JS を通さない。OCC と digest に束縛する。writer の前に消費し、書込みが失敗しても戻さない。renderer は grant を発行も参照もできない。
- binding: exact な Ready の LiveBinding、lifecycle の revision、workspace ID と canonical locator の digest、project、Scene、incarnation、OCC（v1 の version と token、宣言の現在の token か NULL）、本文の Source（token、storage digest、canonical digest、正規化の版、UTF-16 長）、title の digest、宣言の値の digest、ダイアログの表示文の digest。DSN §7.3 の `BodyDeclaration` に、v1 の token、title の digest、storage digest、正規化の版、UTF-16 長、宣言の現在の token、表示文の digest を足す。消費する writer は、DSN §7.3 が K2 の確認の後に改める予定とするとおり、`narrative_scene_scope_update` の分岐ではなく、宣言の入口（`scope-storage-authority` の「writer」）にする。
- ダイアログ:
  - 文面は、Native が作る allowlist の固定の文字列と、Native が整えた title と文字数だけで組む。renderer の文字列と、本文に由来する文字列は使わない。
  - title の表示規則: title は作者のデータで、AI Apply なども書く（C12）。Native が、Unicode の制御文字（Cc）、書式文字（Cf。双方向の制御と幅のない文字を含む）、行と段落の区切り（Zl、Zp）を U+FFFD に置き換え、Unicode のスカラー値で 64 個までに切り詰める（切り詰めたときは固定の印を付ける）。整えた title は、固定のラベルを付けた独立の行に、固定の括弧で囲んで置く。title がほかの文言をまねても、固定の文字列の行は変わらない。
  - 表示する title は、binding の title の digest を計算したのと同じ読取の値から作り、別に読み直さない。表示文の全体（固定の文字列、整えた title、文字数）の digest を binding に入れる。
  - 表示する内容: Scene の title、宣言する値の意味、対象が本文の全体（文字数）と title であること、効果が Related Scenes での excerpt の表示と遷移だけで AI には送らないこと、本文、title、A1 の変更、restore、workspace の移動で失効すること、その Scene を含む章（folder）の移動や archive でも失効すること、timeline、worldline、layer の registry を変えると project のすべての宣言が失効すること。既定のボタンは取消にする。
- 取り消す契機: ダイアログの取消、sender の破棄と遷移、window の close、lifecycle の edge（TransitionAdmitted、Unavailable、ShutdownRequested）、D2a の epoch の変化、期限切れ。
- X1 と grant の束縛: grant の binding のうち、宣言の束縛と重なるもの（incarnation、v1 の version と token、本文 Source の token と digest、title の digest、workspace の束縛）は、preview から consume までの間の変化を writer で拒否させ、書いた後は同じ値の不一致で宣言を失効させる。grant の拒否と宣言の失効は同じ値で決まるので、X1 で値の進み方が変わっても、片方だけが変わることはない。
  - DSN §7.3 は、`BodyDeclaration` の grant が「Scene Scope の binding の版（OCC）」と「本文の source token と canonical digest」を束縛すると書く。X1 は、binding の版（v1 の version）がいつ進むかを変える。X1-1（merge 済み）の後は、生きた Scene を含む folder の構造の変更でも進むので、ダイアログの間にその Scene の章を動かすと grant は拒否される（失効を増やす側）。X1-2 の後は、題名と表示 metadata の更新と本文の保存では進まない。
  - このため、binding の版だけで本文や題名の変更を捕まえる前提は置かない。この draft の binding は、本文 Source の token と digest、title の digest、表示文の digest を必ず含み、X1-2 の後の本文や題名の変更は、本文 Source の token（`version` か、`updated_at` の厳密な前進。X1/1 の Delta の 1）と title の digest で拒否される。表示 metadata だけの変更も本文 Source の token を進めるので、ダイアログの間にそれがあれば拒否される（失効を増やす側）。
  - OCC に v1 の token を入れるのは、X1/1 の Q2 の対案（registry の変更で、参照しない binding の版を進めず、token だけを計算し直す）でも、ダイアログの間の registry の変更を捕まえるためである。今の master と、Q2 を推奨のまま確認した場合は、version と token が一緒に変わる。
  - X1-2 の前（今の master）は、Scene の行への書込みのたびに v1 の version と本文 Source の token が両方変わるので、どちらでも拒否される。
- 評価の harness（standard build。C13）が宣言する段では、ダイアログの代わりに、製品 Main の中の CI seam が承認してよい。
  - gate: `narrativeMaintenanceCiSeam.ts` と同じ形にする。packaged の起動では無効で、`CI=true`、source の公開の定数と exact に一致する owner token、起動ごとの nonce（UUIDv4）が env にそろったときだけ有効になる。owner token と nonce は秘密ではなく、誤った起動を防ぐ印にとどまる（C13）。実効的な境界は、packaged でないことと env を設定できることである（Trusted actors と Out-of-scope の残余）。seam は Main の中だけで働き、renderer、preload、IPC からは有効にも無効にもできない。通常の起動と packaged の起動では到達できない（post-B §4.4 の「rendererから試験transport、fixture proof、test-only bypassを選択できない」「許可を与える入口は隔離する」）。
  - 範囲: seam が置き換えるのは、ダイアログの表示と押下だけ。承認するのは `BodyDeclaration` だけ（`ProfileActivation` は K3/2 の「activation の trigger と開示」の「公開」の (a) の journey seam が別に扱う）。Native の preview、issue、consume、writer、期限、同時1件、sender と window の束縛は製品と同じ経路を使う。PUB-G より前に宣言の入口の gate を開くのも、この seam が有効な起動に限る（Mandatory defense 10。A-1）。seam が無効な起動では gate は閉じたままである。
  - 宣言の段に使う Main: standard build の製品 Main（差し替えのない main）を使う。setup のほかの段に、決定論の provider の対応表だけを差し替えた Main（C14 の (c)。S1 の setup 専用の Main）を使う場合も、宣言の段には使わない。
  - 記録: seam を使った事実（seam の版、env の名前、nonce の digest、承認した grant の数と binding の digest）を Main の receipt に書き、宣言した段の receipt（setup か測定）から参照する。
  - 試験: packaged の起動、`CI` のない起動、owner token の env がないか定数と違う起動、renderer の IPC からの要求では seam が働かず、ダイアログなしの承認ができないこと。そのどの起動でも、PUB-G の前は宣言の入口の gate が閉じたままであること。
- 測定の workspace: 宣言は workspace ID と canonical locator に束縛されるので、Graph arm の測定に使う workspace で宣言が current でなければならない。現行の P の paired harness は setup の DB だけを別の path に書き出して開くので（C13）、その方式のままでは、setup で行った宣言は測定の workspace で失効する。次のどちらにするかは、観測前の commit（CP-4。「確認の扱い」）が決めて addendum に書く。(i) setup の workspace で宣言し、同じ workspace（同じ path と workspace ID）で測る。(ii) 測定に使う workspace を開いた後、Graph arm の最初の query の前に、この節の CI seam を通して宣言する。どちらでも、測定の receipt に、測定に使った workspace の workspace ID と canonical locator の digest と、宣言の token を記録する。Graph arm の最初の query の前に、宣言が current であること（束縛の digest が一致すること）を照合し、一致しなければ測定の前に `[precheck]` で止める。宣言の段の直前と直後で、B の Graph index と Chronicle の IR の Index の metadata（generation と dirty）が同じであることも、同じ receipt に記録して照合する（宣言の kind の event だけの transaction は Index を dirty にしない。C17。違えば同じく `[precheck]` で止める）。宣言の段、receipt の記録、これらの照合を harness に実装し実行するのは、Graph arm を動かし、観測前の commit も作る CP-4 である。CB-4 の受入れは、失効した宣言で開示しない試験（経路ごとの失効の試験）までを担い、この照合は担わない。この照合は fixture の前提条件に加えない（CP-0 が freeze した前提条件の集合は変えない）。一致しない run は `blocked` ではなく、測定の前の `[precheck]` で止まる。この規則は、宣言を要する run のすべて（「setup の addendum」の表の5 run）に当てはまる。

### COMMIT の結果が分からないとき

- 該当するのは、COMMIT がエラーを返したとき、COMMIT の後に結果を受け取れなかったとき、COMMIT の途中で owner の thread が panic したとき。
- 手順:
  1. writer の接続で rollback を試み、autocommit に戻ったことを確かめる。確かめられなければ、既存の規則どおり接続を quarantine して退役させる。
  2. 有限の待機（K1b）の中で、清潔な接続で新しい read transaction を開き、exact な識別子を読む: request の idempotency の記録（request ID と payload の hash）、change event の UID、その Scene の宣言の token。
  3. 3つとも書込み後の値なら、成功として扱う。3つとも書込み前の値（記録も event もなく、宣言が書込み前の token か NULL）で、手順 1 の rollback を確かめていれば、失敗として扱う。grant は戻さず、作者は新しい確認からやり直す。記録がないことだけで失敗とは判定しない。
  4. それ以外の場合と、読めなかった場合は不明とする。その process の中で、その workspace の宣言と取消の書込みを `restart-required` で拒否し、Graph-only の開示を unavailable にする（quarantine）。原稿の保存などほかの操作は止めない。接続の quarantine の既存の規則は変えない。quarantine は process の再起動で解ける。
- marker: 宣言の書込みの途中を表す永続の marker や意図の記録は作らない。宣言、feed、idempotency の記録は一つの transaction なので、再起動の後の DB は「全部入った」か「何も入っていない」のどちらかになる。どちらも作者が確認した範囲の状態である（入った場合は Main で確認済みの宣言、入らなかった場合は宣言なし）。再起動の後は DB の状態だけで判定する。手順 3 で失敗と判定した後でも、storage の障害の種類によっては、再起動の後の WAL の回復で宣言が現れることがありうる。それも作者が確認した宣言なので、開示の安全性は変わらない（UI は DB の状態をそのまま表示する）。
- COMMIT が戻らない間は、その終端を待つ。shutdown が終わらない場合の終端は、Main の観測予算の後の `exit(1)` で、DSN §1.6 の 4 と同じ。fsync の時間には上限を置けないので、残るリスクとして受け入れる。

### canonical locator

- 目的: 宣言を、宣言した workspace でだけ有効にする。複写や移動の先では有効にしない。
- 計算: workspace が Ready になったとき、Native が workspace の root を OS の canonicalize で解決した path から一度だけ作る。preview、writer、reader は同じ値を使う。LiveBinding の locator（C6）は使わない。
- 規則:
  - symlink は解決する。symlink 経由で開いても同じ値になる。
  - macOS では、`/var` や `/tmp` などは `/private/...` に解決した形を使う。
  - Windows では、OS が返す verbatim の形（`\\?\C:\...`、`\\?\UNC\server\share\...`）をそのまま使い、prefix を足したり外したりしない。大文字と小文字を畳まず、OS が返す形のまま使う。ネットワーク drive も OS が返す canonical な形で比べる。
  - path が Unicode として正しくなければ（lossy な変換が要るなら）unavailable にする。canonicalize が失敗した場合も unavailable にする。どちらの場合も writer は宣言を拒否する。
  - 比較は byte の完全一致で行う。DB に保存するのはドメイン分離した digest で、path の文字列は保存しない。
- 同じ workspace とみなす条件: workspace ID（`.grimodex/workspace.json` の id）と canonical locator の digest が両方一致すること。authority instance、recovery generation、DB file の identity は使わない。前の2つは process ごとに変わり、DB file の identity は backup の restore で変わるため。app の中の restore は宣言を消すので、DB file の identity がなくても宣言は持ち越されない。
- 帰結: folder を複写した先では失効する。移動や名前の変更でも失効し、作者が改めて宣言する。ただし、元の path へ戻し、workspace ID も元のままなら、同じ bytes の宣言は再び有効になる（許容する。下の「失効」）。symlink 経由の open では有効。同じ path でも workspace.json の id が違えば失効する。
- 判定の時点: 失効の判定は、次に Ready になったときに作る locator で行う。open している間の folder の移動や改名は、その間の判定に反映しない（app の外の操作は Out-of-scope）。
- 試験: Windows（verbatim の形）、macOS（`/private` 配下の temp）、Linux（symlink 経由の open と folder の複写）で行う。
  - 大文字と小文字だけが違う綴りの path から同じ folder を開く場合も、macOS（既定の APFS）と Windows（NTFS）で試す。OS の canonicalize が on-disk の綴りを返せば同じ locator になり、宣言は有効のまま。返さなければ別の locator になり、失効する（fail-closed。作者が改めて宣言する）。Linux で大文字と小文字を区別しない directory（ext4 の casefold など）を使う場合も同じ扱いにする。
  - どちらになったかを、OS と版ごとに試験の記録に残す。どちらの結果もこの行に適合する。大文字と小文字を畳む処理は足さない（足すには新しい draftRef が要る）。Positive の「閉じて開き直す → 有効」は、同じ綴りの path で開き直す場合に求める。
- この規則は、K4/3 の §7 の canonical locator（durable workspace identity の一部）と同じで、実装は一つにする（K4/3 の §7）。K4/3 の「確認に出す前の照合」の (14) は、/3 のこの節と照合した。/4 はこの節を変えていない。

### setup の addendum（G-01 と、G-02／G-07／G-08 の追加 Scene）

- 対象の file:
  - G-01: `evals/nir1-g01/fixture.v1.json`（`nir1-g01-explicit-pin-design/1`、sha256 `996ef1c0…`）。この file は変えない。
  - G-02、G-07、G-08: CP-0（#639、`6bdf61e9`）が freeze した `evals/nir1-graph/g02-directed-relation.v1.json`（sha256 `c9e9ea0c…`）、`g07-reading-before-reveal.v1.json`（`385eaa73…`）、`g08-graph-index-fallback.v1.json`（`0415561e…`）。`freeze.v1.json`（`45d8a055…`）が束縛する file（manifest、schema、README、期待値レビューの記録）も変えない。変えると hash が一致せず `pnpm eval:fixtures` が失敗する。束縛した file を変えないので、freeze のやり直しは要らない。ただし、資源の proposal/7 が確認された場合は、CQ-LIM-4 が G-03、schema、README、期待値レビューの記録を直して `freeze.v1.json` を作り直すので、`freeze.v1.json` の sha256（と schema、README、期待値レビューの記録の sha）は変わりうる。G-02、G-07、G-08 の fixture 3 件は変わらない。この draft の確認はそれに依らず、その場合の addendum は作り直した後の `freeze.v1.json` の sha256 を引く（proposal/7 の「他の draft との関係」の K2/4 の行）。
- 宣言する Scene は、期待値が Graph-only の追加（`appendedSceneId`）を持つ variant の、次の4つである。G-03〜G-06 と、G-08 の graph-index-unusable、chronicle-index-unusable、both-indexes-unusable は追加 Scene を期待しないので、宣言を要しない（C16）。

| case と variant | 宣言する Scene | reading（Scene／query） | veto に当たる記録 | 期待する excerpt の範囲 |
| --------------- | -------------- | ----------------------- | ----------------- | ----------------------- |
| G-01 | `g01-mira` | 20／100 | なし | `[0,78)` |
| G-02 base | `g02-tamsin-first` | 30／100 | なし（foreshadow なし） | `[0,78)` |
| G-07 base | `g07-pell-dock` | 40／100 | なし（secret の foreshadow 3件の payoff の Scene は `g07-rhea-reveal`、`g07-late`、なし。`g07-pell-dock` を参照しない） | `[0,70)` |
| G-08 base-usable、graph-recovered | `g08-cass-attic` | 20／100 | なし（foreshadow なし） | `[0,64)` |

どの Scene も、POV、story time、Chronicle event を持たず、A1 は explicit で、reading が query より前なので、v1 の subset で宣言できる。

- 足す手順（4つの Scene で共通）:
  - 宣言: 上の表の Scene だけを、通常の宣言の経路（Main の確認 → Native writer）で宣言する。値は v1 の subset（story、auto、phase は `independent`、reveal は `non-secret`、POV は `independent`）で、対象は本文の全体と title。同じ run のほかの Scene は宣言しない。
  - 宣言の run: manifest の isolation は、case と variant ごとに新しい workspace を使うと定める。宣言は workspace に束縛されるので、run ごとに行う（G-01、G-02 base、G-07 base、G-08 base-usable、G-08 graph-recovered の5 run）。G-08 の3つの unusable variant では宣言しない。追加 Scene を期待せず、宣言の有無は期待値を変えない。
  - 宣言の時期（G-01）: 候補 §7 の Scene（本文、title、tree の順序）、明示 A1、project の registry を通常の writer で設定し終えた後で、Graph arm の最初の query より前。
  - 宣言の時期（G-02、G-07、G-08）: freeze 済みの `setupOrder` の「foreshadow、foreshadow の Codex link、pin」の段の後で、Graph arm の最初の query より前。その時点で Scene、明示 A1、registry、foreshadow がそろい、writer の veto が最終の記録を読む。`setupTimeline` の step（Revision、mutation、`qualified-ir`）の前でも後でもよい。mutation は Codex の Relation の型と entry の summary の編集と IR の承認撤回で、追加 Scene の本文、title、A1 に触れないので、宣言は失効しない（C16）。G-08 の graph-recovered では、mutation の commit から測定点（再 build の後）までの間に、宣言の書込みを入れない（Index の状態の遷移を乱さない）。宣言の段は `setupTimeline` の step にも `measurementPoint` にも数えず、fixture は変えない。
  - freeze 済みの `setupOrder` との関係（G-02、G-07、G-08）: 3件の fixture の `measurementBoundary.setupOrder` は同じ文で、「project と全 Scene → Codex の entity と relation → Scope registry と明示 A1 → foreshadow、foreshadow Codex link、pin → maintenance の有効化 → `setupTimeline` の順」と定め、宣言の段を持たない。この文は `freeze.v1.json` が束縛するので書き換えず、addendum もこの文に段を足さない。宣言の段は、`setupOrder` の外で、「foreshadows, foreshadow Codex links and pins」の段の後、Graph arm の最初の query の前に addendum が挟む1段である。`setupOrder` の各段の順序と内容、`setupTimeline`、`measurementPoint` は変えない。`setupOrder` には「最初の型付き Revision を prepare した後は tree order、registry、Scene Scope を変えない」という制約（原文は "Do not change tree order, registry or Scene Scope after the first typed revision is prepared"）がある。fixture の Scene Scope は、`setupOrder` の「every explicit Scene Scope」の段が設定する明示 A1 の値を指す。宣言の writer は tree order と registry を書かず、v1 の列と A1 の意味の列も書かない（C15）ので、宣言が `setupTimeline` の後に入る場合も、この制約に当たらない。観測前の commit の reviewer が確かめるのは、宣言の段の前後で tree order、registry、v1 の列、A1 の値、Index の metadata が変わらないこと（下の「宣言の後は…」の項と、測定の receipt の項）である。
  - 宣言の場所（setup の中か、測定の workspace を開いた後か）: 上の「Main の一回限りの確認」の「測定の workspace」の (i)、(ii) のどちらかで、観測前の commit（CP-4）が決める。確認の通し方（CI seam）と、宣言の段に使う Main も、同じ節のとおり。4つの Scene で同じ選択にする。
  - 宣言の後は、その Scene の本文、title、A1、順序、その Scene を含む folder の構造と、project の registry を変えない（folder の構造の変更は X1-1 で配下の Scene の v1 を進める。C2）。宣言は行の v1 の列（`updated_at` を含む）を書き換えないので project の Scope authority の revision を変えず、feed でも Scope authority の変更として扱われず、その kind の event だけの transaction は Index を dirty にしない（C8、C11、C15、C17 と `scope-storage-authority` の行）。このため、Entity／Relation の Revision の準備と承認、pin、Chronicle の IR、B の seal は、宣言の前でも後でもよい。宣言の段の直前と直後で、B の Graph index と Chronicle の IR の Index の metadata（generation と dirty）が同じであることを、測定の receipt に記録する（「Main の一回限りの確認」の「測定の workspace」）。
  - B の sealed binding: Graph arm に要る B の sealed binding は、Revision の承認と pin の後に、正規の経路（B-ROUTE〔#643〕が maintenance の cycle に配線した B の build。`narrative_extraction/nir1_graph_index_maintenance.rs:924`）で確立する（候補 :217-218）。試験と診断用の publish の呼出し（C14 の (b)）は使わない。正規の経路で確立できなければ、候補 :242-243 のとおり G-01 は v1 期待値未達／Hold で、宣言では解けない。G-02〜G-08 は前提条件 `b-sealed-binding` が成り立たず、`blocked:b-sealed-binding` と記録される。
  - 記録の前提: `g01-mira` には、POV、secret の foreshadow、secret な Chronicle event を設定しない（候補 §7 の「非secret」と同じ）。`g01-mira` の story_time_order は NULL のまま（S1 の setup と同じ。C14 の (d)）。G-02、G-07、G-08 の fixture は POV、story time、Chronicle event を設定しない。v1 の story は `independent` を宣言するので、story の位置は要らない。POV は、記録があれば veto になるだけで、明示の POV は要らない。reading-before は、fixture の reading order（追加 Scene は 20〜40、query は 100）を setup が実現した読む順から、live な project Scope authority で導く。
  - `cb4-inputs`: 宣言の値は story と POV が `independent` なので、CB-4 は story position も POV も要求しない。G-02 base、G-07 base、G-08 の base-usable と graph-recovered の前提条件 `cb4-inputs` は成り立つ。宣言がなく追加 Scene が返らないことは `cb4-inputs` に当たらず、期待値と違うので Hold になる（`evals/nir1-graph/README.md` の「観測規則と失敗時の扱い」）。
  - R と R+IR の setup は変えない。S1 が観測の前に固定した setup の選択（C14 の (d)。S1 の `SETUP_DECISIONS`）を、S1 の harness を取り込む lane（K6/2 の案1 の `G01-RM`、案2 の DA-1、または CP-4）が新しい候補として取り込み、CP-4 もそれを使う。R と R+IR は、その setup で v1 の期待値と一致した。
- 変えないもの: G-01 の query、corpus（本文と title）、seed、Gold（`g01-mira` = 3）、順序の規則、指標、期待値（R と R+IR は `[g01-question]`、R+IR+Graph は `[g01-question, g01-mira]`、excerpt は `[0,78)`、Recall@8 は 0→1、nDCG@8 は約 0.6309）。S1 で R+IR の IR が空（基底が `raw`）だったこと（C14 の (a)）は、共通追加1枠の条件を変えない（kind が `ir` の行がない）。G-02、G-07、G-08 は、CP-0 が freeze した query、Scene、Gold、期待値、前提条件、`setupTimeline`、variant のまま（上の表の excerpt の範囲は freeze 済みの期待値である）。
- 観測前に一緒に固定する負例（Gold ではなく、診断用の期待値）:
  - G-01: 宣言しない場合は R+IR+Graph が R+IR と同じになる。宣言の後に `g01-mira` の本文を同じ文字列で保存し直すと出ない。宣言の後に `g01-mira` の本文版を restore すると（同じ bytes に戻す場合も）出ない。
  - G-02 base、G-07 base、G-08 base-usable: 宣言しない run では、R+IR+Graph が観測した R+IR と同じになり、追加 Scene が返らない。この run は Gold の run とは別に行い、結果は診断として記録するだけで、case の判定（pass、hold、blocked）に数えない。失効の負例（再保存と restore）は、G-01 と CB-4 の経路ごとの試験で足りるので、G-02、G-07、G-08 では足さない。
- 固定の時期と方法: addendum は別の file にし、観測前の commit（CP-4）が作る（file の名前と置き場も観測前の commit が決める。例: G-01 の分を `evals/nir1-g01/setup-addendum.v1.json`、G-02、G-07、G-08 の分を freeze が束縛しない新しい file に置く。G-01 の fixture v1 と `freeze.v1.json` の sha256 を参照する。資源の proposal/7 が確認されて CQ-LIM-4 が `freeze.v1.json` を作り直した場合は、作り直した後の sha256 を参照する）。G-01 の R+IR+Graph（本文の開示を含む）と、G-02、G-07、G-08 の Graph arm を観測するどの実行よりも前の commit に入れ、期待値を独立した reviewer が確かめた記録をその commit に束縛する（CP-0 が G-02〜G-08 に行ったのと同じ手順）。reviewer が確かめるのは、4つの Scene が v1 の subset で宣言できること（veto に当たる記録も POV もない）、宣言の段が freeze 済みの期待値、前提条件、`setupTimeline` を変えないこと、診断用の負例である。quality-manifest と impact-map に分類する。addendum の宣言する Scene と値、期待値、診断用の負例は、この draft だけから決まるので、そのまま写す。観測前の commit が書き足すのは、宣言の場所（(i) か (ii)）と、B の seal の手順（B-ROUTE の経路の呼び方）だけで、どちらも期待値を変えない。R と R+IR の setup の選択（S1 の `SETUP_DECISIONS`）は harness の側にあり、addendum では変えない。S1 の観測値（R と R+IR の結果、score、association の記録）は、addendum の期待値に使わない。
- S1 では R と R+IR が v1 の期待値と一致した（C14）。G-01 の fixture が改訂された場合（K6 の `g01-eval-revision`）に限り、改訂後の版を参照する addendum の新しい版を、その freeze の前に同じ手順で作る。宣言する Scene（`g01-mira`）と値は変えない。G-02、G-07、G-08 の fixture が改版される場合（README の「観測規則と失敗時の扱い」）も、改版後の版を参照する addendum の新しい版を、その freeze の前に同じ手順で作る。宣言する値は変えない。
- Option A を選んだ場合は、addendum を作らない。

### 資源（K1 に従う）

- worker の query: 確認済みの `graph-limited-binding` の版の値に従う。今は K1（proposal/6）の固定値（read／admission `512`、batch `16x32`、SQL `100,000 VM steps`、result lease `100 ms`、reader／busy wait `0`、2hop／12／144／8、per-Revision preflight `2,097,152 B`）で、資源の proposal/7（SB-4、SB-5）が確認されれば、その値になる。worker は本文を読まないので、C-body はこの予算を使わず、この行はその値を変えない。frame に載せる association の件数 N_F は、確認済みの版の Scene の上限である（今は K1 の Scene 8。K1 は資格判定の前に件数を広げる DSN の逸脱案を採っていないので、DSN の判断 D-08 の既定のまま）。
- 新しい上限（K1b の対象。K1 の表の C-body の行。`docs/plans/nir1-l6-l9-contract-proposal-6-draft.md:155`、`14fd3cfc`）: 本文の読取の bytes（storage と canonical。materialize の前に octet_length で検査する）、veto の行の件数（foreshadow と Chronicle event の行。N と N+1）、宣言の JSON の bytes、parent の判定の SQL steps と期限、DB mutex と busy の待ち、writer の操作ごとの期限、COMMIT の結果の読み直しの期限。K1b は確認済みなので、数値は integrator が実測から選び、PR に記録する（数値ごとの確認は要らない）。merge の後に緩めるには、K1b の規則 7（同じ file の :169）のとおり再確認を要する。宣言の preview と reader は、本文の読取の上限として同じ値を使う（宣言できた本文は読める）。
- この行で固定する値: 確認の期限 60 秒、同時の確認 1件、query ごとの本文の読取 最大1件、excerpt は先頭の非空行だけ。どれも、緩めるには再確認を要する。
- 超えたとき: 本文を読む前の判定（上の手順 3）でも、読んだ後（手順 4）でも、その query の Graph-only の判定をそこで止め、追加1枠を出さない（K1 の表の C-body の行「その Graph 追加候補を出さない。R+IR の結果はそのまま残る」）。R+IR とその path の付加、Graph の全体の状態は変えない（Mandatory defense 9）。手順 1 と 2 の中で超えた場合は、Graph の寄与を全体で 0 にする（`graph-limited-binding` の fail-safe）。writer は typed に失敗し、部分的に書かない。
- P（B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms）は変えない。parent の判定は Graph の到着の時刻に含まれ、D の窓を過ぎた Graph はその query に混ぜない（post-B §7.2）。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId graph-target-scene-body-disclosure.`

## scope-storage-authority（`nir1-l6-l9-contract-proposal/3` への差分: Scene Scope v2）

- Baseline (approved; limited): `nir1-l6-l9-contract-proposal/3#scope-storage-authority`（l6-l9:129、:143-152）。Native が所有する project の registry と、Scene ごとの閉じた binding（A1 の軸、incarnation、互換 marker、principal、OCC の version、source token）を保存し、本文や full closure を複製しない。設定、registry、incarnation の変更は、同じ transaction で依存を失効させる。第二の authority は作らない。clear と undo は旧資格に戻さず、restore は旧資格を復活させない（l6-l9:146、:605-621）。本文の開示に関する欄はない。
- Delta (L6-L9 storage; proposal/4 draft): 既存の Scene ごとの binding の行（`narrative_scene_scope_bindings`）に、作者の本文全体の宣言を表す component を、nullable の2列（宣言の canonical JSON と、その token）として足す。これを Scene Scope v2 と呼ぶ。v1 の binding、reader、token の計算、A1 の保存の payload は変えない。宣言、取消、クリアの書込みが変えるのは宣言の2列だけで、行のほかの列（incarnation、marker、A1 の JSON、principal、version、source token、`updated_at`。X1/1 の Q1 で設計 A が選ばれたときに X1 が足す列を含む）は byte 同一のまま残す。v1 の version と token を進めず、`updated_at` も書き換えない（`updated_at` は v1 の token の入力で、`scope_extension_digest` の入力にも入る。C15）。このため、宣言の書込みは `scope_extension_digest` の入力を変えない。宣言の変化は、A1 とは別の object kind の feed event で知らせ、project の Scope authority の変更として扱わない。その kind の event だけの feed の transaction は、Chronicle と Graph の Index を dirty にしない（今のコードは kind を問わず dirty にするので、この差分で外す。C17）。宣言の token は、宣言の値と、宣言の時点の v1 の token、incarnation、本文の Source、title の digest、workspace の束縛に結び付ける。どれかが変われば不一致で失効する（どの編集で何が変わるかは「失効」と「X1 への依存」）。restore と Safe Mode からの restore は宣言を消す。非 NULL にできるのは、Main の確認を消費した宣言の writer だけ。取消は確認を要さない。schema の版は merge 時に integrator が採番する（既定は v43。`14fd3cfc` の schema は 42。X1/1 の設計 A が先に merge されれば、その次の版）。既存の行は NULL のままにし、backfill しない。第二の table、Source kind、Freshness consumer、本文や excerpt や proof の保存、pending marker は作らない。X1/1 の差分（Scope 世代を進める writer の範囲、本文 Source の token の単調な変化、Scene Scope 投影）とは互いを前提にせず、どちらの順で確認されても合わさる（「確認の扱い」）。詳細は下の「保存先」「writer」「失効」。
- Trusted actors: Native の Scene Scope の writer（A1 の保存、source token の refresh、宣言と取消の writer、restore のクリア）。migration と schema の contract。既存の project Scope authority と lifecycle。
- Untrusted actors: renderer の payload（A1 の保存に宣言の欄を足すこと、宣言の ID や時刻を渡すことを含む）、generic SQL、MCP、renderer の Drizzle。restore、backup、複写で入ってくる DB の中身。宣言の writer を呼べる位置にある、Electron の Native 以外の code（MCP の tool など）。
- In-scope attacks: 許可のない writer による宣言の書込み（generic SQL、MCP、A1 の保存、宣言の writer 以外の Native writer）。restore、複製、ID の再利用での宣言の持ち越し。片方の列だけの状態、未知の版、未知の欄。migration による既存の行の昇格や backfill。宣言の変更が feed に残らないこと。同じ request の再送で宣言が二重にできること。取消と再宣言で同じ token に戻ること（ABA。renderer が前の宣言の ID と時刻を送り直すことを含む）。宣言を変えるたびに v1 の token を進めて、無関係な Revision の A3 を stale にすること（C8）。宣言の書込みで行の `updated_at` などの v1 の列を書き換え、v1 の token の照合を壊すこと（C15）。A1 と同じ kind の feed event で宣言を知らせて、Revision の pending 判定や Scope authority の freshness を巻き込むこと（C11）。宣言の feed event で Index（B の Graph index、Chronicle の IR の Index）の Freshness を dirty にし、Graph や IR を unavailable にすること。v1 の意味や token の計算の無断の変更。
- Out-of-scope attacks: `nir1-l6-l9-contract-proposal/3` と同じ（OS、backend、admin の侵害、作者の secret privilege、Raw search の再設計、外部送信）。加えて、app の外での DB の直接編集と、宣言の内容の真偽。
- Mandatory defenses:
  - 2列はどちらも NULL（宣言なし）か、どちらも非 NULL（宣言あり）。片方だけなら reader は unavailable にし、writer は宣言か取消で上書きする。
  - migration は非昇格にする。既存の行は NULL のままで、何からも宣言を作らない。片方の列だけが入った状態を修復でき、失敗したら rollback して再試行できる。この migration より前の版の backup を restore できる。
  - 非 NULL にできるのは宣言の writer だけ（Main の確認を消費したもの）。取消の writer と、restore と Safe Mode のクリアは NULL にするだけ。ほかの Native writer は2列に触れない。table の保護（C5）を保ち、renderer の Drizzle と generic SQL から書けないことを、schema の contract（Rust だけが書く列）でも固定する。宣言の writer は Electron の Native からだけ呼べるようにし（例: feature gate）、MCP の tool や generic な writer の経路から呼ばないことを試験で固定する。
  - 宣言、取消、クリアは、宣言の状態、feed（change event と narrative change feed）、idempotency の記録を同じ transaction で書く。
  - 宣言、取消、クリアのための書込みは、行の宣言の2列だけを書く（例: `UPDATE narrative_scene_scope_bindings SET <宣言の列> = ?, <token の列> = ? WHERE project_id = ? AND scene_id = ?`）。行のほかの列（X1/1 の Q1 で設計 A が選ばれたときに X1 が足す列を含む）、特に `updated_at` は byte 同一のまま残す。ほかに書いてよいのは feed と idempotency の記録だけで、`tree_nodes`（version と `updated_at`）、registry、ほかの Scene の行は書かない（書けば、本文の Source の token か、v1 の token と project の Scope authority の digest が進む。C8、C15）。既存の writer はどれも行を書き換えるときに `updated_at` も書き換えるが（C15）、宣言の writer はこの慣例に倣わない。宣言の時刻は宣言の JSON の中にだけ置く。本文版の restore（X1-2 の前は、同じ transaction で既存の refresh が v1 の列を進め、X1-2 の後は進めない）と project snapshot の restore（本文を含む scope では binding の行を作り直す。X1/1 の F19）のように、同じ transaction の中で既存の規則が v1 の列を扱う経路では、v1 の列はその既存の規則のままにし、クリアのための書込みは宣言の2列だけを NULL にする。backup の restore（staged DB）のクリアも、2列だけを NULL にし、v1 の列を書き換えない（token を計算し直さずに書き換えると、その DB の各 Scene で v1 の token の照合が外れる）。CB-1 か CB-2 で v1 の列のどれかを書き換える必要が生じたら、`[precheck]` で止め、新しい draftRef で起案する。
  - feed の event は、`scene-scope` と `scope-registry` のどちらとも別の object kind（名前は U3。例: `scene-body-declaration`。key は Scene ID）にし、structural impact に `scopeAuthorityChanged` を入れない。A1 の writer の feed event（`scene_scope_feed_event`）は流用しない（C11）。
  - この kind を feed の閉じた集合に登録する（event の検証、project の照合、canonical snapshot、Source の対応付け）。Source の対応付けでは、Source を持たない kind として扱う。`event_changes_project_scope_authority` と `affected_source_identities` は、この kind の event を Scope authority の変更にも Source の変更にも数えない。change kind は閉じた集合の値にし、`unknown` にしない。この kind の event だけで、Revision の pending 判定が `PendingUnknown`、`PendingRelevantChange`、`PendingGlobalChange` にならないこと。Index（B の Graph index と Chronicle の IR の Index）も dirty にならず、B の sealed binding は current のままであること。今のコードは、feed の transaction の最後に kind を問わず Index を dirty にする（`append_narrative_change_transaction_in_tx` の `suspend_project_in_tx`。C17）ので、transaction の event がすべてこの kind のときだけ、その呼出しを行わないように変える。ほかの kind の event を含む transaction（restore のクリアを含む restore の transaction など）は、今どおり dirty にする。この除外は、Index の入力でないこの kind だけに当て、ほかの kind に広げない（広げるなら新しい draftRef。X1/1 の X1-5〔Q6〕は別の変更で、互いを前提にしない）。X1-3 が feed の routing を identity で絞った後も、この kind は Source を持たない既知の kind として分類し、投影の identity に写さない（「X1 への依存」の XK-5）。
  - feed の before／after の digest は、この kind 用の snapshot（その Scene の宣言の2列。どちらも NULL なら宣言なしを表す固定の値）から計算し、宣言の変化を feed で見落とさない。`scene-scope` の kind の snapshot（`canonical_scene_scope_snapshot`。v1 の DTO）は変えない。
  - OCC は、v1 の version と token と、宣言の現在の token（または NULL）の組で行う（v1 の token を入れる理由は「Main の一回限りの確認」の「X1 と grant の束縛」）。v1 の列（version、token、`updated_at`）は書き換えない。宣言に依存するのは Graph-only の開示だけで、それは返却時と click 時に宣言を読み直す。Revision、Index、履歴は宣言に依存しないので、宣言の変更で失効させず、pending にもしない（v1 の側は C8、feed の側は上の kind の分離で守る。C11）。
  - v1 の binding（`narrative-scene-scope/1`）、reader、token の計算、A1 の保存の payload（`deny_unknown_fields`）は変えない。宣言の書込みは `scope_extension_digest` の入力（registry の行と、各 binding の version、source token、updated_at。`narrative_extraction/scene_scope.rs:725-753`）を変えない（X1-1 は、この digest から tree の世代の引数を外した。C8）。
  - 宣言の JSON は閉じた型（未知の欄を拒否）で、版付きの識別子と、宣言ごとの ID と、宣言の時刻を持つ。宣言の ID と時刻は、宣言の writer が write transaction の中で生成する（ID は OS の CSPRNG による UUIDv4、時刻は Native の時計）。renderer、preload、Main から受け取らず、宣言の入口の payload はこれらの欄を持たない閉じた型にする（あれば拒否する）。同じ request の再送は idempotency の記録を返すだけで、新しい ID を作らない。このため、取消と再宣言で同じ token に戻らない（UUIDv4 の衝突は無視する）。時刻は表示と記録にだけ使い、順序や認可の判定に使わない。
  - 本文、excerpt、path の proof、grant、判定の結果を保存しない。canonical locator は digest で保存し、path の文字列は保存しない。
  - restore と Safe Mode からの restore は、Ready の前に宣言を消す（下の「失効」）。
- Acceptance implications:
  - Positive: 現行の版（`14fd3cfc` では 42）から次の版への migration で、既存の行は NULL のまま。片方の列の修復と、失敗時の rollback と再試行ができる。宣言は、閉じて開き直した後も残る。宣言と取消では、feed と idempotency の記録が同じ transaction に入り、v1 の version、token、project の Scope authority の revision は変わらない（既存の Revision の A3 は stale にならない）。宣言と取消、backup の restore のクリアの前後で、対象の行の宣言の2列以外の列と、対象の Scene の `tree_nodes` の version と `updated_at` を byte で比べて同一である（version と token だけの比較にせず、`updated_at` を含める。本文版と project snapshot の restore では、既存の規則が同じ transaction で v1 の列を進めるか binding を作り直すので、この比較の対象にしない）。宣言と取消の後に、宣言した Scene について A1 の reader、A1 の保存、本文の保存、rename、project の registry の変更が成功し（`NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID` にならない）、`scope_extension_digest` の値は宣言の前と同じで、その行は `unavailable` の項目にならない。この試験は、宣言の writer に `updated_at` だけを書き換える変異を入れると失敗する（試験がその変化を検出できることを確かめる）。backup の restore の後も、その DB の各 Scene で v1 の token の照合が通る。取消の後に同じ値で再宣言すると、本文と束縛が同じでも宣言の ID が変わり、token が前の宣言と違う。宣言と取消の後も、既存の Revision の pending 判定は `Ok` のままで、project の Scope authority の identity は freshness で dirty にならない。B の sealed binding と Chronicle の IR の Index も current のままで、Index の metadata に dirty が立たず、宣言の後に Graph と IR が unavailable にならない（setup の addendum で、宣言の時期を B の seal の後にできる根拠。C17）。同じ試験で、ほかの kind の event を含む transaction では今どおり dirty が立つことも確かめる（除外が広がっていないこと）。feed に入るのは新しい kind の event で、`scene-scope` の kind の event は入らない。この migration より前の版の backup を restore できる。
  - Negative: generic SQL、MCP、renderer の Drizzle、A1 の保存（宣言の欄を足した payload）による書込みを拒否する。A1 の保存はダイアログを起こさず（`GRANT_REQUIRED_COMMANDS` に載らない）、宣言の欄を足した A1 の payload は `deny_unknown_fields` で拒否する。宣言の ID か時刻を含む宣言の payload を拒否する（renderer は ID と時刻を選べない）。片方の列だけ、未知の版、未知の欄は unavailable になる。restore、Safe Mode からの restore の後に宣言が残らない（同じ bytes に戻した場合も）。複製、削除と同じ ID での再作成、ごみ箱からの復元で宣言が戻らない。取消の undo で宣言が戻らない。同じ request の再送で宣言が二重にならない。
  - Recovery: 書込みの失敗で部分的な状態を残さない。COMMIT の結果が分からないときは `graph-target-scene-body-disclosure` の行のとおり quarantine し、再起動の後は DB の状態で判定する。restore の後は、作者が改めて宣言する。
  - Lane unlocked if confirmed: CB-1（schema、migration、クリア）。CB-2〜4 は `graph-target-scene-body-disclosure` の行の確認も要る。
- 受入れへの影響（l6-l9:762）:
  - 保存範囲: Scene ごとの行に、作者の宣言と束縛の digest を足す。本文や excerpt は保存しない。データの種類は増える（作者の宣言）が、送信先は増えない。
  - schema: 版が1つ上がる（既定 v43。`14fd3cfc` の schema は 42。X1/1 の設計 A が先に merge されれば、その次の版）。schema の contract、版の assert、restore の扱い、protected writers を同じ PR で更新する（計画の merge 列の規則）。
  - 既存のデータ: 既存の行はすべて「宣言なし」になる。v1 の行の意味と、legacy-absent、unknown、explicit の扱いは変えない。
  - 失効の範囲: 宣言の操作は行の v1 の列（token と `updated_at` を含む）を書き換えず、feed も A1 とは別の kind で書き、その kind の event だけの transaction は Index を dirty にしないので、宣言のために既存の Revision、Index、履歴が失効することも、pending になることもない。逆に、Scope に効く編集と registry の変更は v1 を進めて宣言を失効させ、本文と title の更新は本文 Source の token と title の digest で宣言を失効させる（X1-2 の前は、本文と title の更新も v1 を進める。「X1 への依存」の XK-1、XK-2）。
  - 変えないもの: `nir1-l6-l9-contract-proposal/3` の他の条項、A1 の UI と IPC の v1 の payload。

### 変更前後

| 項目 | l6-l9 の proposal/3（確認済み） | C-body の proposal/4（この draft） |
| ---- | ---------------------- | ---------- |
| Scene ごとの binding | A1 の軸、incarnation、marker、principal、version、source token | v1 はそのまま。宣言の component を nullable の2列で足す |
| v1 の version と token | 設定の変更と、Scope に効く編集で進む（X1-2 の前の実装は、本文の保存と Scene の patch でも進める。C2） | 同じ。宣言、取消、クリアでは進めず、行の v1 の列（`updated_at` を含む）を書き換えない |
| feed | A1 と registry の変更は `scene-scope` と `scope-registry` の kind で書き、project の Scope authority の変更として扱う | 同じ。加えて、宣言、取消、クリアは別の kind で書き、Scope authority の変更として扱わず、その kind の event だけの transaction は Index を dirty にしない（C17） |
| schema の版 | 41（`14fd3cfc` では 42。CR-1 が上げた） | 1つ上げる（既定 43） |
| writer | A1 の保存、source token の refresh、restore 系 | 加えて、宣言（Main の確認）、取消、restore のクリア |
| 失効 | 設定と本文の変更で token を進め、旧資格を失効させる | 加えて、宣言は束縛の不一致（X1-2 の後の本文と title は、本文 Source の token と title の digest）で失効し、restore で消える |
| 保存しないもの | 本文、full closure | 加えて、excerpt、path の proof、grant、判定の結果、path の文字列 |

### 保存先

- table: 既存の `narrative_scene_scope_bindings`（`migrate.rs:4074-4101`）。Scene ごとに1行で、Scene の削除で行ごと消える（`scene_id` の `ON DELETE CASCADE`。:4077-4078。本文を含む project snapshot の restore でも行ごと作り直される。X1/1 の F19）。
- 列: nullable の2列。宣言の canonical JSON と、その token。列の名前と符号化は CB-1 で決める。
- 宣言の JSON に入れるもの:
  - 版付きの識別子（案: `narrative-scene-body-declaration/1`）。宣言ごとの ID（UUIDv4）と、宣言の時刻。どちらも宣言の writer が transaction の中で生成し、renderer、preload、Main の値を使わない（上の Mandatory defenses、下の「writer」の手順 5）。
  - 宣言の値（上の「宣言の値」の表）と、対象（本文の全体と title）。
  - 束縛: project ID、Scene ID、Scene の incarnation、宣言の時点の v1 の token、本文の Source（`project:scene:<id>`、`v{version}@{updated_at}`、storage digest、canonical digest、正規化の版、UTF-16 長）、title の digest、workspace ID、canonical locator の digest。
- token: 宣言の JSON の canonical な形から、ドメイン分離した SHA-256 で計算する。
- 置かないもの: 本文、excerpt、title の文字列、path の proof、grant、判定の結果、path の文字列、宣言の途中を表す marker。第二の table、Source kind、Freshness consumer。

### writer

- 入口: A1 の保存とは別の typed な入口を2つ（宣言と取消）置く。Main が command の名前だけで確認の要否を決められるようにする（DSN §7.2 の `GRANT_REQUIRED_COMMANDS`）。`GRANT_REQUIRED_COMMANDS` に載せるのは宣言の入口（種類 `BodyDeclaration`）だけで、取消の入口（grant を要さない。下の「取消の入口と grant」）と A1 の保存（`narrative_scene_scope_update`）は載せない。A1 の保存の payload には宣言の欄を足さない。DSN §7.3 は、`BodyDeclaration` を消費する writer を、K2 の確認の後に `narrative_scene_scope_update` の本文宣言の分岐から K2 が置く本文の宣言の入口に改める予定とし、A1 の保存は grant を要さず、`GRANT_REQUIRED_COMMANDS` を K2 の確認を待って作る、としている。この draft はその形をとる（A1 の保存はダイアログを起こさず、宣言の欄を足した A1 の payload は拒否する）。新しい入口は、K3/2 の「restricted 下の route 区分」の「区分の構成」の表の「宣言 UI（本文の宣言と取消）」の行のとおり `internal` に分類される。その行は、本文の宣言の入口は K2 の Main grant（`BodyDeclaration`）を要し、取消の入口に grant が要るかは K2 の確認に従うとし、restricted では Native の入口で登録済み caller と workspace も確かめるとする（K3 の /1 の同じ行は2つの入口をまとめて grant を要するとしていたが、K3/2 で改められた）。この draft は、取消の入口に grant を要さないと決める（下の「取消の入口と grant」）。Native の入口の検査は mode で違う。restricted では、登録済みの caller と workspace を確かめる（同じ行の restricted の列）。unrestricted には登録済みの caller が存在しない（Native の caller の登録は、restricted かつ停止確認済みのときだけ受け付ける。`electron/native/grimodex-node/src/profile_egress.rs:251-256`）ので、caller の登録は求めず、workspace の束縛だけを確かめる（同じ行の unrestricted の列は caller の確認を置かない。宣言の入口では、preview と writer が grant の binding で workspace を確かめる。取消の入口では、Native の入口が、workspace が Ready であることと、要求の project と Scene がその workspace の DB にあることを確かめる）。入口は両方の mode で動く。評価で (i) を選ぶと宣言は setup の起動で、(ii) を選ぶと測定の起動で行い、Graph は restricted でだけ出る（K3/2 の「区分の構成」の「Related Scenes の Graph」の行）ので、起動ごとに mode が違いうる。入口の名前は CB-2 が決め、Main の route 台帳（`electron/main/profileEgress.ts` の `INTERNAL_COMMANDS`。:155-385）に加える。PUB-G までは、宣言と取消の入口を gate（`graph-target-scene-body-disclosure` の Mandatory defense 10）で閉じる。gate が閉じていれば、Main はダイアログを出さず、Native の preview、宣言の writer、取消の writer は DB を読む前に typed に拒否する（DSN §7.2 の、公開の前に gate を開ける N-API の段落と同じ形）。
- 宣言の手順:
  1. Main が sender と window を確かめ、Native の preview を呼ぶ。preview は現在の状態を読み（本文の読取は K1b の上限の内）、grant の binding を Native の中に保持する。要求の値が v1 の subset でない、veto（secret の foreshadow、secret な Chronicle event、POV の記録）に当たる、A1 が explicit でない、Scene が archive されている、本文が空か上限を超える、canonical locator を求められない場合は、preview を作らない。
  2. ダイアログで承認されたら grant を発行する。
  3. writer は、transaction を開く前に grant を消費する。失敗しても戻さない。
  4. 有限の待機（K1b）で、ほかの writer と直列になる write transaction（`BEGIN IMMEDIATE` 相当）を開き、grant の binding と現在の状態を照合する。本文の digest は transaction の中で計算し直す。照合するもの: OCC（v1 の version と token、宣言の token）、incarnation、本文の Source（token と digest）、title の digest、宣言の値の digest、A1 が explicit で解決済みであること、veto、workspace の束縛、lifecycle の revision。一致しなければ拒否する。
  5. 宣言の ID（OS の CSPRNG による UUIDv4）と時刻（Native の時計）を生成して宣言の JSON を組み、token を計算する。宣言の2列、feed（A1 とは別の object kind。上の Mandatory defenses）、idempotency の記録を書き、COMMIT する。行の v1 の列（`updated_at` を含む）は書かない。participant は COMMIT の終端まで保持する。lifecycle の edge と COMMIT の順序を固定する方法は CB-2 で決める（下の「委任で決めること」）。
  6. 終端の証拠（COMMIT の成功、rollback の完了、結果不明からの quarantine）で後始末する。終端の証拠は writer の commit の経路の外では作れない型にする。結果が分からないときは、`graph-target-scene-body-disclosure` の「COMMIT の結果が分からないとき」のとおりに扱う。
- 取消: grant は要さない（下の「取消の入口と grant」）。取消の要求は取り消す宣言の token を指定し、現在の token と一致するときだけ（OCC）、宣言の2列を NULL にする。feed と idempotency の記録を同じ transaction で書き、行の v1 の列は書かない。宣言がないとき（2列とも NULL）と、指定した token が現在の token と違うときは、何も書かず（feed も idempotency の記録も書かない）、閉じた集合の code（「宣言がない」か「宣言が変わった」）で返す。応答と event には、閉じた集合の code だけを置き、Graph の到達、候補の有無、veto の種別を含めない。取消の undo で宣言を戻さない。戻すには新しい確認を要する。
- 待機: 期限なしの DB mutex の待ち（`db.with_conn`、C5）を使わない。上限は K1b に従い、超えたら typed に失敗する。grant は戻さない。
- 再試行: Main も writer も暗黙に再試行しない。同じ request の再送には idempotency の記録を返す。

#### 取消の入口と grant

K3/2 の行が K2 の確認に委ねた点（取消の入口に grant を要するか）を、この draft で決める。前提は次のとおり。取消は宣言の2列を NULL にするだけで、開示を止める向きの操作である。renderer は、grant なしに、宣言を失効させるか veto に当てる既存の入口（本文の保存、Scene の patch、A1 の保存、registry の変更、伏線の作成と更新、Chronicle の一括操作）を restricted でも呼べる（C18）。

| 観点 | 取消に grant を要さない（推奨） | 取消にも grant を要する |
| ---- | ------------------------------- | ----------------------- |
| 乗っ取られた画面ができること | 宣言を取り消し、その Scene の Graph-only の追加を止める（可用性）。同じ結果は、grant のない既存の入口（同じ本文での再保存、title の patch、A1 の保存、registry の変更、secret の伏線の設定）でも起こせる（C18） | 取消の入口からは止められない。しかし上の既存の入口で同じ結果を起こせるので、乗っ取られた画面に対して防げる範囲は増えない |
| 開示への影響 | 開示を止める向きだけ。新しい出口も、宣言を増やす経路も作らない（非 NULL にできるのは、Main の確認を消費した宣言の writer だけ） | 同じ |
| 情報の漏れ | 応答は閉じた集合の code（取り消した、宣言がない、gate が閉じている、quarantine、caller や workspace の不一致など）。宣言の有無は、作者が開いた Scene について CB-3 の読取でも renderer に見えるので、漏れる範囲は増えない。Graph の到達や候補の有無とは結び付かない（Mandatory defense 9 の対象外の項目） | 同じ |
| 進行中の宣言との競合 | 宣言のダイアログの間に取消があると、宣言の token（OCC）が変わり、grant は writer で不一致になって拒否される。作者は確認からやり直す（害はやり直しの手間） | ダイアログは process 全体で同時に1件なので、取消のダイアログと宣言のダイアログは同時に開かない（2件目は `MAIN_GRANT_BUSY`） |
| 書込みの量 | 宣言がないときの取消は何も書かない。宣言があるときは、宣言の2列と、feed と idempotency の記録だけで、その kind の event だけの transaction なので Index を dirty にしない（C17） | 同じ |
| 害の大きさ | 作者が改めて宣言する手間（Scene ごとに Main のダイアログ）と、気付くまで Graph-only の追加が出ないこと。作者は CB-3 の UI で宣言の状態（草案、宣言済み、現在有効）を見て気付ける。評価は取消を使わず、PUB-G の前は gate で閉じている | 同じ害が既存の入口から起こりうる |
| 利用者の負担 | 1 操作で取り消せる。宣言の後に本文の秘密などに気付いたとき、開示をすぐ止められる | 取消のたびに Main のダイアログ（60 秒、同時に1件）を通す。開示を止める向きの操作に手間が加わり、急いで止めたいときに遅れる |
| 日数（推定。実測に辿れる値はない） | 追加なし。CB-2 の見積り（D+11〜13）のまま | CB-2 に +1〜2 日（取消の grant の種類と binding の設計、ダイアログの文面、評価用の CI seam の承認の範囲、試験の追加。DSN の改訂は DSN の担当で、この日数に含めない）。CB-2 は PUB-G の鎖の上にあるので、CB-4 の merge 以降が同じだけ後ろにずれうる。PUB-G の目安は D+20〜25 から D+21〜27 になりうる。PUB-L の目安（D+30〜35）より前なので、E の目安（D+35〜40）は動かない見込み（「E に効くか」と同じ理由）。「Option 別の日数」の Option B の日付に加える |
| 実装と DSN | grant の種類は `BodyDeclaration` だけで、`GRANT_REQUIRED_COMMANDS` は宣言の入口の1つ。DSN §7.2 の台帳と §7.3 の `BodyDeclaration` の行（消費する writer は本文の宣言の入口）のまま | 取消の grant（`BodyDeclaration` を流用するか、新しい種類）と、その binding、ダイアログの文面、DSN §7.2〜§7.3 の改訂、評価用の CI seam の承認の範囲の見直しが要る |

推奨は、取消に grant を要さないことである。grant を要しても、乗っ取られた画面が Graph-only の開示を止めることは既存の入口で防げないので、安全は増えない。一方で、開示を止める向きの操作に、利用者の手間と遅れが加わる。取消の入口が守るべきなのは、gate（PUB-G の前は閉じる）、restricted での caller と workspace の確認、閉じた集合の応答、undo と再送で宣言を戻さないこと、宣言がないときに何も書かないことで、これらは grant によらず置く（上の「取消」と、`graph-target-scene-body-disclosure` の In-scope attacks の「取消の入口の悪用」）。この決定は、DSN §7.2（`GRANT_REQUIRED_COMMANDS` は command から種類への exact な台帳で、K2 の確認を待って作る）と §7.3（`BodyDeclaration` を消費するのは本文の宣言の入口で、A1 の保存は grant を要さない）と食い違わない。DSN の公開の前の gate の段落は、宣言の入口と同じく取消の writer も gate で閉じるとしており、この draft の Mandatory defense 10 と同じである。取消にも grant を要する案を選ぶ場合の日数は、上の表の「日数（推定。実測に辿れる値はない）」の行のとおりである。

### 失効

失効には2つの仕組みを使う。

- 不一致による失効: 宣言の束縛（incarnation、v1 の token、本文 Source の token と digest、title の digest、workspace ID、canonical locator の digest）のどれかが現在と違えば、reader と UI は失効として扱う。ほかの writer は宣言を消さなくてよい。
  - 本文と title の変更による不一致は戻らない。X1-2 の前（今の master）は、Scene の行を書くどの writer も同じ transaction で v1 の version を進める（C2）ので、v1 の token の不一致が残る。X1-2 の後は、本文と title の更新は v1 を進めない。宣言の失効は本文 Source の token と title の digest による。本文 Source の token は、同じ restore epoch の中では、`version` を進める writer では `version` で、進めない writer（`tree_node_patch` の `bumpVersion=false` の patch と、Chronicle の一括操作の forward と undo）では `updated_at` の時刻としての厳密な前進で、以前の値に戻らない（X1/1 の Delta の 1）。このため、title を A→B→A に戻し `updatedAt` も前の値に戻しても、割り込み（`tree_node_patch`〔未来の `updatedAt`〕→ Chronicle の一括操作 → `tree_node_patch`〔同じ `updatedAt`〕）を挟んでも、宣言は再び一致しない。この保証は restore を跨がない（project snapshot の restore では、本文 Source の token が snapshot の時点の値に戻りうる）が、restore は宣言を消す（下の明示的なクリア）ので、宣言には響かない。表示 metadata（synopsis、status、label、Chronicle の日時など）の変更でも本文 Source の token が進むので、宣言は失効する（X1 の前後で同じ）。X1/1 がこの保証を外した形で確認された場合の扱いは「X1 への依存」の XK-1。
  - Scope に効く編集（A1 の設定、registry、Codex の人物の restore による A1 の無効化、Scene の移動、並べ替え、storyTimeOrder、archive、POV、生きた Scene を含む祖先 folder の構造の変更）による不一致も戻らない。v1 の token は version を含み（grimodex-core `narrative_scene_scope.rs:176-199`）、version は同じ incarnation と restore epoch の中では減らない。章（folder）の構造の変更は X1-1 で配下の Scene の v1 を進めるので、章を元の位置に戻しても、配下の宣言は戻らない。
  - incarnation の不一致（削除と同じ ID での作り直し、複製、import、ごみ箱からの復元、project snapshot の本文の restore）は戻らない（新しい incarnation は UUIDv4）。
  - workspace の束縛（workspace ID と canonical locator）による不一致は戻りうる。folder を元の path へ戻すなどして両方が元の値に戻れば、同じ bytes に対する同じ作者の宣言が再び有効になる。これは許容する（K4/3 の §7 の「元の path に戻した場合」と同じ規則）。判定は、次に Ready になったときの locator で行う（上の「canonical locator」）。
- 明示的なクリア: restore と Safe Mode からの restore は、宣言を NULL にする。DB 全体や本文を過去の状態に戻す経路では、宣言と、宣言が束縛する値が一緒に戻りうるので、不一致だけに頼らない。

| 経路 | 例（コード。`14fd3cfc`） | 宣言への作用（X1-2 の前。今の master） | 宣言への作用（X1-2 の後） |
| ---- | ------------------------ | -------------------------------------- | ------------------------- |
| 本文の保存（エディタへの AI 出力の適用を含む） | `save_scene_body_bundle`（`scene_body.rs:342`。refresh は :801-807） | v1 の token と本文 Source の token が変わり、失効する。同じ文字列での再保存も失効させる | v1 は進まない。本文 Source の token（`version`）が変わり、失効する。同じ文字列での再保存も失効させる |
| title と表示 metadata の patch | `tree_node_patch_with_authority`（`domain_writes.rs:3531`。refresh は :3852-3863） | v1 の token と本文 Source の token が変わり、失効する（title を変えた場合は title の digest も変わる） | v1 は進まない。本文 Source の token（`bumpVersion=true` なら `version`、`false` なら `updated_at` の厳密な前進）と、title を変えた場合は title の digest で失効する。title を A→B→A に戻しても再び一致しない |
| Scene の移動、並べ替え、storyTimeOrder、archive、POV の patch | 同上 | v1 の token と本文 Source の token が変わり、失効する | v1 の token（Scope に効く変更）と本文 Source の token が変わり、失効する |
| AI Apply | `apply_ai_tree_plan`、`undo_ai_tree_plan`（`domain_writes.rs:5264`、:5807。Scene の refresh は :5570、:5955） | v1 の token と本文 Source の token が変わり、失効する | Scope に効く更新（parentId、sortOrder、archivedAt）のときは v1 も進む。題名だけの更新では v1 は進まず、title の digest と本文 Source の token で失効する |
| Codex の rename の波及 | `apply_codex_rename_updates_in_tx`（`domain_writes.rs:746`。title と synopsis の書込みは :842-862、refresh は :1049-1059） | v1 の token と本文 Source の token が変わり、失効する | v1 は進まない。本文 Source の token（`version`）と、title を変えた場合は title の digest で失効する |
| bulk、物語時間と Chronicle の日時の操作 | `chronicle_bulk.rs:911`（refresh は :952）、`narrative_extraction/temporal_operations.rs:132`、:210、:496、:623、:690（refresh は :199、:268、:575、:679、:733） | v1 の token と本文 Source の token が変わり、失効する | storyTimeOrder か POV が実際に変わったときは v1 も進む。日時だけの変更では v1 は進まず、本文 Source の token（`version`、Chronicle の一括操作では `updated_at` の厳密な前進）で失効する |
| 生きた Scene を含む祖先 folder の移動、並べ替え、親の変更、archive とその戻し | `tree_node_patch_with_authority` の folder の分岐（`domain_writes.rs:3934-3955`）、AI tree plan（:5641、:6005）。X1-1（#662）で足された | 配下の生きた Scene（変更の前と後の和集合）の v1 が進み、それらの宣言がすべて失効する。戻しても戻らない | 同じ |
| A1 の設定 | `update_narrative_scene_scope`（`narrative_extraction/scene_scope.rs:1187`） | v1 の token が変わり、失効する | 同じ |
| registry の変更 | `update_narrative_scene_scope_registry`（:1366。project のすべての binding を列挙し〔:1410-1426〕、version と token を進める〔:1454-1477〕） | timeline、worldline、layer を1つ足すだけでも、project 内の宣言がすべて失効する | 同じ（X1/1 の Q2 を推奨のまま確認した場合。対案の場合は「X1 への依存」の XK-3） |
| Codex の人物の restore による A1 の無効化 | `invalidate_character_references_with_events_in_tx`（:1067。呼出し元 `agent_writes.rs:2750-2756`） | その人物を holder か audience に持つ Scene の v1 が進み、失効する | 同じ。undo journal の経路は X1-2 が扱う（X1/1 の Delta の 1 の (c)） |
| 本文版の restore | `revision_restore.rs:246-276` | 同じ transaction で宣言を NULL にする（同じ bytes に戻す場合も）。既存の refresh が v1 も進める | 同じ transaction で宣言を NULL にする。v1 は進まない |
| project snapshot の restore | `project_snapshots.rs:2791-2797`（本文の scope で `tree_nodes` を消す）、:2931-2963 | 同じ transaction で、scope によらず project の宣言を NULL にする。本文を含む scope では binding の行が外部キーで消えて作り直される（新しい incarnation。X1/1 の F19）ので、宣言は行ごと消える | 同じ |
| backup の restore、Safe Mode からの restore | `backup_restore.rs:533`（staged DB の install）、:111 | staged DB の宣言の2列だけを NULL にしてから install し（このクリアは v1 の列を書き換えない）、Ready にする。この migration より前の版の backup も restore できる | 同じ |
| 複製 | 新しい Scene の作成 | 新しい行になり、宣言を写さない。新しい incarnation（l6-l9:616） | 同じ |
| 削除、ID の再利用 | `tree_node_delete_with_authority`（`domain_writes.rs:3307`）、外部キーの CASCADE（`migrate.rs:4077-4078`） | 行ごと消える。再利用した ID は新しい incarnation になる | 同じ |
| ごみ箱からの復元 | `trash_bin.rs:783` | 宣言は戻らない（削除で行が消えている） | 同じ |
| 別の workspace | folder の複写、移動、別の path での open | canonical locator の digest が変わり、失効する。symlink 経由の open では変わらない。元の path（同じ workspace ID）へ戻せば再び一致する | 同じ |
| workspace ID の変更 | `.grimodex/workspace.json` の id の変更 | 失効する | 同じ |
| 宣言の取消 | 新しい取消の入口（grant を要さない） | 宣言の2列を NULL にする（v1 の列は書き換えない） | 同じ |
| veto の記録の追加（失効ではない） | secret の foreshadow か secret な Chronicle event を target に掛ける、既存の foreshadow や event を secret にする、Scene や beat の POV を設定する | 宣言の束縛は変わらなくても、reader が返却時と click 時に veto で拒否する。記録を外して束縛も一致していれば、同じ bytes の宣言は再び使える。POV は、宣言の時点にあれば writer が拒否し、宣言の後に設定すると、その書込み（Scene の patch、一括操作、本文の保存）が v1 か本文 Source の token を進めて宣言を失効させるので、POV を外しても宣言は戻らない | 同じ（X1-2 の後も、POV の変更は v1 を進める） |

Web Editor の handoff の取込みは考慮の対象外（SB-2）で、この表に行を置かない。経路ごとに失効の試験を置く（CB-4。addendum の G-01 の負例を含む）。title の A→B→A と割り込みの試験、章の構造の変更とその戻しの試験も置く。これらは、X1-2 の前は v1 の token で、後は本文 Source の token で通る。X1-2 と CB-4 のどちらが先に merge されても、後に入る PR がこれらの試験を通す（「X1 への依存」の XK-1、「確認後の記録」）。veto の記録を宣言の後に足す場合と外す場合の試験も置く。この表にない経路でも、本文、title、A1、incarnation、workspace のどれかが変われば、不一致で失効する。新しく本文や Scene を戻す経路を足すときは、明示的なクリアの要否をその PR で判定する。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId scope-storage-authority.`

## 選択肢と推奨

### Option B（推奨）: 作者が本文全体を宣言する

- 中身はこの draft の2行。Graph は、作者が宣言した Scene に限り、R+IR にない Scene を1件追加できる。
- 新しい信頼仮定は、作者の宣言を本文の分類として信じること。範囲は Related Scenes の表示と遷移に限られ、ほかの出口は開かない。
- 実装は CB-1〜4（schema 1、writer と MG-1、UI、reader と再検証）。CB-1 には、宣言の kind の event だけの feed の transaction を Index の dirty から外す変更（C17）と、その試験が加わる。
- 評価の setup の addendum は、G-01 に加えて、CP-0 が固定した G-02、G-07、G-08 の追加 Scene（計4つ）の宣言を固定する。観測前の commit（CP-4）に入れ、観測前に独立 review を受ける。critical path には載らない（0.5〜1 日、並行。推定）。「setup の addendum」。
- 可用性の代償: 本文、title、表示 metadata、A1 を変えるたび、宣言した Scene を含む章（folder）を組み替えるたび（X1-1）、registry を変えるたびに、作者が改めて宣言する必要がある（「可用性」）。

### Option A: fail-closed のまま、G-01 の評価を改訂する

- この draft の2文を出さない。Graph-only target の本文、title、locator は出さない。Graph の寄与は、R+IR の Scene に path の Evidence を付けることだけになり、共通追加1枠は Graph では使わない。
- 固定 v1 の G-01 の期待値（R+IR+Graph = `[g01-question, g01-mira]`、Recall@8 0→1、nDCG@8 約 0.6309）には届かず、G-01 は HOLD のまま残る。Graph の「R+IR に対する事前指定の改善 1 件以上」（l6-l9:707、post-B §7.3）を満たすには、評価の契約を改める必要がある（例: 改善の指標を、R+IR の Scene に付く qualified な path Evidence にする）。post-B §7.1 は、事後に Evidence の追加を検索の改善と読み替えることを禁じている。このためこれは解釈ではなく契約の変更で、`g01-eval-revision` の新しい draftRef として観測前に起案し、独立した期待値の review とユーザーの確認を得る（K6/2 の同じ行は、指標を変えない S1 の改訂だけを扱う）。
- CP-0（#639）が 2026-10-13 に固定した G-02、G-07、G-08（usable の状態）の期待値も、Graph-only の Scene の追加を含む。追加には C-body が要り、C-body が閉じている間は返らず、その case は Hold になる（`evals/nir1-graph/manifest.v1.json` の `dependencies`、`evals/nir1-graph/README.md` の「観測規則と失敗時の扱い」）。このため Option A の評価の改訂は G-01 だけでは済まず、固定済みのこの 3 件の fixture の改版（失敗を残した別の版の提案、独立した期待値の review、freeze のやり直し）も扱う必要がある。
- この改訂（`g01-eval-revision` の新しい draftRef と、G-02、G-07、G-08 の改版）は、まだ起案されていない。Session B2 で Option A が選ばれると、その後に起案、独立した期待値の review、確認の往復が要る。
- 製品では、Graph は R+IR が見つけた Scene に説明（path）を足すだけで、新しい Scene を見つけない。
- CB-1〜3 は不要になり、CB-4 は「Graph-only の枠が閉じていること」の試験に縮んで CP-3a に入る。MG-1 は DA-2（D2a の activation）で、durable workspace identity（workspace ID と canonical locator の digest の組。K4/3 の §7。DSN §7.3 の VerifiedWorkspaceBinding にあたる）は K4 で必要になるので、これらの作業は別のレーンへ移るだけで残る。

### 比較

| 観点 | Option B（推奨） | Option A |
| ---- | ---------------- | -------- |
| 製品の挙動 | 宣言した Scene を Graph が追加できる | Graph は path の Evidence を足すだけ |
| 新しい信頼仮定 | 作者の宣言 | なし |
| 保存と schema | nullable の2列（既定 v43） | なし |
| 確認 | この2文（Session B2） | `g01-eval-revision` の新しい draftRef（評価契約の改訂）と、G-02、G-07、G-08 の改版。まだ起案されていない |
| G-01、G-02、G-07、G-08 の追加 Scene | G-01 は固定 v1、G-02、G-07、G-08 は CP-0 の freeze 済みの fixture のまま、addendum の setup（4つの追加 Scene の宣言）で正例に届きうる（実測は CP-4。B-ROUTE〔#643〕による B の seal が前提。X1/1 が確認されれば X1-2 と X1-3 の後）。宣言の addendum がなければ、G-02、G-07、G-08 の追加 Scene は返らず Hold になる | 固定 v1 は HOLD。改訂した G-case で判定する。CP-0 が固定した G-02、G-07、G-08 の改版も要る（B-ROUTE による B の seal が前提なのも、X1 との関係も同じ） |
| NIR-1 の完了 | 固定の比較（G-01 と、CP-0 が固定した G-02〜G-08）で判定できる。追加 Scene の4つには宣言の addendum が要る | 改訂が確認されない限り、Graph の受入れは完了しない |
| PUB-G の目安（推定） | D+20〜25（Session B2 が D+3〜5 の場合。B2 が遅れればその日数だけ遅れる） | D+17〜22（改訂が B2 と同じ時期に確認された場合）。改訂の起案と確認が B2 の後になれば、+3〜5 日で、約3日の利得を打ち消すか上回る |
| E の目安（推定） | D+35〜40（計画の目安のまま。K5 の C による短縮は K5/3 が日数にしておらず、Session B で再見積りする） | 同じ。Option A が E を早めうるのは、Graph の鎖が local 送信の鎖より遅くなったときだけで、最大約3日（「critical path への影響」） |
| 主なリスク | 失効が多く可用性が低い（registry の変更で project の宣言がすべて失効し、章の組み替えでも配下の宣言が失効する）。Main の確認、lifecycle、3 OS の path、Index の dirty の除外の実装 | 改訂が否決されると Graph が完了しない。Graph の価値が下がる。改訂の起案が B2 の後になる |

推奨は Option B のままとする。`14fd3cfc` までに merge されたもののうち、X1-1 は Option B の可用性を下げる（章の組み替えで配下の宣言が失効する）が、宣言の安全には効かず、今の製品に宣言の実装はないので、利用者が今失うものはない。B-GUARD は、両 Option で、setup の B の seal を止める危険を下げる。X1/1（確認されれば CP-4 が X1-2 と X1-3 を待つ）と proposal/7（C の受入れ）は、両 Option に同じだけ効く。Option A が早めるのは PUB-G で、約3日（推定）にとどまり、Option A の評価の改訂はまだ起案されていないので、B2 の後の確認の往復でその利得は打ち消されうる。E に届くかは、「critical path への影響」のとおり、Graph の鎖が local 送信の鎖より遅くなるかで決まる。計画の目安では PUB-L が PUB-G（Option B）より中心で約10日、幅の端どうしでも約5日遅い。K5 の C は local 送信の鎖を短くするが、その幅は K5/3 が日数にしておらず、Session B で integrator が再見積りする。D2a の範囲増は両 Option に共通である（DA-2 の前提だけが違う。「Option 別の日数」の表）。このため、計画の目安の下では Option A でも E は早まらない見込みである。そのうえ Option A は、Graph の主な価値（R+IR が見つけない Scene の発見）を失い、否決されうる評価契約の改訂（CP-0 が固定した G-02、G-07、G-08 の改版を含む）に完了を預ける。Option B の新しい信頼仮定は、作者自身の端末で、作者が確認した Scene の表示にだけ働き、失効と veto は fail-closed に倒れる。Option B にも G-02、G-07、G-08 の宣言の addendum は要るが、観測前に固定する並行作業で、critical path に載らない。

### ほかに検討して採らない案

- 既存の記録（foreshadow、Chronicle event、phase、beat の POV、mention）から本文の分類を導く案: 記録が本文の全体を網羅している証明がなく、「記録がない」を「秘密がない」と読めない。
- worker が本文を読み、frame で運ぶ案: 原稿が子 process の pipe を通る新しい経路になり、frame の予算と C-resource の証跡が変わる。parent で exact に照合する方式（DSN §2.3、§2.5）に比べて利点がない。
- pin や Relation の Evidence を本文の開示の根拠にする案: pin は locator で、Relation が本文で成り立つ証拠ではない（候補 §2）。
- excerpt を出さず、title と遷移だけを出す案: title と遷移も Graph の結果としての開示で、同じ authority が要る。遷移すれば本文の全体が表示される。
- Scene ごとの「公開」の flag（本文に束縛しない）: 本文を変えても失効せず、宣言の後に書いた本文まで開示してしまう。
- veto を foreshadow と POV に限り、Chronicle event の秘匿を含めない案: secret な event の reveal の Scene と、event を結んだ Scene は、foreshadow の payoff と同じく、本文が秘密を含むか明かすことを示す記録である（C9）。含めないと、既知の記録と矛盾する `non-secret` の宣言で開示してしまう。含める代わりに、そうした Scene は v1 では宣言できない（可用性が下がる）。
- Graph-only の候補の不一致でも Graph の寄与を全体で 0 にする案（DSN §2.3 の (d) のまま）: 開示の安全性は変わらない（どちらも Graph-only の行を出さない）。しかし、R+IR の path の付加が消えることや Graph の全体の理由 code から、Graph-only の候補があったことを renderer が判別できる。K1 の C-body の fail-safe（「R+IR の結果はそのまま残る」）とも合わない。
- 評価用の CI seam が承認できる宣言を、addendum が固定した値（4つの Scene の canonical digest と title の digest、宣言の値）に限る案: packaged でない起動で env をそろえた者でも、fixture 以外の Scene は宣言できなくなる。しかし、その者は同じ権限で DB を直接書けるので、悪意のある者に対して守れる範囲は増えない。誤った起動で seam が有効になることは、owner token の env の照合で起こりにくくしてある。この案は Main に評価の fixture の値を持たせ、宣言が要る評価を足すたびに Main を変えることになる。v1 では採らず、残余を Out-of-scope に記録する。
- 宣言を v1 の token ではなく A1 の軸の値に束縛し、registry の変更や順序の操作（X1-1 の後は章の構造の変更を含む）では失効させない案: 失効は減るが、v1 の token（A1 の状態と registry を含む）とは別の束縛の規則を新しく作ることになり、どの変更が宣言に影響しないかを経路ごとに示す必要がある。v1 では採らず、registry の変更や章の組み替えで失効した宣言は UI で知らせて再宣言を促す（CB-3。下の「委任で決めること」）。
- 取消の入口にも grant を要する案: 乗っ取られた画面が Graph-only の開示を止めることは、grant のない既存の入口でも起こせる（C18）ので、安全は増えない。開示を止める向きの操作にダイアログの手間と遅れが加わり、grant の種類か binding と DSN §7.2〜§7.3 の改訂が要る（`scope-storage-authority` の「writer」の「取消の入口と grant」）。
- 宣言の feed の transaction を、今のコードのまま Index の dirty に含める案: 宣言、取消、クリアのたびに Chronicle と Graph の Index が次の publish まで unavailable になる（C17）。宣言の kind は Index の入力ではないので、dirty にしても安全は増えない。評価では、宣言を B の seal の前に置くか、宣言の後に B と IR を再 build する手順が要る。v1 では採らない。
- 宣言の変更を feed に書かず、Index の dirty を避ける案: 宣言の変化を feed の snapshot と head で追えなくなり（In-scope attacks の「宣言の変更が feed に残らないこと」）、CP-3 が表示中の行を feed で消す手段もなくなる。feed は書き、その kind の event だけの transaction の dirty だけを外す。

## critical path への影響

日数はすべて推定で、実測ではない。D は Wave 1 の開始日（2026-10-12）で、この版を起案した 2026-10-14 は D+2 である。基準は、計画の目安（PUB-G D+20〜25、PUB-L D+30〜35、E D+35〜40。Session B は D+3〜5。計画 `~/.claude/plans/610-pr-c-query-nir-valiant-thunder.md` の :100、:103。repo の外の作業記録で、2026-10-14 に読んだ版は sha256 `88276428…`）と、/2 と /3 の Option 間の差（PUB-G で約3日）に置く。merge の列は1本で、計画は1日あたり 3〜6 本を見込んでいた（同 :325）。U7（cont:30）で、通常の PR の merge の条件は「rebase して Quick」になった。CB-2 は高リスクの PR として、lifecycle とセキュリティの reviewer を2名にする。SB-1 による短縮と、K3 の S3 の結果による DA-2 の増加は、K5/3 と K3/2 が日数にしておらず（どちらも Session B で integrator が再見積りする）、この draft に導出がないので、数値にしない。次の前提を置く。

### 見直しの前提（`14fd3cfc`）

- merge 済みのもの: /3 が書いた CP-0（#639）、CP-1（#641）、CP-2a（#655）、B-ROUTE（#643）、DT-1〜3（#634、#642、#637）、HP-1（#632）、CR-REC（#650）に加えて、CR-2（#656）、CQ-OPT（#657）、DOC-REC（#661）、B-GUARD（#660）、X1-1（#662）が入った。どれも K2〜K6 の確認を待たない作業で、CB-1〜4 の作業量を減らさない。
  - B-GUARD: setup に残る下書きや却下の Revision が B の seal を止めなくなり、G-01 と追加 Scene の setup で B の sealed binding を確立できない危険が減る（C14）。両 Option に共通。
  - CQ-OPT と CR-2: C-query の SQL steps を減らし、資源の境界の試験を足した。確認済みの値は変えていない。両 Option に共通。
  - X1-1: 章（folder）の構造の変更で配下の Scene の v1 が進むようになった。Option B の宣言の可用性が下がる（章の組み替えで配下の宣言が失効して戻らない）が、日数には効かない。宣言の実装は `14fd3cfc` にない（`BodyDeclaration` と宣言の writer を grep して、ないことを確かめた）ので、利用者が今失うものはない。
- 未 merge のもの: CQ-AVAIL（DR-CQA-1〜3）と CQ-MEM（DR-CQM-1）は委任で実装中である。SB-4 は、これらの後に現実の形の fixture で測り直して proposal/7 を起案するとし（cont:34）、X1/1 はその実測を X1-3 の後に取るとする（X1/1 の「integrator の判断」の Q7）。proposal/7 の値は C の受入れ（Graph の寄与の全体）に効き、C を条件に含む PUB-G と PUB-L の両方に同じだけ効くので、Option A と B の差には効かない。/3 は「C-query の資源の値が足りない可能性があり、緩和が要るなら確認の往復が要る（+3〜5 日、推定）」として、この点を扱わなかった。この点は、SB-4 と SB-5 で、proposal/7 を起案して確認を受けることに決まった（cont:34-35）。
- X1/1（Session B1 で示す）: 確認されれば、CP-4 は X1-2 と X1-3 の merge を待つ（K6/2 と X1/1 の「確認後の記録」）。X1/1 の見積り（確認の後、X1-2 は 1.5〜2 日、X1-3 は 3〜4 日。見積りに入っていない作業がある）では、Session B1 が D+3〜5 なら X1-3 は D+8〜11 前後になり（merge の列の待ちは含めない）、下の表の CP-4（Option B は D+18〜21、Option A は D+15〜19）より前なので、表の日付は変えない。X1 の lane が1週間ほど遅れると、CP-4 を X1 が決める側に回りうる（両 Option に共通）。X1/1 が確認されない場合の CP-4 の扱いは、K6/2 とユーザーの判断に従う（XK-7）。
- Session B2 の置き方: この draft は Session B2 で示す。資源の proposal/7 と一緒に示すか、先に単独で示すかは integrator が決める。この draft の確認は proposal/7 の値に依らない（C-body の上限は K1b の規則で integrator が選び、worker の query は確認済みの `graph-limited-binding` の版の値に従う。「資源」）。proposal/7 と一緒に示すと、この draft の確認は proposal/7 の起案（CQ-AVAIL、CQ-MEM、X1-3 の後の実測）を待ち、CB-1 以降と Option B の PUB-G がその分だけ遅れる。PUB-G は proposal/7 の実装も待つ見込みだが、CB の鎖（確認から PUB-G まで、下の表で約 17〜20 日）のほうが長い見込みなので、先に単独で示すほうが PUB-G を早める（推定）。どちらにしても、遅れが PUB-G と PUB-L の差（中心で約10日）を食うと、Graph の鎖が E を決める側に回りうる（下の「E に効くか」）。
- SB-1 の影響（日数にしない）: K5 の C で local 送信の鎖は短くなる見込みだが、K5/3 は日数にしておらず、PUB-L の目安（D+30〜35）を変えないとする（K5/3 の「critical path への影響」）。K3 の O-2 と S3 の結果で DA-2 の範囲が増え、K3/2 は PUB-G が目安より遅れうるとし、見積りを integrator に委ねる（K3/2 の「critical path への影響」）。D2a（DA-1、DA-2）は、Graph の製品公開条件（A3 + B + C + D2a）と Packing の製品公開条件（C + D1 + D2a + D2b-1 + D2b-2）の両方に入る（l6-l9:576-577）ので、D2a の範囲増は PUB-G と PUB-L に同じだけ効く。Option A と B の差には、DA-2 の前提の違い（B は CB-2 の MG-1 を待ち、A は MG-1 を DA-2 の側で作る。下の表）を除いて効かない。
- Graph の鎖のうち CB の部分の見積りは /3 から変えない。早める要因（CP-1、CP-2a、B-ROUTE、DT-1、B-GUARD が先に入った）と遅らせる要因（CB-2 が高リスクであること、CB-1 に Index の dirty の除外〔C17〕と X1-2 の網羅の試験との整合〔XK-6〕が加わること）があり、どちらも日数にする根拠が足りない。DT-1 で lifecycle seam が入ったので、CB-2 はその seam を導入せず使う側になる。
- 残りの lane は、どれも K2〜K6 と X1/1 の確認を待つ。Graph の鎖は CB-1〜4（K2）、DA-1、DA-2（K3）、CP-3a／b、CP-4、PUB-G。local 送信の鎖は DF+、DT-4、DT-5、HS-1、HC-1、DI-1、DP-H、DD-1、PUB-L（K4、K5、K6）。確認の後の lane の長さは未実測なので、確認の前に入った lane の速さは、確認の後の日数に反映しない。

### Option 別の日数（推定）

| 段 | Option B（推奨） | Option A |
| -- | ---------------- | -------- |
| 確認 | この2文を Session B2 で。B2 が D+3〜5 なら、下の日付のまま。B2 がそれより k 日遅ければ、C-body から PUB-G までを k 日ずつ後ろにずらす | `g01-eval-revision` の新しい draftRef（指標の変更）と、CP-0 が固定した G-02、G-07、G-08 の改版は、まだ起案されていない。B2 で Option A が選ばれれば、その後に起案、独立した期待値の review、確認の往復が要り、+3〜5 日 |
| C-body | LEDGER-1 の後、CB-1 の merge は D+7〜8（Index の dirty の除外〔C17〕を含む）、CB-2（MG-1 を含む）は D+11〜13、CB-4 は D+14〜17。CB-3 は CB-2 と並行。CB-4 は CB-1 と CP-1（merge 済み）の後に並行して作り、CB-2 の後に merge する | なし |
| 評価の固定（G-01 と追加 Scene） | G-01 に加えて、G-02、G-07、G-08 の追加 Scene の宣言の addendum を、観測前の commit（CP-4）に入れる（0.5〜1 日、並行。4つの Scene は同じ値で、独立 review の対象が増える） | 改訂した fixture、期待値、独立 review を観測前に固定する。G-01 に加えて、CP-0 が固定した G-02、G-07、G-08 の改版も要る（2〜4 日、並行） |
| D2a（DA-1、DA-2） | DA-1 は CB-1 の次、DA-2 は CB-2（MG-1）と CP-3a の後。K3/2 の範囲増（O-2 と S3 の結果）で上側に延びうる | DA-1 と範囲増は同じ。DA-2 は CB-2 を待たないが、MG-1 を DA-2 の側で作る（CB-2 に含まれていた基盤で、作業は減らない） |
| CP-3b | CB-4 の後、D+16〜19 | DA-2 の後、D+13〜17（CP-2a は merge 済み）。DA-2 が延びれば、この日付も延びる |
| CP-4 | D+18〜21（X1/1 が確認されれば X1-3 の merge の後。上の前提では間に合う） | D+15〜19（同じ） |
| PUB-G | D+20〜25（計画の目安のまま。DA-2 の範囲増と B2 の時期で遅れうる） | D+17〜22（改訂が B2 と同じ時期に確認された場合。改訂の往復が B2 の後になれば +3〜5 日） |
| PUB-L | D+30〜35（計画の目安のまま。K5 の C による短縮は未見積り） | 同じ |
| E | D+35〜40（同じ。下の「E に効くか」） | 同じ |

### E に効くか（推定）

- E は、Graph の鎖（CB と CP-4、PUB-G の承認）、D2a、local 送信の鎖（DF+ から DD-1、PUB-L の承認）のうち最も遅いものに、E-1 と E-2（約5日。計画の PUB-L から E までの日数）を足した日になる。Option A が変えるのは、Graph の鎖の CB の部分（PUB-G で約3日）だけである。D2a の範囲増と local 送信の鎖は変えない。Option A で DA-2 が CB-2 を待たなくなる差と、MG-1 を DA-2 の側で作る分は、再見積りの対象で、符号を決めていない。
- Option A が E を早めるのは、Graph の鎖が3つのうちで最も遅いときだけで、早まる日数は、約3日と、2番目に遅いものとの差のうち小さい方である。計画の目安では、PUB-L（D+30〜35）が PUB-G（D+20〜25）より、中心で約10日、幅の端どうし（PUB-G の遅い側と PUB-L の早い側）でも約5日遅い。この差が残る限り、Option A でも E は早まらない。
- 差が縮むのは次のときである。(1) K5 の C による local 送信の鎖の短縮が、この差を超える（K5/3 は、鎖が短くなると Graph の鎖が E を決める側に回りうるので、K2 の Option A と B の差が E に効きうると書いており、この draft も同じ向きである）。(2) Graph の鎖が見積りの上端を超えて遅れる（CB-2 は高リスクで、`[precheck]` での停止や再起案もありうる。X1 の lane の遅れ、DA-2 の範囲増、Session B2 の遅れも、Graph の鎖を延ばす）。どちらでも、E が早まるのは最大で約3日である。そのうえ、Option A の評価の改訂はまだ起案されておらず、その確認の往復が B2 の後になれば、Option A の Graph の鎖も同じだけ延びるので、差はさらに縮むか逆になる。この draft は (1) と (2) の幅の根拠を持たないので、計画の目安の下での結論だけを書く。
- DA-2 が延びるほど、Option A の PUB-G も DA-2 で決まり、Option B との差は縮む。Option A の DA-2 は CB-2 を待たないが MG-1 を含むので、縮み方は再見積りで決める。
- local 送信の鎖の DT-5、DI-1、DP-H、DD-1 自身の遅れは、ここでは調整していない（上側に延びうる）。延びれば、Graph の鎖は E にさらに効かなくなる。

### そのほか

- Option A でも MG-1（DA-2 の ProfileActivation）と durable workspace identity（K4/3 の §7）は作るので、減る作業は CB-1、CB-3 と、CB-2、CB-4 のうち宣言に固有の部分。U7 で merge の列の律速が緩んだので、列が数本空く分の差はほぼない。
- Option A の評価の改訂が否決されれば、C-product と Graph の受入れは HOLD のままになる。その場合は PUB-G だけでなく、C を条件に含む PUB-L（Packing の製品公開条件、l6-l9:577）と NIR-1 の完了にも届かない。
- Option B の遅れの主な要因は CB-2 と、この draft の確認の時期（Session B2）である。K2 の確認が遅れると、その日数だけ PUB-G が遅れる（計画の最大のリスク）。
- S1 では G-01 の R と R+IR が期待どおりだったので（C14）、「S1 が期待と違えば C-body に投資する前に停止点へ回す」条件は起きていない。S1 が見つけた B の sealed binding の経路の欠けは、B-ROUTE（#643）で埋まり、B-GUARD（#660）で setup の Revision による停止の危険も減った。B-ROUTE は Option A と B のどちらでも CP-4 の前に要るので、両者の差には影響しない。この経路で G-01 の setup が B の sealed binding を確立できることは、CP-4 の前提条件（`b-sealed-binding`）で確かめる。確立できなければ、G-01 はどちらの Option でも Hold で、`[precheck]` でユーザーの判断に回す。
- Option B の G-02、G-07、G-08 の宣言の addendum を観測前に固定しないまま CP-4 が固定済みの setup のとおりに走ると、追加 Scene が返らず Hold になり、C-product の受入れが閉じず、PUB-G、PUB-L、E が止まる。観測前の commit は CP-4 の最初の作業にし、Graph arm の最初の観測の前に入れることを CP-4 の TASK の受入れ条件にする（「確認後の記録」）。

## 委任で決めること（U3。この draft で固定しないもの）

次は、確認された契約の範囲の中の技術判断として、各レーンが決めて記録する。委任の外（新しい送信先、保存範囲の拡大、閾値の緩和、製品公開、製品認可の削除、新しい契約・authority。cont:68-74）に当たる判断は、委任で進めず、`[precheck]` で止めてユーザーの確認を求める。

- 列の名前、JSON の符号化、版付きの識別子の文字列、feed の object kind と op の名前（A1 と別の kind にすることと、Scope authority の変更として扱わないことは固定）、idempotency の domain。宣言、取消、クリアの書込みが宣言の2列だけを書き、行の v1 の列（`updated_at` を含む）を書き換えないことと、宣言の ID と時刻を宣言の writer が生成することは固定する。
- 宣言の kind の event だけの feed の transaction を Index の dirty から外す実装の形（C17）。外す条件（transaction の event がすべて宣言の kind のとき）、ほかの kind の event を含む transaction は今どおり dirty にすること、ほかの kind に広げないことは固定する。
- X1-2 の writer の網羅の試験との整合の形（宣言、取消、クリアの writer を「Scope 世代を進めない writer」として表に載せるか、試験が数える列を限るか。XK-6）と、X1-3 の feed の routing での宣言の kind の分類の置き方（Source を持たない既知の kind にすることは固定。XK-5）。後に merge する側が決める。
- lifecycle の edge と COMMIT の順序を固定する仕組み（seam を使った final-commit reservation など）、fence の順序、終端の証拠の型。CB-2 の有限の owner/lifecycle matrix に書く。仕組みは、通常の participant（原稿の保存や読取）を止めず、COMMIT を lifecycle の lock の中で行わないこと。
- grant の内部 API（DSN §7.2）と、Main での横取りの実装。
- unavailable の理由の code の名前（閉じた集合であること、target を識別しないこと、Graph-only の追加について候補の有無と不適格の理由を区別しないこと、Graph-only の候補の失敗で Graph の全体の理由 code を使わないことは固定）。取消の入口の応答の code の名前（閉じた集合であることと、Graph の到達、候補の有無、veto の種別を含めないことは固定）。
- 「利用時の判定」の手順 3 の中の項目の順序（すべてを満たすことと、本文の読取を1件以下にすることは固定）。
- 宣言と取消の入口の gate を開く Main 専用の N-API の名前と形（既定で閉じること、PUB-G の前は CI seam が有効な起動だけで開くこと、renderer、preload、IPC から開けないことは固定）。
- 評価用の CI seam の env の名前、receipt の形。G-01 と G-02／G-07／G-08 で宣言を setup で行うか測定の workspace で行うか（「測定の workspace」の (i)、(ii)。観測前の commit〔CP-4〕が決める。4つの Scene で同じ選択にする）。gate の条件、承認の範囲、宣言の段に使う Main は、「Main の一回限りの確認」で固定する。
- module の配置と、UI の配置（CB-3。草案、宣言済み、現在有効の3つを区別して表示する）。registry の変更や章の組み替えなどで失効した宣言を作者に知らせ、改めて宣言するよう促す表示も候補にする（宣言は Scene ごとに確認を要する）。
- K1b の数値（integrator が実測から選び、PR に記録する）。
- schema の版の採番（既定 v43。X1/1 の設計 A などと merge の順で決める）。
- 決めた内容は、mutation の前に PR 本文とレーンの decisions（`docs/plans/nir1-lane-decisions/`。cont:105-109）に記録する。この draft の actor、攻撃の範囲、防御、保存の範囲、開示の範囲、受入れを変えることになる場合は `[precheck]` で止め、新しい draftRef で起案する。

## ほかの draft との関係

Session B1 の提示版（K3/2、K4/3、K5/3、K6/2、X1/1、DSN）は、確認で凍結されるので、K2/3（`nir1-c-body-disclosure-proposal/3`。sha256 `b847ca02…`）を引く箇所を直せない。それらの箇所は、K2/3 ではなくこの K2/4 を引くものと読む。K2/3 は「/3 の扱い」のとおり superseded で、K2/3 の主張は、K2/4 の「/3 からの差分」に書いた点を除いて K2/4 に引き継がれている。下の表は、引く側の draft の節・項目（Session B1 の提示版は節・項目の名前で、K2/3 は sha256 の版の行番号で書く）と、K2/4 で当たる節を対応させる。

| 引く draft と箇所 | K2/3 の何を引くか | K2/4 では | 読み替えで変わること |
| ----------------- | ----------------- | --------- | -------------------- |
| K3/2 の冒頭の表の「版の経緯」、「区分の構成」の「宣言 UI（本文の宣言と取消）」の行、「確認後の記録」の「他の draft」の項 | 取消は開示を狭める操作なので grant を要さない、とする記述。K3 の /1 の同じ行と byte 同一で、2つの入口をまとめて grant を要する、とする記述 | 「scope-storage-authority」の「writer」の「取消の入口と grant」。「/3 からの差分」の「取消の入口の grant」の行 | K3/2 が K2 の確認に委ねた点（取消の入口の grant）を K2/4 が決める（推奨は要さない）。「byte 同一」の記述は K2/4 にない。本文の宣言の入口が Main の grant を要することは同じ |
| K4/3 の「確認に出す前の照合」の (14)、§7 の canonical locator の項 | K2/3 の「canonical locator」の節 | K2/4 の「canonical locator」の節 | /3 から変えていない（「/3 からの差分」の「K4 の引用」の行）。(14) の照合の結果は変わらない見込みで、K4/3 の担当が B2 の前に確かめる（「確認後の記録」の K4/3 の項） |
| K4/3 の「確認に出す前の照合」の (10)、K5/3 の「根拠: ユーザー決定」の UB2 の行、X1/1 の「根拠: ユーザー決定」の ID の対応 | K2/3 の呼び名 UB1、UB2（K2/3 の「根拠: ユーザー決定」） | K2/4 の「根拠: ユーザー決定」の SB-1、SB-2 | 呼び名だけが違う。同じ決定（継続計画 §1 の SB-1、SB-2） |
| K4/3 の「変更の一覧」の U と V の行、「ほかの draft との関係」の K2 の行、「確認後の記録」 | K2/3 が Session B1 では示されず、B2 で K2/4 に改められること。X1 の影響で直されること | K2/4 は Session B2 で示す。X1 の影響は「X1 への依存」と「前提: 現行のコード」で直した | 履歴の記述は変えない。sha256 `b847ca02…` で引いた箇所は、K2/3 の履歴として読む |
| K5/3 の「確認後の記録」の K2 の項 | K2/3 の「/2 からの差分」の表の「評価用の CI seam が承認する grant」の行（`LocalSendConsent` の語を外した） | K2/4 の「Main の一回限りの確認」の評価用の CI seam の「範囲」の項（承認するのは `BodyDeclaration` だけ）。/3 から変えていないので「/3 からの差分」には載せていない | 規則は同じ |
| K6/2 の「/1 からの差分」の #39、`g01-eval-revision` の「選択肢と推奨（測り直しの lane）」の案2、「確認後の記録」 | K2/3 の「/2 からの差分」の「addendum の決定の時期と担い手」の行、「確認の扱い」、「確認後の記録」の「TASK への写し」。担い手を `G01-RM` か CP-4 とする定義 | K2/4 の「/3 からの差分」の「観測前の commit の担い手」の行、「確認の扱い」の「観測前の commit」の項、「確認後の記録」の「TASK への写し」の CP-4 | 担い手は、案1、案2 のどちらでも CP-4 の1つ。K6/2 の案2 の「K2/3 の定義が合わない」は K2/4 で解消する（K6 の担当が、確認後の記録で読み替える） |
| X1/1 の「ほかの draft との関係」の K2 の表の「K2/3 の箇所」の列（:84）、「他の draft に及ぶこと」の K2/4 の項 | K2/3:84（C2）。v1 の token は本文の保存などで進む | K2/4 の「前提: 現行のコード」の C2 | X1-2 の前（今の master）と後を書き分けた |
| 同上（:382、:390） | 「失効」の「失効の範囲」の項。「変更前後」の「v1 の version と token」の行 | K2/4 の「失効」の「失効の範囲」の項。「変更前後」の同じ行 | 宣言の操作が v1 を進めないことは同じ。v1 を進める writer の範囲は X1-2 の前と後で書き分けた |
| 同上（:427、:434） | 「失効」の「v1 の token による不一致は戻らない」の項。失効の表の AI Apply の行 | K2/4 の「失効」の「不一致による失効」の「本文と title の変更による不一致は戻らない」の項。失効の表の AI Apply の行 | X1-2 の前は v1 の token、後は本文 Source の token と title の digest で戻らない |
| 同上（:47、:372、:364） | restore と Safe Mode のクリア。宣言の writer は宣言の2列だけを書くこと | K2/4 の「保存先」と「失効」の「明示的なクリア」の項。「writer」の同じ項と C15 | 変わらない |
| 同上（:263） | grant の binding（title の digest を含む） | K2/4 の「Main の一回限りの確認」の binding の項と、「X1 と grant の束縛」の項 | v1 の token、本文 Source の token などを足した（「/3 からの差分」の「grant の束縛」の行） |
| X1/1 の「確認の扱い」と draftRef の行、Q5 | K2/3 の draftRef `nir1-c-body-disclosure-proposal/3` の `scope-storage-authority` の行。「Option A を選ぶ場合は、どちらの文も出さない」 | K2/4 の draftRef `nir1-c-body-disclosure-proposal/4` の同じ行。「確認の扱い」の同じ項 | 規則は同じ。draftRef は /4 に読む。X1 を C-body の行に入れない理由も変わらない |
| DSN の §7.2 の公開の前の gate の段落、§7.3 の `BodyDeclaration` の行、§10 | K2 の proposal/3 の `graph-target-scene-body-disclosure` の Mandatory defenses の 10 と、宣言の入口が grant を要するという記述 | K2/4 の同じ contractId の Mandatory defenses の 10。「scope-storage-authority」の「writer」 | 内容は同じ。DSN が K2 の proposal/3 を引く箇所を /4 に改める作業は、「確認後の記録」の DSN の項で行う |

## 確認後の記録（この draft の外で行う）

- LEDGER-1: 確認された draft を byte 同一で取り込む。台帳に `graph-target-scene-body-disclosure` の行を加え、`scope-storage-authority` の行に proposal/4 の差分（confirmedRef `nir1-c-body-disclosure-proposal/4#scope-storage-authority`）を加える。どちらにも、この draft の SHA-256 と確認文を記録する。`nir1-l6-l9-contract-proposal/3` の確認は置き換えない。`scope-storage-authority` には X1/1 の差分（confirmedRef `nir1-scene-scope-projection-proposal/1#scope-storage-authority`）も並びうるので、2つの差分が互いを前提にしないこと（「確認の扱い」）を注記する。
- l6-l9:40 の C-body の HOLD の行（「HOLD。K2の確認待ち」）を更新する。
- master の旧 draft 2本と、2026-09-25 の /1 と、未確認の /2、/3 に superseded の注記をする（G0 の banner とそろえる。/2 と /3 は branch `claude/nir1-contracts` に bytes を残す）。
- DSN（Session B1 の提示版を基準にする）を次のとおり改める。DSN の担当が行う。
  - §7.3 の `BodyDeclaration` の binding に、v1 の token、title の digest、storage digest、正規化の版、UTF-16 長、宣言の現在の token、ダイアログの表示文の digest を足す。
  - §7.3 の消費する writer を、`narrative_scene_scope_update` の本文宣言の分岐から、この draft の宣言の入口に改める（§7.3 が予定として書いているとおり）。取消の入口は grant を要さない。
  - §7.2 の `GRANT_REQUIRED_COMMANDS` には、宣言の入口の command だけを載せ、取消の入口と `narrative_scene_scope_update` は載せない。DSN 側の修正は、`scope-storage-authority` の Negative（A1 の保存はダイアログを起こさず、宣言の欄を足した A1 の payload は `deny_unknown_fields` で拒否する）を満たすこと。
  - §7.3 の `BodyDeclaration` の行に、binding の版が進む編集が X1 で変わること（X1-1 で章の構造の変更でも進み、X1-2 の後は題名、表示 metadata、本文の保存では進まない。project snapshot の本文の restore は binding を作り直す）と、そのため grant が本文 Source の token と title の digest でも束縛すること（「Main の一回限りの確認」の「X1 と grant の束縛」）を注記するかを、X1/1 の「ほかの draft との関係」の「そのほか」の DSN の項のとおり、DSN の担当が決める。
  - §2.3 を、この draft の「利用時の判定」に合わせて改める。(d) の all-or-nothing の範囲を、R+IR の Scene に付ける path の association に限る。Graph-only の候補の (b)、(c) の不一致、本文の照合の失敗、K1b の上限の超過は、追加1枠を出さないことだけにし、Graph の全体の理由 code を使わない。
  - §1.5 の理由の集合に、Graph-only の追加についての1つの code（`graph-target-scene-body-disclosure` の Mandatory defense 9）を加え、返却時の Graph の全体の理由としての `invalidated` と `limit` を、Graph-only の候補に依存しない原因に限る（click 時の遷移の拒否は、同じ Mandatory defense の対象外の項目のとおり）。
  - §7.4 の admission closure の「grant を使う機能の gate」に、宣言と取消の入口の gate（同じ行の Mandatory defense 10）を加える。
  - DSN が K2 の proposal/3 を引く箇所（§7.2 の公開の前の gate の段落、§7.3）を、/4 に改める。
- K3/2: 「区分の構成」の「宣言 UI（本文の宣言と取消）」の行は、本文の宣言の入口は K2 の Main grant を要し、取消の入口の grant は K2 の確認に従う、としている（入口の名前は CB-2）。この draft の確認で、取消の入口は grant を要さないと決まる。K3 の bytes は確認後に編集しないので、CB-2 が決めた入口の名前と、取消の入口が grant を要さないことは、CB-2 の PR と Main の route 台帳（`electron/main/profileEgress.ts` の `INTERNAL_COMMANDS`）に記録する。登録済みの caller の確認は restricted だけである（「writer」の入口の項）。K3/2 の「確認後の記録」の「他の draft」の項が K2/4 に求めた、宣言 UI の行の変更の反映と、K3/2 を文書名と節・項目で引く形は、この draft で済ませた。
- K6/2: 「/1 からの差分」の #39 が K2 に求めた、測り直しの lane の案2 のときの観測前の commit の担い手は、この draft で CP-4 に定めた（「確認の扱い」）。案1、案2 のどちらでも、K6/2 が K2 の写しの項目を写す先は CP-4 の TASK の1つになる。K6/2 の「選択肢と推奨（測り直しの lane）」の案2 の評価の、K2/3 の定義が合わなくなるという記述は、K6 の担当が、この draft の確認の後の記録で読み替える（K6/2 の bytes が凍結されていれば、書き換えない）。
- K4/3: 「確認に出す前の照合」の (14) は、K2 の canonical locator の節が変わったら照合し直すとしている。この draft はその節を /3 から変えていない（「canonical locator」の最後の項）ので、照合の結果は変わらない見込みである。K4/3 の担当が、Session B2 の前に確かめる。durable workspace identity の実装を一つにすること（K4/3 の §7）も変えない。
- TASK への写し:
  - CP-4: 観測前の commit（addendum の file、宣言の場所 (i)／(ii)、B の seal の手順、独立 review の記録）を、Graph arm の最初の観測の前に入れること。宣言の段と対象の4つの Scene、宣言の run（5 run）と時期、測定の receipt の項目（workspace ID と canonical locator の digest、宣言の token、seam の receipt、宣言の段の直前と直後の Index の metadata）、Graph arm の最初の query の前の照合と `[precheck]` での停止、診断用の負例の run。X1/1 が確認されれば、X1-2 と X1-3 の merge を開始条件に加える（K6/2 と X1/1 の「確認後の記録」）。
  - CB-1: 宣言の2列、migration、restore のクリア、feed の kind の登録、宣言の kind の event だけの transaction を Index の dirty から外す変更と、その試験（ほかの kind を含む transaction では今どおり dirty になることを含む）。schema の版の採番。X1-2 が先に merge されていれば、X1-2 の writer の網羅の試験に、宣言の writer を合わせる（XK-6）。
  - CB-2: 宣言の入口（grant を要する）と取消の入口（grant を要さない）。gate、restricted での caller と workspace の確認、閉じた集合の応答、宣言がないときに何も書かないこと、undo と再送で戻さないこと。入口の名前を Main の route 台帳に加える。
  - CB-4: 経路ごとの失効の試験（title の A→B→A と割り込み、章の構造の変更とその戻しを含む）。測定の workspace の照合は写さない。
  - X1-2（X1/1 の確認の後）: CB-4 が先に merge されていれば、この draft の失効の試験（XK-1）が X1-2 の後も通ることと、writer の網羅の試験に宣言の writer を合わせること（XK-6）を、X1-2 の PR の受入れに加える。
  - X1-3（X1/1 の確認の後）: CB-1 が先に merge されていれば、宣言の kind を、feed の routing で Source を持たない既知の kind として分類し、投影の identity に写さないこと（XK-5）。
- 確認されなかった行は、HOLD 表に `[precheck]` として残す。Option A が選ばれた場合は、`g01-eval-revision` の新しい draftRef（指標の変更）と、CP-0 が固定した G-02、G-07、G-08 の改版を起案する。

## 確認文

確認は contractId ごとに次の 1 文で行う（l6-l9:141）。

- I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId graph-target-scene-body-disclosure.
- I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId scope-storage-authority.
