# NIR-1 契約提案 nir1-chronicle-secret-reveal-admission-proposal/1（draft）：secret の出来事を reveal の後に IR へ通す

| 項目 | 内容 |
| ---- | ---- |
| draftRef#contractId | `nir1-chronicle-secret-reveal-admission-proposal/1#chronicle-secret-reveal-admission`（contractId は仮。既存の台帳に対応する行を特定できていない。§8） |
| Status | `[precheck]` の draft／未確認。**2026-11-10 の独立レビューで §0 の推奨の前提が崩れたので、推奨は取り下げた（§9）。§1〜§8 は「secret のまま通す」方向の代償の記録として残す。** この文書は実装・公開・閾値や Gold の変更を許可しない。コード・policy・既存の文書は変えていない |
| baseline の候補 | (1) 実装計画の A2 と query context の表（`docs/plans/narrative-ir-nir1-implementation-plan.md:121`、:141「secretはreveal後も初回不可」）。(2) その元の事前確認（`docs/plans/nir1-related-scenes-precheck.md:50-51`、:71）。(3) 後続の予定を書いた A6（同計画 :125、:147）と L6 の Authority（`docs/plans/nir1-l6-l9-execution-plan.md:886`）。L6〜L9 の保存・移行は未承認（同 :340）なので、(3) は予定であって確認済みの契約ではない |
| 基点 | `master` `2caf67a6`（この worktree の HEAD） |
| ユーザーの選択 | 2026-11-10「通す方向で設計する」（契約の改訂案と漏れの検査を read-only で起こし、実装の前に文面を見る）。規則そのものの確認ではない |

## 0. 一枚目：推奨と残る問い

**何を決める案か。** AI が抽出した出来事の提案は、既定で secret（ネタバレ防止）になる。今の IR は secret の版を、reveal（開示）の Scene の後でも通さない。そのため、作者が提案をまとめて承認しても、関連場面の IR には 1 件も届かない。この案は、届く道を作る規則と手順を決める。

**取り下げ（2026-11-10）**：下の推奨は、独立レビューで前提が崩れたので取り下げる。理由と、確かめた点は §9 に書いた。どの方向に進むかは、ユーザーに伺い直す。

**推奨（取り下げ済み）**
1. **規則**：secret の版は、問い合わせの Scene が reveal の Scene より後のときだけ IR に通す。今ある条件（根拠の Scene がすべて問い合わせの Scene より前、未解決の scope は通さない）は、そのまま AND で残す。作者だけが全部見える特権は足さない。
2. **手順**：「まとめて承認」の操作の中で、Native が scope（開示の範囲）を解決した子の版を作り、その子の版に承認を記録する（§3 の案 B）。作者の操作は今と同じ 1 回で済む。
3. **範囲**：関連場面（Related Scenes）だけに適用する。chat の IR は、2026-11-09 に承認された「secret は拒む」のままにする。

**残る問い**（詳細は §7）
- ★1 この規則で、最初の段の決まり「reveal の後も不可」を改めてよいか。
- ★2 secret の版の vector を、検索用の派生 index に入れてよいか（local の保存が増える）。
- ★3 年表に取り込んだ後で作者が secret や reveal を変えた出来事を、IR 側でどう扱うか。
- ★4 物語内の時間（story 軸）の制約を持つ版をどう扱うか。
- ★5 「まとめて承認」が子の版を作ること（版の数が増える）を受け入れるか。
- ★6 実装の時期（CP-4 の正式な取り直しとの前後）。

## 1. 確かめた事実

特記のないものは、基点のコードを自分で読んで確かめた。

