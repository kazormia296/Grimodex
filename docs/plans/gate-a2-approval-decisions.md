# Write-Safety Gate A A2 判断記録（起案）

- 状態：**確定**（2026-11-28、利用者の回答。contracts の問 36「この範囲で確定」）。第 6 節の脅威モデルと第 3 節の設計。交換の service は #1232 で実装（呼び手なし）。実接続と実機の検証は未実施。
- 前提：Gate A の判断記録 DR-GA-3・6・7 と第 7 節の回答は確定事項として扱う。1 件ずつ承認し、削除は毎回承認する。画面操作の 3 本は承認なし。AWA/1 と同じ main の承認・Capability 方式を使い、Mastra 組込み承認を認可に使わない。承認待ちは 30 分で失効する。承認要求と `target_basis` は A3 の Interaction に保存し、保存済み承認を認可に使わない。
- 基点資料：Gate A 判断記録、ADR 008、A3 判断記録、AWA/1 起案、2026-11-28 の A3 port 型案。
- 実装・他文書の変更は行わない。

## 1. 範囲

Roadmap Gate A の A2、つまり AI の `mutate`／`destructive` 呼出しを、main が承認確認後にだけ一回限りの Capability へ交換する境界を決める。renderer executor にも承認前の dispatch を拒ませる。A1 の分類は DR-GA-6 を使い、`run_app_command`・`apply_layout_preset`・`propose_setting_change` は `ui / none`、`propose_scene_body` は `stage / none` のままとする。

Gate C／Release B の Task Grant、Gate B の Agent Auto、stage の accept／適用（Roadmap A3）、不正 AI policy の fail-closed 実装（Roadmap A4）、AWA/1-2 の MCP 経路、製品公開は本書の実装範囲に含めない。ただし A4 は、承認時に policy を安全に再検証して A2 を有効にするための前提とする。Task Grant が導入されるまでは、`mutate / task-scope` も個別承認する。

## 2. 確かめた事実

- ADR 008 §3〜5 と Invariants 2〜6 は、`mutate`／`destructive` の無承認実行禁止、承認確定後の Capability 発行、main での再検証、一回限りの使用を定めている。§9 は、不正 AI policy を書込み不可にする。
- 現行 main は provider 応答を受けた時点で変更系 15 tool の Capability を発行する。発行時に sender、project、tool／call ID、入力 digest、policy 等を束縛し、現行 TTL は 5 分。one-shot 消費時は検証前に token を削除し、不一致でも再利用できない（`electron/main/ipc.ts:238-295,1643-1731,1733-1775`）。
- 現行 `mastraTurnOwner` は `apply_ai_tree_plan` と `propose_scene_body` を UI tool 経路へ渡し、`update_codex_entry` の版をその書込み処理中に読む（`electron/main/mastraTurnOwner.ts:1575-1585,1621-1635`）。事前の事実調査では `apply_ai_tree_plan` の対象版取得と OCC 照合は未確認とされている。
- renderer の `agentLoop` は Capability が無い場合にも `executeTool` を呼ぶ（`src/features/chat/agent/agentLoop.ts:315-320`）。`executeTool` は writer を選んで呼び出すが、承認なしの protected call を入口で拒む検査は確認できなかった（`src/features/chat/agent/toolExecutors.ts:1341-1382`）。
- 現行 turn slot は turn が終了し、Native と read の処理も idle になるまで解放されない（`electron/main/mastraTurnOwner.ts:578-583`）。workspace identity の置換は `forceAbort("workspace-switch")` を呼ぶ（同 `:2219-2231`）。現行経路には承認待ちの実装がなく、待機中の slot 挙動はまだ実測できない。
- A3 の DR-A3-2・3・5・6・9・14・18 は、会話ごとの active Run を 1 件、root ごとの pending Interaction を 1 件に制限し、30 分 timeout 後は Run を中断して `pending` を残すこと、再開時に保存済み承認を認可に使わないこと、workspace／profile 切替・quit の中断処理を定める。2a の index は変えず、Release B 版で差し替える（DR-A3-18）。
- A3 port の型案では `targetBasis` は新規作成なら `null`、既存対象なら 1〜64 件・全体 32 KiB までで、各件は保存対象種別・`sourceId` と `version` または `contentHash` のどちらか一方を持つ。port 本体は A3 PR 4 で入り、型は変わりうる。
- [AWA/1 起案](nir1-agent-event-write-approval-proposal-1-draft.md)の A3〜A7 は main が承認要求を作り、承認時に policy・対象・引数を再検証し、新しい one-shot Capability に交換する。A13 は AI への固定応答、A16 は owner／lifecycle を定める。本書はこの main authority の形を参照するが、AWA/1 の一時 map、作者の出来事専用 probe、MCP 経路は A2 に持ち込まない。

