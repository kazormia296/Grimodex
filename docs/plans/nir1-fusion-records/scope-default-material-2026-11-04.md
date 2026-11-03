> 注（integrator、2026-11-04）：read-only の workflow（調査 3・反証の検証 3・まとめ 1。model は sonnet。調査の 1 つは安全の分類器が時間切れで、integrator が結果を確かめた）の材料。§6 の「評価の試運転の原因は未確定」について、integrator が試運転の workspace の DB（`runs-ir/skip-all-2/workspaces/ir/grimodex.db`、読取りだけ）で確かめた：scope の binding は 18 件すべて `unknown`、archived の Scene は 0、project の `phase_resolution_mode` は `reading`。`query_context.rs:120-133` により scope が unknown なら IR は `ScopeUnsupported` になるので、scope が原因と見てよい（他の条件も同時に満たしていないかは確かめていない）。

# 新しい場面の scope の既定を見直すための整理

調査基点は `origin/master` の `f36dd696`（2026-11-03、#783）。調査は git object を読むだけで、実機の起動と実行はしていない。「確認済み」はコードや文書で確かめた事実、「推測」は私たちの読みを指す。

## 1. 結論

- scope は、その場面や材料がどの時間軸・世界線・作中の階層・誰の視点に属するかを表す「適用範囲」の宣言。出所の情報ではない。
- 新しい場面は「未設定（unknown）」で作られる。未設定のままだと、関連場面の IR（承認済みの解釈）は出ない。Graph も同じ原因で出ない。本文検索（Raw）の結果は出続ける。
- これは不具合ではなく、設計どおりの fail-closed（迷ったら出さない）。2026-09-14 の PR #585 で実装された。
- 作者が困る点は 3 つある。
  - 設定画面に、設定すると IR が出るという説明がない。
  - 「この参照条件では検索できません」という案内も、原因が scope だと言わない。
  - 設定するには、先に project の語彙（registry）を作り、場面ごとに 3 軸すべてを選ぶ必要がある。
- 既定を変える案には、確認済みの契約を動かすものと、動かさないものがある。動かさない案が最初の一歩として最も安い。

## 2. scope の軸の説明

scope には 9 つの軸がある。作者に関わる主なものは次の 3 つ。

| 軸 | 意味 |
|---|---|
| timeline | どの時間の流れか |
| worldline | どの世界線か |
| narrativeLayer | 本編か、作中作か、といった階層 |

ほかに viewpoint、knowledgeHolder、audience、scene、storyTime、readingOrder がある。

各軸の値は 3 種類。

- **any**: この軸では意図的に制約しない。
- **exact**: 登録済みの特定の値（例 `timeline:main`）に決める。
- **unresolved**: 制約はあるが、まだ具体値を決められない。

ADR 009 は、any（制約なし）と unresolved（未解決）を区別する。区別しないと、未解決の世界線や知識保持者が暗黙に「全範囲」と見なされ、情報を出しすぎる。ADR は「unresolved は、後で any になる仮の状態ではない」とも書いている。

具体例

| 場面 | 想定する scope | 混ざると困ること |
|---|---|---|
| 回想の場面 | 本編とは別の時間（別 timeline か storyTime） | 回想で明かした事実が、本編の「今」の場面の参照に混ざる |
| 夢の場面 | 別の階層（narrativeLayer） | 夢の中の出来事が現実の出来事として参照される |
| 別の世界線の場面 | 別の worldline | 別の世界線で起きたことが本筋の事実として出る |
| 作中作 | 別の narrativeLayer | 作中作の設定が本編の設定として出る |

scope の軸が防ぐのは、これらの混入。未来の情報と秘密は、別の仕組みで防いでいる。

- 読書順で、参照元の材料は今の場面より前の場面に限る。
- 秘密の情報は出さない。

この 2 つは scope の既定とは独立している。どの案でも「後ろの未開示情報や秘密が出る」ことにはならない（確認済み）。

## 3. 決めた経緯

| 日付 | できごと | ユーザーの確認 |
|---|---|---|
| 2026-08-20 | ADR 009 が、any と unresolved の区別を採用した | ADR は Accepted（#550） |
| 2026-09-09 | 実装計画が「Timeline／Worldline／layer の unresolved は拒否」と記した（#567） | 個別の記録は見つからない |
| 2026-09-12 | L6〜L9 実行計画が、新規場面は未設定なら unknown、移行場面だけ legacy-absent と記した（#571） | 同上 |
| 2026-09-13 | 確認台帳が、契約 `scope-storage-authority`（proposal/3）を「ユーザーの明示確認あり」と記録した（#576） | あり。ただし確認文の原文は master 上にない |
| 2026-09-14 | #585 が実装した | 実装の PR |
| 2026-10-17、11-01 | 後続の X1/1、K2/4、X1/3 | unknown／legacy-absent／explicit の扱いは変えていない |