**提案と scope の作られ方**
- 提案は `secret: true`、reveal は最初の根拠の文書、で作られる（`src/features/chronicle/extraction/proposalPlanner.ts:179-183`）。
- 抽出が作る版は、secret なら scope の audience と readingOrder を「未解決（not-provided）」にする（`src/application/narrative-extraction/chronicleV2Production.ts:251-267`）。評価 DB の実物でも、抽出が作った版はこの形だった。
- 作者が review 画面で編集した版は、Native が live の scope authority（project の Scene の並びの正本）から scope を作る。secret のままなら、audience は `exact(reader)`、readingOrder は reveal の Scene を指す interval になる（`src-tauri/crates/grimodex-db/src/narrative_extraction/human_materialization.rs:400-463`）。
- この interval は、始点も終点も reveal の Scene で、両端を含む（同 :465-471）。「reveal 以降」ではなく「reveal の Scene の 1 点」である。
- storyTime は、reveal の Scene の物語内の時間が解決済みなら同じ形の interval、未解決なら未解決になる（同 :430-438）。
- Native の投影の検証は、secret のとき reveal の Scene の reading rank（読む順の順位）を対象に含める（`src-tauri/crates/grimodex-core/src/narrative_scope_dependency_projection.rs:124-141`）。

**閉じている箇所**（`src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/disclosure.rs`）
- :197 secret の版を拒む。:121 scope の依存の投影が secret なら分類しない。
- :235 未解決の値を持つ scope を拒む。:241-242 readingOrder と storyTime が any 以外なら拒む。
- :283 問い合わせ側が `allow_secrets` なら拒む（特権の経路を持たない）。
- 同じ `prepare` を index の作成も通るので、secret の版は index に入らない。
- 問い合わせ側は、根拠の Scene が問い合わせの Scene 自身か、それ以降なら拒む（:286-294）。

**review 画面**
- secret の checkbox と、reveal の入力がある。reveal は文書 ref の手入力である（`src/features/chronicle/ChronicleProposalReview.tsx:271-298`）。
- どの編集でも提案は未 review に戻り、「まとめて承認」の対象から外れる（`src/features/chronicle/chronicleExtractionStore.ts:630-639`）。まとめて secret を外す操作は見当たらなかった。

**年表側の規則**
- 年表の secret の出来事は、今書いている Scene が reveal の Scene より前の間だけ AI から隠す（`src/features/chronicle/chronicleSecrecy.ts:13-21`）。reveal の Scene 自身では開示する。

**数えた値**（第 6 版の評価 DB、117 Scene の 2 作品、Chronicle の出来事だけ、Codex 0 件、年表は空、抽出は 1 Scene ずつ）
- 提案 884 件と 551 件のすべてが secret の既定で、reveal は根拠の文書と同じだった。
- 評価の harness は、全件の secret を外した子の版を作って承認した。子の版の scope は、scene 以外がすべて any だった。

**今の決まりを固定している資産**
- `evals/nir1-retrieval/manifest.json:197`、:251 は、「非 secret の子の版を作って明示的に承認する」手順を正規の手順としている。この案はこの手順を残す。
- Rust の試験で secret の拒否を直接期待する箇所は、grep では見つからなかった（未確認。§8）。
- `evals/nir1-graph/g07-reading-before-reveal.v1.json` は Graph の伏線の reveal で、別の経路である。この案は触れない。

## 2. 規則（推奨の形）

secret の版を通すのは、次のすべてを満たすときだけとする。

- R1. 版が現行で、作者の承認の Decision がある（今のまま）。
- R2. scope が解決済みで、audience が `exact(reader)`、readingOrder が reveal の Scene を指す interval である。未解決の値を持つ版は通さない（今のまま）。
- R3. Native が、版の reveal の Scene を live の scope authority で引き直し、reading rank を得る。版や renderer が持つ順位は信用しない。引けない、複数ある、別 project のときは通さない。
- R4. 問い合わせの Scene の reading rank が、reveal の Scene の reading rank より大きい（等しいときは通さない）。
- R5. 根拠の Scene がすべて、問い合わせの Scene より前である（今のまま）。
- R6. audience 以外の軸（viewpoint、knowledgeHolder、timeline、worldline、narrativeLayer）は、今の比較のまま。
- R7. 用途が関連場面のときだけ通す。ほかの用途（chat の IR など）では、secret の版を今どおり拒む。
- R8. 作者だけが全部見える経路（`allow_secrets`）は足さない。