## 3. 判断案

- **DR-A2-1 main を唯一の承認 authority とする。** 応答時に `mutate`／`destructive` の実行 Capability を出さない。main は A3 `approval` Interaction を開いて判断を待ち、承認後に限り、既存の main-owned binding を保つ one-shot Capability を新規発行する。Mastra runtime は待機・再開の運び手に限る。
- **DR-A2-2 一つの tool call ごとに承認する。** `mutate / task-scope` は Task Grant がまだ無い間も個別承認、`destructive / always` は常に個別承認とする。削除要求をまとめて免除する経路は置かない。
  - 承認の対象の 14 本（2026-11-28 の追記）：`create_codex_entry`・`update_codex_entry`・`create_foreshadow`・`update_foreshadow`・`create_snippet`・`create_event`・`update_event`・`delete_event`・`stamp_scene_event`・`unstamp_scene_event`・`set_event_participants`・`add_event_relation`・`remove_event_relation`・`apply_ai_tree_plan`。この一覧は manifest の分類（DR-GA-6）による技術判断で、コードの定数（`agentApprovalProtectedTools.ts`）と試験で固定する。利用者の問いが名指ししたのは、Codex の項目と出来事を作る・直すこと（contracts の問 40）と、章の構成の一括変更（問 36）。伏線・スニペットの作成、結び付けや関係の操作は問いに名指しが無く、2026-11-28 に画面の本文で伝えた。
- **DR-A2-3 承認要求は A3 Interaction と同時に待機状態へ移す。** main は対象の表示内容と同じ snapshot から入力 digest と `target_basis` を作り、Run を `running → waiting_approval`、Interaction を `pending` に同一 transaction で記録する。`interaction_id`、`tool_call_id`、tool 名、digest、project／sender／Run の束縛を維持する。target の本文は `target_basis` に保存せず、承認要求を A2 独自の永続表へ二重保存しない。
- **DR-A2-4 Capability 交換時に全束縛を再検証する。** main は承認を受けた時点で Run が生きていること、sender／project／workspace、tool と canonical args digest、未使用状態、現在の policy、対象の `target_basis` を再確認する。順序は再検証、A3 Interaction の `approved` 記録、one-shot Capability の発行と台帳への発行記録、Capability の使用、実行結果の記録とし、台帳への発行記録に失敗した Capability は使わない。どれかが欠ける・異なる・期限切れ・二重回答なら fail-closed とし、Capability を出さない。対象変更は自動 rebase せず Interaction を `superseded` にし、AI に提案し直させる。
- **DR-A2-5 対象版を読めなければ承認要求を開かない。** 既存対象は main が現在の `version` を読み、版のない対象に限り main が読んだ保存内容の canonical hash を使う。いずれも取れない対象は承認不能として書込みを止め、待機後に読めなくなった場合も `superseded` にする。モデルや renderer が渡す版・hash を根拠にしない。14 本すべてで `version` または `contentHash` のどちらかが取得できることを確かめてから、この判断を確定する。保存対象種別は tool 名と区別して表す。A3 port の最終的な種別語彙は未確定とする。
- **DR-A2-6 承認・質問待ちの間も turn の枠を持つ。** Gate A に子の Run は無いため、A2 は Gate A の判断記録第 4 節と DR-A3-9 に従い、承認・質問を待つ間も元の turn slot を保持し、30 分で切る。A3 DR-A3-2 の会話ごとに active Run は 1 件、DR-A3-3 の root ごとに pending Interaction は 1 件という制約を前提にする。2a の index は変えず、Release B 版で差し替える（DR-A3-18）。Release B では、返事を待つ間も同じ依頼の「ほかの手順は進める」と利用者が回答した（2026-11-28、contracts の問 32）。進める方式（子の Run、turn の枠の持ち方）は Release B で決める。
- **DR-A2-7 Stop だけが pending を取り消す。** Stop を受けた Run は `cancelled` とし、その pending Interaction も `cancelled` にして live wait を解き、Capability 発行を拒む。workspace／profile の切替、quit、30 分 timeout では Run を `interrupted` にし、pending Interaction は残す（DR-A3-5・DR-A3-14）。持ち越さないのは Capability と交換状態だけであり、保存済み `approved` は新しい live 承認なしに実行の認可へ使わない。
- **DR-A2-8 executor でも protected dispatch を拒む。** renderer executor は manifest の `mutate`／`destructive` 呼出しに main が返した有効な Capability がない場合、writer／IPC を呼ばず固定の失敗結果を返す。pending marker やモデルの `approved`、保存した Interaction の resolution は executor の許可条件にしない。main と Native の既存検証は別に維持する。
- **DR-A2-9 A4 と A3 がそろうまで protected write を有効にしない。** A2 は承認要求と交換の両方で現在の AI policy を確かめる。A4 の invalid parse fail-closed と A3 durable port の実体がない間は、fake port での開発・検証だけを許し、製品経路の書込みを開けない。承認後 Capability の TTL は AWA/1 の A7 と同じ 60 秒とする。これは現在の 5 分より厳しい期限であり、承認待ちの 30 分とは別である。