確認の範囲について、確かめられたことは次のとおり。

- ユーザーが確認したのは、`scope-storage-authority` という契約の行全体。この行の中身に「未設定なら unknown」と「unknown／unresolved は fail closed」が含まれる。
- 「新しい場面の既定を unknown にする」点だけを取り出した個別の確認や議論の記録は、master 上では見つからなかった。
- ただし、会話内の確認は見られないので、「個別の確認がなかった」とは断定できない。

次の 2 点は区別しておく。

- ADR 009 の `unknown` は、2 つの scope を比べた結果の分類（ScopeRelation）で、場面の marker の `unknown` とは別物。ADR の規則では、any と unresolved の比較は「contains」になり、自動利用の対象に入る。
- 「query の場面が unknown なら IR を全部出さない」という直接の文言は、計画書には見つからなかった。計画書にあるのは「材料の scope が unknown／unresolved なら拒否」と、一般則の「fail closed」。query 側の全拒否は、#585 の実装がより厳しく解釈した結果と読める（推測）。

過去の文書（d2b-history-mapping の draft）には、既定が unknown のため製品同梱サンプルで困る、という記述が既にある。問題は知られていたが、既定そのものの再検討としては扱われていない。

## 4. 作者の今の操作と、既定のままで出ないもの

### 操作

1. 場面詳細パネルの「Scope」欄を開く。パネルの開閉設定は既定で開き、Electron 版の PC 表示で出る。
2. 「Scope registry」を開き、timeline／worldline／layer の ref を文字列で追加して Save する。placeholder は `timeline:main`、`worldline:prime`、`layer:manuscript`。registry は初期状態で空。
3. 場面ごとに、Query の 3 軸すべてに ref を選ぶ。Query には `any` の選択肢がない。Holder と Audience も選ぶ。
4. Save する。UI の Save は常に `explicit` を書く。

project の既定、一括設定、テンプレート、コピーの機能はない。書き込みは 1 場面ずつ。新しい場面を作った直後に促す UI もない。

### 手間と分かりにくさ

- 「Scope」欄の文言は英語の既定値のままで、ja.json にも en.json にも scope 系のキーがない。#783 の後でも日本語訳はない（確認済み）。
- IR が出ないときの案内文は「この参照条件では承認済み解釈を検索できません。本文検索の結果を表示します。」。scope にも設定場所にも触れない。
- 同じ「unsupported-query」は、場面が archived の場合などでも出る。表示だけでは scope が原因か分からない。

### 既定のままで出ないもの

| 状態 | IR | Graph |
|---|---|---|
| 今の場面が unknown | 出ない | 出ない |
| 今の場面が explicit だが Query の軸に unresolved が残る | 出ない | 出ない |
| 今の場面が explicit で Query の 3 軸がすべて exact | 出る | 出る |
| 今の場面が legacy-absent | 出る | 出ない |

- 材料にする過去の場面にも条件がある。過去の場面が unknown だと、その場面を根拠にした IR は出ない。今の場面だけを explicit にしても足りない場合がある。
- legacy-absent は project 単位ではなく場面単位の印。導入前から存在した場面だけが持つ。同じ project でも、移行後に作った場面は unknown になる。
- 新しい場面は、作成、AI の木構造計画の適用、付箋の昇格、project スナップショットの復元、本文保存、ゴミ箱からの復元などで作られる。いずれも同じ関数を通り、unknown になる（確認済み）。呼び出し元は製品コードでおよそ 8 箇所。

### 保存の罠（コードからの推論。実機では試していない）

legacy-absent の場面で、Query 軸が unresolved のまま Save すると、`explicit` かつ unresolved になって IR が出なくなる。`explicit` から legacy-absent には戻せない。registry が空のうちは exact を選べないので、registry を作らずに Save すると誰でもこの状態になる。

## 5. 見直しの案の比較