補足
- **interval の読み方**：今の scope は reveal を「1 点」で持つ。R4 はこれを「開示の起点」として読む、この用途に限った読みである。scope の保存の形は変えない。保存の形を「始点だけの interval」に変える代案は、TypeScript と Rust の共通の検査資産が動くので採らない。
- **年表との違い**：年表側は reveal の Scene 自身で開示する。IR 側は R4 と R5 により、reveal の Scene の次から開示する。IR の方が厳しい。
- **既定の場合**：reveal が根拠の Scene と同じなら、R5 が R4 を含む。これは上の 2 作品（1 Scene ずつの抽出）で全件に当たったが、複数の Scene にまたがる抽出では成り立つとは限らない。
- **story 軸**：★4 の答えで R9 を足す。推奨は「storyTime が未解決の版は通さない。interval の版は、問い合わせの Scene の物語内の時間が解決でき、reveal の時間以降のときだけ通す」である。読む順だけで判定して story 軸を無視すると、今より緩くなる。

## 3. scope をいつ解決するか

制約が 2 つある。承認は不変の版に結び付き、子の版は親の承認を継承しない（実装計画の A3）。未解決の scope は通さない（確認済みの防御）。したがって、作者が承認する版そのものが、解決済みの scope を持っていなければならない。

| 案 | 内容 | 長所 | 短所 |
| -- | ---- | ---- | ---- |
| A | 抽出の時点で Native が reveal を解決し、最初の版を解決済みの scope で作る | 版が増えない。今の「まとめて承認」がそのまま届く | 抽出の出力の形と、最初の版が持つ依存が変わる（NIR-0 で認定した経路の変更）。Scene の並べ替えで最初の版が古くなる |
| **B（推奨）** | 「まとめて承認」の中で、Native が scope を解決した子の版を作り、子の版に承認を記録する | 作者の編集で子の版を作る経路は認定済みで、Native が scope を作る処理は既にある。契約の変更が開示の判定に収まる | 版の数が 2 倍になる。承認のたびに検索 index の作り直しが走る |
| C | 開示の判定の中で、未解決の scope を都度解決する | 版も抽出も変えない | 「未解決は通さない」という防御を崩すので採らない |

- B では、提案の内容（題、secret、reveal）は変えない。変わるのは scope が解決済みになることだけである。
- B の操作は、1 件ごとに「子の版の作成」と「承認の記録」を 1 つの transaction にする。途中で失敗した提案は未 review のまま残す。
- 内容を変えない編集で子の版を作れるかは未確認である（§8）。作れなければ、「まとめて承認」専用の Native の操作を 1 つ足す。

## 4. 範囲と波及

- **chat の IR**：関連場面と同じ関門と index を使うなら、何もしなければ規則が chat にも及ぶ。R7 のとおり、問い合わせの文脈に用途を持たせ、secret の版は関連場面の用途でだけ通す。chat に広げるかは、外部への送信を伴うので別に伺う。
- **index**：secret の版の vector が、local の派生 index に入る（★2）。index は再構築できる派生データで、本文そのものは増えない。
- **Graph と Context Packing**：対象外で、変えない。
- **未承認の提案を検索に使う案**：別の設計案で扱う。この案は承認済みの版だけを対象にする。
- **評価**：既存の手順と凍結した資産は変えない。新しい正例と負例を足す（§5）。製品のコードが変わるので、CP-4 の候補は変わる（★6）。

## 5. 脅威モデル（draft）