- **DR-A2-10 事実の確認（2026-11-28、技術判断）。** `apply_ai_tree_plan` は ops 全体を Native の 1 つの transaction で適用し、利用者の確認画面は今は無い。承認は `tool_call_id` ごとの 1 件（plan 全体）とする。`target_basis` は plan が触る node の版で、main が読み直す（renderer が渡す版を根拠にしない）。64 件か 32 KiB を超えるときは、触る node の版をまとめた内容の hash 1 件にする。変更系・削除の 14 本のうち main が今、版を読むのは `update_codex_entry`・`update_event`・`delete_event`・`set_event_participants` の 4 本で、残りの既存対象も保存内容の列があるので hash を作れる見込み（今の経路には hash を作る処理も照合も無い。読み口と照合を実装で足し、14 本すべてで確かめてから DR-A2-5 を確定する）。新しい経路（旗 L）では、承認待ちの turn が main の turn の slot（全体 8、sender ごと 4）と renderer の IPC の同時実行の枠（全体 4）を持ち続け、枠が埋まると後続の IPC と workspace の切替が待つ（Gate A の第 4 節のとおり。受け入れる残りに含める）。

- **DR-A2-11 `target_basis` の語（技術判断）。** `sourceKind` は保存する対象の種別で、`codex_entry`・`foreshadow`・`snippet`・`event`・`scene_event_link`・`event_relation`・`tree_node` を使う。`set_event_participants` と `add_event_relation` は関係する `event` の版を載せる。`apply_ai_tree_plan` で 64 件か 32 KiB を超えるときは `sourceKind=tree_node_set`、`sourceId=projectId`、`contentHash` は触る node の（ID、版）を ID の順に並べた canonical JSON の SHA-256 の 1 件にする。足りない語が出たら本節に足し、A3 の担当に知らせる。