| 案 | 内容 | 変える場所 | 開示の安全 | 評価・契約への影響 | ユーザーの確認 |
|---|---|---|---|---|---|
| A | 今の契約のまま、案内と設定の手間を減らす | renderer のみ。案内文、1 クリック設定、ループによる一括設定 | 変わらない（fail-closed を保つ） | 契約は動かない。CP-4 と DP-H も動かない | 既存の書き込み経路だけなら不要 |
| B | project に既定の scope を持たせ、新規場面が explicit で継承する | registry の形式、保存、migration、restore に波及 | 材料側を exact にすれば保てる。既定の any のままだと全 query に見える | 契約行（proposal/3）が動く。既存の Revision と Index が失効しうる | 要る。新しい draftRef |
| C | 新規場面を最初から「本筋」の explicit にする | 場面作成時の既定を決める 1 関数。ただし registry の初期値も要る | 最も大きい。「未設定」が「本筋と決めた」になる（推測） | 契約行が動く。CP-4 が測った条件には近づく | 要る |
| D | query 側だけ unknown を legacy-absent と同じに扱う | query 判定。ただし材料側と Graph も変更が要る | 防御の撤回。「unknown から any への fallback」に当たる | DP-H の拒否 variant の期待値が変わる | 要る。委任の外 |
| E | 新規場面を legacy-absent で作る | 作成時の既定。書き込みの制約も要る | 混在 project で漏れ方が D と同じ（推測） | 契約が動く。Graph は出ない | 要る |

案 B の補足（確認済みの事実）

- registry の変更は、project の scope の authority を動かす。依存する Revision や Index が失効する。
- B と C は、registry に初期値を入れる設計が前提になる。

案 A の補足

- registry に ref を足すだけでも既存の Revision が失効する（確認済み）。「何も起きない」わけではない。
- 一括設定を新しい 1 transaction の書き込みにすると、X1/1 の「閉じた一覧」を広げうるので、新しい契約の確認が要る（推測）。ループで既存の書き込みを呼ぶ形なら、広げない。部分的に適用される場合がある点は、画面で明示する必要がある。

案 D を推奨しない理由

- query 側だけ直しても、材料側が unknown を拒否するので出ない。
- Graph は explicit を要求するので出ない。
- 「unknown から any への fallback」という、契約で明示された in-scope attack に当たる。
- AGENTS の委任（NIR-1 の残レーンの技術判断）は、防御の緩和を含まない。

### 推奨（推測を含む）

1. **まず案 A、その中でも「案内の改善と 1 クリック設定」から。**
   - 関連場面の欄で「Scope 未設定のため解釈が出ません。設定する」と原因を示す。
   - registry の初期値の追加と、今の場面の explicit 化を 1 クリックでできるようにする。
   - 契約を動かさず、既存の書き込みだけで済む。作者が押すので「明示設定」の意味も保たれる。
2. 新しい project で最初から IR が出ることが必要だと作者が判断するなら、次に案 B または C を検討する。
   - 契約の確認と、再測定の要否の判断が要る。
   - 案 B のほうが「作者が決めていない」ことを「決めた」と見なす度合いが小さい。
3. 案 D と E は推奨しない。

どの案でも共通して必要なこと

- CP-4 の Gold は、全場面を explicit にした状態でだけ測っている（DR-CP4-J-2）。製品の既定が unknown のままなら、測った条件と実際の利用が違う。
- PUB-G の開示に、「新しい project では、作者が scope を設定するまで IR と Graph が出ない」を入れる必要がある。

## 6. 確かめられなかったこと

- **評価の試運転の原因。** 全 query が `unsupported-query` になった理由が scope だったかは未確定。場面の archived、authority の読込失敗、axis が reading でない、mapping の欠落でも、同じ値になる。実際の reason が `ScopeUnsupported` かの確認が先に要る。
- **ユーザーの個別確認。** 「新規場面の既定を unknown にする」点だけの確認の有無は、master 上の記録からは判断できない。会話内の確認は見ていない。
- **確認文の原文。** `scope-storage-authority` の確認文の原文は master 上の文書にない。
- **IR の軸の値。** IR の timeline／worldline／narrativeLayer が `any` と確かめたのは、Chronicle の scene event の導出だけ。全種類の IR について「常に any」とは言えない。
- **legacy-absent の query での disclosure。** legacy-absent の query が、各種 IR の開示判定をどこまで通るかは、細部まで追っていない。
- **Raw の絞り込み。** 本文検索（Raw）が scope で絞られているかは未確認。
- **既存 project の件数。** 実際の project で、unknown と legacy-absent の場面がそれぞれ何件あるかは未確認。
- **registry が空のまま Save したときの画面の挙動。** 実機では試していない。
- **CP-4 の凍結 setup。** 既定の registry を変えたとき、終端照合が食い違わないかは未確認。
- **案 B-lite（作成直後に renderer が既存の書き込みで既定を書く案）。** 実物で裏づけを取れなかった。契約の確認が要るかはユーザーの判断になる。
- **DD-1b（ローカル生成の履歴 context）。** explicit でないと unavailable になるコードはあるが、今の製品で閉じていることは確かめていない。

行番号は調査時点の `origin/master` から多少ずれる箇所がある。なお、back_restore、chronicle_bulk、agent_writes、execute、migrate から作る経路の多くはテストコードで、製品の作成経路ではない。