- **信頼する actor**：Native の backend、live の project scope authority、作者の承認の Decision。
- **信頼しない actor**：renderer の申告（secret、reveal、scope、順位）、model の出力（提案の文面と値）、古い画面や cache。
- **範囲内の攻撃と誤り**
  - reveal より前の Scene から secret の版が見える。
  - reveal の文書 ref が偽り、存在しない、別 project を指す。
  - Scene の並べ替えの後に、古い順位で判定する。
  - 未解決の scope を any として通す。
  - 親の版の承認を子の版の承認として扱う。
  - 古い世代の index や結果を返す。結果を押したときの再検証が抜ける。
  - 関連場面の用途の許可が、chat などほかの用途に及ぶ。
- **範囲外**：OS や backend の乗っ取り、作者の全開示の特権、Raw の検索の設計、外部への送信。
- **必須の防御**
  - Native が、同じ snapshot で authority と版を検証する。renderer の値を根拠にしない。
  - 未解決、引けない reveal、複数の mapping は通さない。
  - reveal の順位は、問い合わせのたびに live の authority から引き直す。
  - 並べ替えと scope の変更は、今ある依存の仕組みで版の資格を無効にする。
  - 問い合わせ、結果の返却、根拠への移動の 3 箇所で同じ判定を通す。
  - 用途を型で持ち、関連場面以外では secret の版を拒む。
- **受入れへの影響**
  - 正例：既定の版（reveal＝根拠の Scene S1）が、後の S2 から出る。reveal を S3 に動かした版が、S4 から出る。
  - 負例：問い合わせが reveal 以前。reveal の ref が不正。並べ替えで reveal が問い合わせより後ろになる。scope が未解決。audience が reader でない。chat の用途。承認が親の版だけ。
  - 漏れは 3 層（文脈への露出、出力への漏れ、過剰な除外）で対にして測り、露出と漏れの許容は 0 とする（2026-11-05 の決定の様式）。

## 6. 段階

1. この案の確認（★1〜★6）。
2. Native の開示の判定に R1〜R8 を足す。負例の試験を先に書く。
3. 「まとめて承認」を案 B の操作に替える。
4. 評価：承認の操作 1 回で IR に届く割合と、負例の 0 件を測る。結果を見てから開ける。

## 7. 確認が要る点

| # | 問い | 推奨 | 理由 |
| - | ---- | ---- | ---- |
| ★1 | 「reveal の後も不可」を、§2 の R1〜R8 に改めてよいか | 改める | 既定のままの提案が、承認しても IR に届かない |
| ★2 | secret の版の vector を派生 index に入れてよいか | 入れる | 入れないと問い合わせの時点で判定できない。local の派生データで、再構築できる |
| ★3 | 年表で後から secret や reveal を変えた出来事を、IR でどう扱うか | 版の scope と年表の現在の値の、厳しい方に従う | 年表では隠したのに IR に出る、という食い違いを防ぐ。ただし伝わる仕組みは未確認（§8） |
| ★4 | story 軸の制約を持つ版をどう扱うか | §2 の補足の推奨（両方の軸で判定し、解決できなければ通さない） | 読む順だけで判定すると今より緩くなる |
| ★5 | 「まとめて承認」が子の版を作ってよいか | 作る（案 B） | 認定済みの経路を使え、契約の変更が小さい |
| ★6 | 実装をいつ入れるか | CP-4 の正式な取り直し（8 回目の S4）の前に入れ、取り直しを 1 回にまとめる | 製品のコードが変わり、候補の束縛が変わる |

確認なしで決める技術判断：R4 の比較を「より大きい」にすること、用途を分ける実装の形、試験の形。

## 8. 未確認と限界

- contractId に対応する既存の台帳の行を特定できていない。確認の記録の置き方は、台帳の規則に合わせて決め直す。
- 内容を変えない編集で子の版を作れるか（案 B の前提）は確かめていない。
- 年表に取り込んだ出来事の変更が、IR の版の鮮度に伝わるかは確かめていない。評価 DB は取り込みが 0 件なので、このデータでは測れない。
- Rust の試験と CP-4 の負例のうち、secret の拒否に依存するものを全部は列挙していない。
- 複数の Scene にまたがる抽出、reveal を根拠より前の Scene に動かした版、の挙動は確かめていない。
- 数えた値は 2 作品（うち 1 作品は AI が書いた原稿）のもので、Codex のある project や年表のある project の値ではない。
- 足す候補の正しさ（precision）は、この案の対象外で、測っていない。