- **DR-A2-12 台帳の状態（技術判断）。** 台帳の行は記録の側が応答の時点で追記し（A3 の DR-A3-4）、交換は、状態と、発行の時の `mainOwnedProvenanceId` を書き足す。承認の待ちの間は capability を `awaiting_approval`、発行で `issued`、実行の後は `consumed` と実行の状態。却下と `superseded` は実行していないので実行の状態を `failed` にする。時間切れと中断は台帳を変えない（Run の側）。
- **DR-A2-13 承認の時の版を main が束ねる（技術判断。#1232 で照合と束ねを実装。main の対象の読み口は未実装で、製品の呼び手も無い）。** 承認の時に main が読んだ版と期待状態を、交換由来の Capability の record に束ね、消費の時に main が payload を上書きする（画面とモデルの値を使わない）。モデルが版を引数で渡す tool は、承認を開く前に main の読みと一致することを確かめる。呼び手が渡す応答の時点の対象と、開く直前の読みが違えば開かない。版を要る tool で版が無ければ開かず束ねない（`apply_ai_tree_plan` は作成だけの plan なら版は不要。create・move・rename のほかの op と、形の分からない op は拒む）。Stop と失敗の記録で、未消費の Capability を失効させる。
- **DR-A2-14 版の列の無い対象（技術判断、問 36 の範囲内）。** `stamp_scene_event`・`unstamp_scene_event`・`add_event_relation`・`remove_event_relation` は、Native の writer が同じ transaction の中で期待状態（関係の有無と、関係する event の版など）を照らす。期待値を渡さない呼び手は今のまま。期待値は main が作り、画面の値は捨てる。 Native の照合は別の PR（M3 の担当）で、この記録の時点の master には未実装。
- **DR-A2-15 実接続の PR で必須。**（呼び手を付けるのは、DR-A2-14 の Native の照合が入ってから。）(1) 消費の直前（Native に渡す前）に AI の利用方針を読み直す（Native の writer は方針を読まず、今の main も発行の時にしか読まない）。(2) 画面の executor の拒否（DR-A2-8）。(3) 応答の時点の対象を呼び手が読んで交換に渡す。(4) 承認カードは何を書くか（今の値と新しい値）を示し、待ちの間に対象を開いて確かめられるかを実機で確かめる。(5) 同じ requestId の再送は同じ期待状態を送る（DR-A2-14 の Native の実装では、期待状態が request hash に入る）。(6) 実 main の往復の spec で、期待状態の欄が契約と Native を通ることを確かめる。(7) 交換由来でない呼び出しでも、画面が付けた期待状態を main が捨てる（今は交換由来の record だけが捨てる）。

- **DR-A2-16 承認カードの表示。** 書き換える欄は、今の内容と書き換え後の内容を並べて表示する。削除では、対象そのものと、一緒に消えるものをすべて示す。削除の影響を全件表示できる場合だけ承認ボタンを出す。この条件は、承認カードを出し直すときにも適用する。
- **DR-A2-17 出来事の削除の合格条件（contracts の問 43、2026-11-29）。** `delete_event` では、出来事の版に加え、参加者、場面との結び付き、ほかの出来事との関係（両方向）を、承認カードを開く時点で main が確かめる。既存の上限内で全件を確かめられない場合は承認要求を開かない。承認時と、削除を行う Native の transaction の中で、カードを開いた時点の状態と照合する。どちらの照合でも、出来事の版が変わった場合や、参加者・結び付き・関係に追加・削除・変更があった場合は、削除を実行せず、AI に提案し直させる。

## 4. owner と lifecycle

| 経路 | owner／開始 | 停止・失効 | error／再開・終端 |
| --- | --- | --- | --- |
| tool response と Interaction 作成 | main turn owner が対象 basis を読む。A3 port が Run と `pending` approval を同じ transaction で記録 | この時点で実行 Capability は無い | basis 不明なら Interaction を開かず固定エラー。二件目の pending は A3 が拒否し、同じ root Run の write は直列化 |
| 承認／質問の live wait | Interaction の owner は A3 recorder、live answer の受け口は main | Gate A では承認・質問待ちも turn slot を保持し、30 分で切る | 承認・質問への応答で元の checkpoint を再開。wait 自体を cancel／timeout signal で必ず settle する |
| approve／reject | main が `interaction_id` と sender／project／Run／tool call を束縛して受ける | 二重回答、別 sender、別 project、終了 Run は拒否 | `approved`／`rejected` を記録。保存 resolution 単独では発行しない。reject は固定 tool result で終える |
| approved write dispatch | 承認の後、main が digest／basis／policy／未使用を再確認 | policy off・project change・OCC mismatch は `superseded`。Stop は pending を `cancelled` にする。一度きりの Capability は既存 consumer で消費 | 確認成功後にだけ Capability を発行し、台帳の発行・消費・execution 状態を記録。失敗時は fail-closed |
| 30 分 timeout | main の有限 timer | wait を settle。Run は `interrupted (approval_timeout)` | Interaction は `pending` のまま。後の再開は A3 の gates を通し、保存承認を使わず新しい明示承認を求める |
| Stop | 該当 Run の owner | pending Interaction を `cancelled` にして live wait を解放。未消費 Capability があれば失効させる | Stop 後の承認・dispatch を拒む。Run 終端時は A3 の規則で `request`／`resolution` を空にする。Native dispatch 済み処理の終端 receipt は MP-6 の lifecycle で別途確認する |
| workspace／profile 切替、app quit | 該当 Run の owner | Run は `interrupted`。pending Interaction は残す | workspace／profile をまたいで live 承認を続けない。Capability と交換状態は持ち越さない |
| app restart／resume | A3 recorder が durable Run／Interaction を保持。main が再開時に gates と basis を再確認 | memory 上の Capability／交換状態は復元しない | Mastra 経路の Run は当面 `resumable=false` のため、再起動後に承認を出し直すのは legacy 経路だけ。target が変わった場合は `superseded` とし、保存した `approved` は認可に使わない |

DR-A3-9 の `ask_user` slot 保持を前提にする。Stop では pending Interaction が取消され、workspace／profile 切替・quit・timeout では Run が中断し pending Interaction を残す。2a の index は維持し、Release B 版に差し替える。

## 5. 影響と PR の分け方

| 順 | レーン | 対象／出口 |
| --- | --- | --- |
| 1 | A2 の main logic（fake port） | issuer／consumer を承認交換へ分け、Interaction port を引数に取る main service と負試験を作る。fake は開閉・二重回答・失効・CAS 拒否を再現する試験用で、製品の durable 性を主張しない |
| 2 | A3 port と wait lifecycle | A3 PR 4 の実 port に接続する。DR-A3-2・3 の active／pending 制約と DR-A3-9 の turn slot 保持に従い、Stop は pending を取消し、workspace／profile 切替・quit・timeout は Run を中断して pending を残す。2a の index を維持して Release B 版に差し替える（DR-A3-18）。port 型案の変更を吸収する |
| 3 | A2 の実接続 | main の対象版 resolver、UI card／answer 経路、executor fail-closed、tool result、A3 Interaction と台帳を結ぶ。AWA/1 は同じ main exchange と A3 記録を使うよう別 PR で合わせる。MCP は含めない |
| 4 | A4 の policy fail-closed | `missing` と `invalid` を区別し、invalid なら書込みを拒む。A2 の再検証との接続を確認する |
| 5 | Gate A activation | A2 実接続、A3 port／lifecycle、A4 の証跡がそろってから有効化し、その後 MP-6 を接続する。A2 完了前に flag L を開かない |

A3 PR 4 より前に進められるのは、main の pure decision／exchange logic、executor の拒否条件、fake port を使う race／failure の確認まで。Recorder transaction、再起動後の durable resume、port が保証する `target_basis` の保存は fake では受け入れない。Mastra 経路の Run は当面 `resumable=false` であり、再起動後の承認の出し直しは legacy 経路だけとする。A4 前は policy が欠けた場合も含めて拒否し、製品の書込み path を有効化しない。

## 6. 脅威モデルへの影響

次の境界で確定した（2026-11-28、contracts の問 36）。広げる、減らす、残りが変わる場合は、利用者に改めて確認する。