## 9. 独立レビューの結果（2026-11-10）

§0 の推奨は成り立たない。自分でコードを読んで確かめた点と、レビューの見込みのままの点を分けて書く。

**自分で確かめた点**
- **内容を変えない編集では、scope を解決した子の版は作れない。** 内容が同じ編集は「表示だけの変更」に分類され、Native は scope を作らない（`src-tauri/crates/grimodex-db/src/narrative_extraction/human_materialization.rs:277-286`）。scope の上書きを要求しても、実際の分類が違えば失敗する（同 :207-214）。scope が解決されるのは、secret か reveal を変えた編集だけである。§1 の「作者が編集した版は Native が scope を作る」は広すぎた。§3 の案 B は、既存の経路では実現できない。
- **解決済みの secret の scope は、今の問い合わせでは通らない。** 問い合わせ側の story 軸は常に「利用不可」である（`retrieval_admission/query_context.rs:195-197`）。解決済みの secret の scope は story 軸の値を持ち、Scene の物語内の時間が未設定なら未解決になる（`human_materialization.rs:430-438`、`src-tauri/crates/grimodex-core/src/narrative_project_scope_authority.rs:312-314`）。§2 の R2 と ★4 の推奨をそのまま当てると、通る版は 0 件になる。story 軸を判定から外せば通るが、今より緩くなる。
- **Scene を足すたびに、後ろの secret の版の資格が切れる。** reading rank は Scene の並びの順番である（`narrative_project_scope_authority.rs:308-311`）。secret の投影の検証はこの順位を含む（`narrative_scope_dependency_projection.rs:135-136`）。前方に Scene を足すか消すと、後ろに reveal を持つ secret の版は検証に合わなくなり、新しい子の版と再承認が要る。非 secret の版は順位に依存しない。
- **閉じている箇所は §1 の 5 つより多い。** secret の投影を拒む箇所がもう 1 つある（`scene_scope.rs:2149-2153`）。
- **年表側の露出。** 非 secret の出来事は、今の Scene より後のものでも AI から隠されない（`src/features/chronicle/chronicleSecrecy.ts:76`）。この判定を通るのは、chat の agent の tool と、年表の snapshot（`src/features/chronicle/chronicleSnapshot.ts:400`）である。2026-11-09 に承認された「Scene に結ばれた出来事には、今の Scene より後を除く filter」は chat の `search_events` の設計で、未実装である。
- **評価が通った経路。** 第 6 版の harness は、製品の API（`reviseChronicleProposal({secret:false})`）で子の版を作って承認した（records の `design.condition`）。884 件と 551 件が成功している。

**レビューの見込みのままの点（未確認）**
- 「まとめて承認」専用の Native の操作を足しても、版の系譜の検証（`material_membership/lineage.rs`）で合わなくなる。
- legacy の `project-scope-authority` の control は secret の印を持たないので、R3 に拒否を明記する必要がある。
- 用途で分ける規則（R7）には、問い合わせの関数への用途の引数と、根拠の再検証への束縛が要る。
- 評価の cold oracle（`examples/nir1_retrieval_cold_oracle.rs`）は同じ判定を共有するので、挙動が変わる。§4 の「評価の資産は変えない」は言い過ぎである。
- reveal を別の Scene に動かせない可能性と、適用済みの提案には子の版を作れないこと。

**帰結**
- 「secret のまま通す」方向は、版の分類と系譜の契約（または抽出の経路）の変更、story 軸を判定から外す規則、Scene を足すたびの再承認、の 3 つを伴う。
- もう 1 つの方向は「secret を外した子の版をまとめて作って承認する」である。既存の経路だけで済み、開示の判定は変わらない。代償は、年表に取り込むとその出来事が秘密でなくなることである。