- **信頼する主体：** main の承認 owner、A3 recorder が記録する Run／Interaction の同一性、Native writer の既存 Capability 検証。利用者の approve は、その場の一回限りの判断として main が受け取る。
- **信頼しない入力：** provider／model の tool name・arguments・approval 表明、renderer の state／target version／project 値、復元した `approved` resolution、Mastra の `resumeData`。これらだけで認可しない。
- **対象内の攻撃：** renderer executor の直接呼出し、偽造・再利用・二重決定、承認中の対象／project／policy 変更、読めない版、Stop／workspace 切替後の遅い answer、再起動後の承認 replay、tree plan basis 上限超過。
- **対象外：** MCP AWA/1-2、Task Grant の永続化・範囲変更、製品公開、画面操作 3 本への新たな承認、stage 提案作成。本文の提案の適用（accept）と、`ai.autoAcceptBodyProposals`（作品ごと、初期 off、bodyWrite の方針が on のときだけ。ADR 008 §3 が維持する opt-in）による自動適用は、承認なしで本文を書き換える今の動きのまま対象外（2026-11-28、利用者の回答「今のまま」）。A4 の実装は対象外だが、A4 完了前に write path を開けない。ボタンで作者が始める AI 生成（結果をそのまま適用する構成の再編を含む）も対象外のまま（2026-11-28、利用者の回答「対象外のまま」、contracts の問 42）。
- **受け入れる残り：** main は承認 IPC の呼び手が人かどうかを区別できない。乗っ取られた renderer は範囲外とする（ADR 008 の 2026-11-23 追補 §6）。Mastra 経路の Run は当面 `resumable=false` のため、再起動後の承認の出し直しは legacy 経路だけである。承認待ちは turn の中の待ちなので、今の製品の経路では生成中の turn がアプリ全体で 1 つ（`turnCoordinator.ts`）のため、待つ間はほかの会話にも送れない。新しい経路（旗 L）では main の turn の slot と renderer の IPC の同時実行の枠を持ち続け、枠が埋まるとほかの処理と workspace の切替が待つ。どちらも 30 分で中断する。旗 L は、承認待ちからの出し直しと、生成の途中からの再開の両方がそろってから開ける（2026-11-28、contracts の問 42。切り替えの許可ではない）。
- **必須防御／受入れ：** 承認前 capability なし、renderer と main の二重 gate、交換直前の digest／project／policy／basis 再検証、one-shot 消費、読めない basis と stale basis の拒否、保存 resolution を認可に使わない、Stop が pending を取消すこと、workspace／profile 切替・quit・timeout で Run を中断して pending を残すこと、30 分で live wait が終わること。どれかの負試験が欠ける状態では A2 を完了扱いにしない。
- 新しい data recipient、secret の送信先、永続保存範囲は提案しない。承認要求・判断・`target_basis` は A3 Interaction 内に限定する。

## 7. 利用者に確認した点

回答（2026-11-28、contracts の問 36）：脅威モデルと画面の変化を問いに示し、「この範囲で確定」。回答は、この境界と設計への回答である。

## 8. 採らなかった案

- model response 時点で Capability を発行し、後から承認で守る：承認前に main の認可 token が存在し、ADR 008 §4 と一致しない。
- renderer の確認 UI だけで書込みを止める：renderer から executor を迂回でき、main の authority 境界にならない。
- Mastra 組込み `requireApproval`、model の `approved`、resume data、保存済み resolution を認可に使う：main の再検証と one-shot Capability を置き換えられない。
- A2 の承認・質問待ちの間に turn slot を解放し、Gate A で別 Run を進める：Gate A に子の Run はなく、Gate A 判断記録第 4 節と DR-A3-9 の turn slot 保持に反する。ほかの手順を進める方式は Release B で決める（同じ依頼のほかの手順を進めることは問 32 で回答済み）。
- target basis の取得失敗を `null`／空配列として通す、64 件超を黙って切り捨てる、承認後に自動 rebase する：対象の変更を見逃す。
- Gate A に Task Grant、A4 の実装、MCP 経路、製品公開を混ぜる：別の gate／lane の authority と順序を越える。

## 9. 未確認

- `apply_ai_tree_plan` の版を main が読み直す読み口（承認の単位と hash の扱いは DR-A2-10。1 transaction の適用と Native の版の照合は事前の確認で読んだ）。
- A3 port の最終保存対象種別語彙、Interaction の再開 API、保存済み `approved` を再表示して新しい live 判断にする具体的 transaction。port 案は A3 PR 4 まで変わりうる。
- Release B で、返事を待つ間に同じ依頼のほかの手順を進める方式（進めることは問 32 で回答済み）。
- Release B の「まとめて任せる承認」で、新規作成をどう扱うか（SessionTasks の起案の持ち主が利用者に伺う）。
- 現行 SessionTasks scheduler の turn slot 保持、wait 再入時の所有権、Stop・workspace／profile 切替・quit・timeout 後の wait settle 証跡。現行調査では承認待ち経路は未実装。
- A4 の fail-closed policy parser と、A2 交換時の実 policy reread がつながった証跡。
- 全ての既存対象種別について、要求表示時と承認時に同じ `version`／canonical `contentHash` を main が読める API。Codex／event 更新の一部に版読取りの証拠はあるが、15 tool の対象種別は全面確認していない。
- 実接続、実機と runtime の検証は未実施（交換の service の単体の試験は #1232）。本書は A2 の実装の完了または A3／A4 の完了を主張しない。
