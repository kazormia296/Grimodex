# NIR-1 D2a 契約提案 nir1-d2a-activation-proposal/1（draft）: activation と restricted 下の route 区分

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-d2a-activation-proposal/1` |
| contractId | `caller-profile-egress`（`nir1-l6-l9-contract-proposal/3` で確認済みの行の差分） |
| 起案日と基点 | 2026-10-12 起案、2026-10-13 改訂（S3 rev 2、S1、K1 の確認、独立レビュー3回目までを反映）。origin/master `a153743b`（Tree `023f6fbc`）。`l6-l9:N` は [L6〜L9 実行計画](nir1-l6-l9-execution-plan.md)、`post-B:N` は [残工程実装計画](nir1-post-b-execution-plan.md) のこの commit での行番号で、コードの行番号も同じ commit のもの。[DSN](nir1-dsn-2026-10.md)（未 commit。独立レビュー1回目の反映版）は節で引く |
| 根拠にした spike | S3 rev 2（D2a を restricted にした試走で、既存の経路と product journey の破損を棚卸しした）と S1（G-01 の非 Graph 部分の実測。計測の arm が使う route と、Chromium の spellchecker が辞書を外から取得していたことも報告した。S1 §7.1、§8）。どちらも `a153743b` で行った診断で、報告は作業記録に置く。この draft には要点、試験の記号（S3 の T1〜T13 など）、コードの行番号だけを写す |
| 確認済み baseline | `nir1-l6-l9-contract-proposal/3#caller-profile-egress`（l6-l9:121-130、台帳 l6-l9:98。#576 `63d6f6d6` から `a153743b` まで本文は変わっていない）。その前提の D2a 節（l6-l9:516-524）、経路台帳（l6-l9:62-75）、profile の状態遷移（l6-l9:77-87）、初期版の AI 経路（l6-l9:536-549）と、R0 で選択済みの「profile全体の永続local-only」（l6-l9:37、379） |
| 確認を求めるもの | activation の trigger と開示、activation の順序（grant の消費を最初の段に置く）と起動時の gate（DA-2 の待ちの上限、状態ファイルの受理条件の統一、unavailable の理由の表示を含む）、activation の途中の AI 処理の終わらせ方、restricted 下の route 区分とその構成（NIR の適格平文を通し、外部と旧経路を閉じたままにする）、restricted で閉じる既存機能への対処（S3 の結果による M・T・D の分類と、M と T を直すまで activation の UI を公開しないこと）、license の確認通信の扱い（key の検査と、proxy と redirect を使わないこと）、app の code が始めない Chromium 自身の通信（spellchecker の辞書の取得）の扱い、「一方向」の範囲と状態ファイルの扱い、受入れ（R の parity の測り方と、restricted の試走で記録するものを含む） |
| 変えないもの | 外部 AI、旧 send、CLI、Codex App Server、MCP、外部 URL（license の3 command を除く。L-1 で `license-control` へ移す）、Vivliostyle、接続試験の拒否。解除の操作を設けないことと、分離 profile を扱わないこと（l6-l9:524、618）。proposal/3 のほかの行、`graph-limited-binding`、`nir1-defensive-resource-limits`（K1b）、K2（本文の開示と宣言）、K4、K5（local 送信と同意）、K6。Graph と local 送信の公開条件（l6-l9:431-432）と公開時の承認（Session C-1、C-2）。Gold、P、24 件、G-01〜G-08。unrestricted での R／IR と A2 の既存の挙動。状態ファイルの形（schema v2）。新しい authority、保存先、data category は加えない |

## 要点

- activation は、利用者の明示操作の後、Main が Native の表示文で出す確認 dialog（既定は取消）と、一回限りの grant（ProfileActivation）の消費を経たときだけ起こす。開示には、profile 全体に及ぶこと、アプリの操作では解除できないこと、状態ファイルの削除や別の profile では制限が外れること、閉じる機能と続く機能を含める。製品の UI は PUB-G まで閉じる。
- 順序は l6-l9:520 の前に grant の消費を置き、「grant の消費 → Main の同期閉鎖 → main participant の停止 → restricted の永続化 → Native の停止 barrier → Main の更新 → caller の再登録と新しい区分の開放」の7段に固定する。消費を最初に置くので、期限切れなどで消費できなければ何も閉じない。participant の停止と停止 barrier の drain は、それぞれ 30 s 以下の上限で fail-closed にする。in-flight の stream と非 stream の旧 AI 要求は activation が取り消し、renderer の表示は終端 event を待たずに終える。Main が閉じた後に完了した旧 AI と平文の結果は返さない。
- restricted 下で、NIR の適格平文（Related Scenes の R／IR／Graph、A2 review、D-final、宣言 UI）を、main が発行した登録済み caller と Native の再認可を条件に通す。そのために `nir1-publication` と `nir1-restricted-only` の2区分を置く。外部 AI、旧 send、CLI、Codex、MCP、外部 URL（license を除く）、Vivliostyle は閉じたままにする。この差分の local-only は制限対象の平文を外部へ送らないことを指し、平文を運ばない license、更新、model と IME 辞書の download、Chromium の spellchecker の辞書の取得（app の route を通らない。X-1）の通信は続く。restricted 下の R が unrestricted と同じこと（R の parity）は、DA-1 が評価 harness を restricted に対応させて測る。
- S3 では、restricted だけで失敗した renderer API が 36 件中 23 件、汎用 select が 143 表中 59 表で、product journey の PASS は 30 件中 5 件（baseline は 29 件）だった。原稿の本文の保存と workspace の操作は動く。基本操作（M）と、平文と関係なく汎用 SQL の形で壊れる機能（T）は平文を開かずに直し、直すまで activation の UI を公開しない。それ以外（D）は閉じたまま、restricted の理由を UI に示して開示する（O-1）。D に日常の機能が入ったので、自分のデータの表示を restricted でも残す O-2 を /2 として起案し、同じ Session B に並べることを推奨する。
- 状態ファイル（`profile-egress.json`）を消すと、次の起動で unrestricted に戻り、制限中のデータも旧 AI の経路と汎用 SQL から読める（S3 の T12）。これは同じ OS ユーザーの操作として防御の対象外のまま、開示に事実どおり書く（F-1）。Native が受け付けて Main が unavailable にする状態ファイルの食い違いは、受理条件を一つにして無くし、unavailable には理由を示す。
- license の確認は、平文を運ばない route として restricted でも続ける（L-1）。renderer が渡す activate の key は Native が送信の前に形式と長さを検査し、restricted の通信は proxy（env と OS の設定）と redirect を使わずに `https://api.polar.sh` の固定の3 path へ直接つなぐ（N-1）。

## 確認の扱い

- 確認は末尾の「確認文」の 1 文で行う（l6-l9:108）。この 1 文で確認されるのは `caller-profile-egress` のこの差分だけで、依存する契約（K2、K4、K5、K6、`graph-limited-binding`、`nir1-defensive-resource-limits`）は確認されない。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答は、確認として扱わない。
- 確認文で確定するのは、「選択肢と推奨」の推奨案（T-1、R-1、S-1、V-1、O-1、L-1、N-1、F-1、J-1、W-1、P-1、X-1）と、DA-2 の待ちの上限（「順序と起動時の gate」の「待ちの上限」）である。別の案を選ぶときは、新しい draftRef（/2）で起案する。
- この差分の確認は、Graph の公開、activation の UI の公開、local 送信を許可しない。activation の UI と開示の文言は Session C-1（PUB-G）で、local 送信は K5 と Session C-2（PUB-L）で、別に承認を得る。
- S3 rev 2 と S1 の結果は、この draft の分類、受入れ、開示に反映した。確認の対象は、区分の規則、M・T・D の規則と「restricted で閉じる既存機能への対処」の表の分類、受入れである。表にない機能が後で見つかったら、DA-1／DA-2 が同じ規則で分類して記録する。M か T に当たれば activation の UI の公開の前に直し、D に当たれば Session C-1 の開示に加える。規則で分類が決まらない機能は `[precheck]` で止める。
- K1（`nir1-l6-l9-contract-proposal/6`）は、2026-10-12T23:58 JST に `graph-limited-binding` と `nir1-defensive-resource-limits` の2文で確認された（draft の SHA-256 `5528f4e091ca087c0f1e071039c6bcede9d3d7cde1422ac1bfd852ee1d8d6b4b`）。この draft は K1b の規則を参照するが、K1b の範囲は広げない（「待ちの上限」）。
- 確認された場合は、この draft の bytes の SHA-256 と確認文を台帳に記録する。本文は編集しない。

## 根拠: ユーザー決定（逐語）

2026-10-12 のセッションで、構造化質問に対するユーザーの回答から、ユーザー自身の文言を写す。「読み方」は起案者の解釈で、ユーザーの発言ではない。

| ID | 話題 | 回答（逐語） | 読み方 |
| -- | ---- | ------------ | ------ |
| U1 | 2026-09-25/26 の承認と WIP | 「使わずに計画し直す」 | 9/25 の draft の文面と承認は使わない。この draft は `a153743b` のコードと確認済みの proposal/3 から起案した。9/25 の draft は論点の確かめにだけ参照した |
| U3 | #610 型の技術委任を NIR-1 の残レーン全体へ広げる案 | 「1でRalphを使ってやるかどうかは任せます。」 | DA-1／DA-2 の実装の形（command の名前、projection の field、lifecycle の細部、この draft が定める範囲の内での待ちの上限の値）は、委任の範囲で integrator が記録して決める（G0 で AGENTS.md と iron-laws.md に反映する）。製品認可の意味、一方向の状態遷移とその起動、restricted 下の送信先は委任の外なので、この draft で確認を求める |
| U4 | 到達点 | 「merge まで進める」 | DA-1／DA-2 を merge まで進める前提で、確認の往復が増えない構成にする |

「profile全体の永続local-only」（l6-l9:379）は R0 の選択の記録で、このセッションの発言ではない。K1 の確認（2026-10-12T23:58 JST）はユーザー自身の入力で、2文の逐語は作業記録にある（「確認の扱い」）。

## 現状（`a153743b` のコードと S3 rev 2）

pe.ts は `electron/main/profileEgress.ts`、pe.rs は `electron/native/grimodex-node/src/profile_egress.rs`、lib.rs は `electron/native/grimodex-node/src/lib.rs`、index.ts は `electron/main/index.ts` を指す。S3 の記号は S3 rev 2 の試験を指す。

1. activation の製品経路がない。`activateFirstRestrictedPublication`（pe.ts:808-883）と Native の `activate_profile_egress`（lib.rs:6556-6563）を呼ぶのは試験だけで、新しい profile は unrestricted で始まる（pe.rs:166-174）。このため製品では `assertInvoke` が常に検査なしで返る（pe.ts:676）。
2. `plaintext-publication` は、unrestricted では検査なしで通し（pe.ts:676、723）、restricted では invoke の時点で拒否し（pe.ts:700-711）、制限の開始の後に完了した結果も拒否する（pe.ts:714-728）。D2a を成立させると、この区分の機能はすべて閉じる。Related Scenes（pe.ts:114、116-117）、A2 の typed reader（pe.ts:63-65）、Raw の sparse に使う `fts_search`（pe.ts:113）、Raw の dense に使う `semantic_search`（pe.ts:110。listener がないときの退避と、評価の R arm が使う非 hybrid の R。`src/features/related-scenes/fetchNir1RelatedScenes.ts:181-192`、`src/features/related-scenes/fetchRelatedScenes.ts:88-109`）、A2 review の再開に使う `narrative_extraction_list_resumable_runs`（pe.ts:134）も、この区分にある。非 hybrid の R は dense の失敗を空の結果に退避するので、restricted では R が空になる（fetchRelatedScenes.ts:93-100）。
3. 汎用 DB では、protected 表（会話、prompt、review、audit、AI の出力、伏線、プロット、lint、ゴミ箱、版、snapshot など。`src-tauri/crates/grimodex-db/src/profile_egress_policy.rs:19-104`）に触れる SQL は、読取も書込みも `plaintext-publication` になる（pe.ts:419-466）。restricted では Native の SQLite authorizer も、protected 表の読取と DML を拒否する（lib.rs:9095-9114、`src-tauri/crates/grimodex-db/src/execute.rs:409-454`）。DML が結果行を返す形（RETURNING）は表を問わず拒否し（execute.rs:985-990）、protected 表を親に持つ FK の検査も親の読取として拒否される（S3 の T3）。
4. activation の流れ: Main が同期で閉じ（pe.ts:818-819）、main participant（CLI AI、Codex App Server、license の確認、Vivliostyle。index.ts:497-509）を止め（pe.ts:823-842）、Native が epoch を進めて caller の登録を消し、permit を失効させて restricted を永続化し（pe.rs:196-225）、停止 barrier（chat、inline、post-effect の取消、dispatch の drain、停止の永続化。lib.rs:6457-6504）を行い、Main が identity を消す（pe.ts:868-873）。失敗したら、その process は unavailable になる（pe.ts:874-877）。activation の途中は caller を登録しない（pe.ts:656-671）。activation の側では、participant の停止と dispatch の drain の待ちに上限を置いていない（participant の中の停止の期限は participant ごとに異なる）。
5. 起動時: backend の構築の直後、CI seam、workspace の event、scheduler、renderer より先に gate を作る（index.ts:115-118）。restricted なら停止 barrier をやり直し、終わるまで caller を登録しない（pe.rs:231-256）。状態ファイル（`<appData>/profile-egress.json`。`electron/native/grimodex-node/src/state.rs:2761`）がなければ unrestricted、壊れているか版が不明なら restricted で停止未確認として始まる（pe.rs:135-176）。
6. Native の再認可: `begin_dispatch`（登録済み caller、revocation generation。pe.rs:299-331）、`with_authorized_dispatch`（workspace の一致。pe.rs:404-437）、`with_authorized_preparation`（restricted かつ停止済み、登録済み caller、workspace。pe.rs:442-467）。Related Scenes と A2 の reader は caller identity を Native へ渡さない（lib.rs:11604-11612、11741-11770、`electron/shared/ipcContract.ts:8117-8173`、8210-8239）。
7. D-final の capture は、unrestricted では何もせず（lib.rs:14567-14569）、restricted では登録済み caller と workspace を Native が確かめる（`electron/native/grimodex-node/src/nir1_prepared_request.rs:618-633`）。宣言 UI（`narrative_scene_scope_*`）は internal で、Native は workspace だけを確かめる（lib.rs:11876-11925）。
8. event の allowlist は全窓への broadcast を前提にしている（pe.ts:474-491、768-779）。restricted では `chat:stream-*` などを止める。
9. MCP は tool の呼出しを常に拒否する（`src-tauri/crates/grimodex-mcp/src/server.rs:638-640`）。製品の renderer は CSP で外部へ接続できない（`connect-src 'self'`、`img-src 'self' data: blob:`、`form-action 'self'`。`electron/main/protocol.ts:28-32`）。
10. license: restricted では定期確認を始めず（index.ts:487-493）、`activate_license`／`revalidate_license`／`deactivate_license` を external-url として拒否する（pe.ts:77-79。同じ3 command が `INTERNAL_COMMANDS` にも載っている。pe.ts:160、204、331）。release build は licensing を有効にする（`package.json:92`）。trial が終わると本文の編集が読取専用になり（`src/features/license/gate.ts:23-24`、`src/features/license/useLicenseEditableSync.ts:18-20`）、license を有効にする操作は restricted では拒否されるので、戻せない。license_stale のときに手動の再確認が失敗すると、理由を問わず制限が確定して編集が閉じる（`src/features/license/store.ts:82-92`、gate.ts:28）。
11. activation の途中の AI 処理（S3 の T5〜T7、T7b）: (i) in-flight の stream は Native が取り消して `*:stream-done`（stopped）を出し、invoke を Ok で返す。しかし Main は先に restricted へ切り替えているのでこの終端 event を捨て（pe.ts:768-779、`electron/main/events.ts:64-67`）、renderer の transport は invoke の reject しか待たないので、stream の表示と audit が終わらない（`src/features/chat/chatStreamTransport.ts:345-379`、`src/features/editor/inlineAi/inlineAiStreaming.ts:315`）。(ii) in-flight の非 stream の要求（agent、single-shot）は取消の仕組みがなく（lib.rs:14720-14725）、grimodex-ai には一般の HTTP の期限もない（`src-tauri/crates/grimodex-ai/src/lib.rs:577-581` は Ollama の metadata の期限だけ）。barrier の drain（pe.rs:363-374）はその応答を上限なく待つ（S3 では stub の保持が約 9.2 s と約 45.2 s のとき、activation の所要がそれぞれ一致した）。(iii) Main が閉じた後に完了した旧 AI の結果は、Main の完了時の再検査が `plaintext-publication` だけなので（`electron/main/ipc.ts:2436-2459`、pe.ts:714-728）、renderer に返る。(iv) barrier の間は汎用 SQL が全て拒否され、typed の command は通る（S3 の T7b）。
12. 状態ファイル（S3 の T12）: 削除すると次の起動で unrestricted（epoch 0、新しい profileId）に戻り、restricted で拒否されていた protected 表の平文が renderer の汎用 SQL で読め、旧 AI の経路も gate を通る。中身が `restricted:false` で停止の bit が unrestricted の値でない場合（schema v1、`handlesInvalidated:true` との組など）は、Native が受け付けて admission を開いたまま（pe.rs:136-155、177）、Main が不正として unavailable にし、汎用 SQL を全て拒否する（pe.ts:1274-1292、1311-1316、677-685）。restricted の profile で userData に書けない場合（起動時の barrier の永続化の失敗。pe.rs:244）と、状態ファイルを読めない場合（backend を作れない。pe.rs:175、`electron/main/backend.ts:175-188`）も unavailable になる（pe.ts:1297-1306、1335-1343）。unavailable では scene の tree も Drizzle で読むので project を開けない（`src/features/tree/api.ts:236-246`、`src/features/tree/treeStore.ts:609-613`。S3 では静的な追跡）。どの場合も理由は利用者に示されない。製品の writer は restricted の profile にだけ書き（pe.rs:196-289）、状態ファイルを消す経路はない。
13. restricted で壊れる既存機能（S3 の T3、T4、T9）: renderer の関数を実 router、gate、Native に通した試験では、baseline で成功した 36 件中 23 件が restricted だけで失敗した。Drizzle の汎用 select は 143 表中 59 表が restricted だけで失敗した。原因は、protected 表への汎用 SQL、RETURNING の一律の拒否、protected 表を親に持つ FK、`change_events.payload` を含む `select *`（pe.ts:402-417）の4つである。product journey は restricted で 30 件中 5 件だけ PASS した（baseline は 29 件）。失敗 25 件のうち 13 件は製品の拒否や破損で（うち agent の2件は、先に止まったのが protected 表を読む journey の oracle だった。S3 §5.2）、12 件は journey の oracle が renderer の `db_execute` で protected 表や PRAGMA を読むためだった。旧 AI の経路は dispatch の前に拒否され（`electron/main/ipc.ts:2164-2168`）、実 router、gate、Native を通した3 command（`list_ai_models`、`send_chat_message`、`send_chat_message_stream`）の provider への到達は、restricted で 0 件、baseline で 3 件だった（T13）。機能ごとの分類は「restricted で閉じる既存機能への対処」の表に置く。
14. 表示（S3 の T8）: restricted を renderer に伝える状態の IPC と文言がない（`src/locales/*.json` に該当の key がない）。renderer は error に含まれる marker を 7 file 8 箇所で検知して無言で縮退するだけである（`isD2aEgressDenied`。`src/lib/tauri.ts:27-51`）。このため、chat に生の marker が出る、Ollama 構成の chat が model の metadata を確認できないと誤って表示する（`src/application/chat/chatOllamaPreflight.ts:83-97`）、会話の履歴が空に見える（`src/application/project/defaultProjectLifecycle.ts:43-48`、233-238）、外部リンクや Codex のハイライトや版履歴が無言で欠ける、といった表示になる。
15. license の HTTP client（`src-tauri/crates/grimodex-license/src/lib.rs:446-458`）は、`no_proxy` も redirect の方針も指定していない。reqwest 0.13.4 の既定では、env の proxy と OS の proxy 設定（`system-proxy` feature）を使い、redirect を 10 回まで辿る。送信先は `https://api.polar.sh`（同 :419）の3 path（:508、546、584）で、body は key、組織 ID、端末の label、activation ID である。
16. restricted でも続く外への通信（app の route を通るもの）: 更新の確認と download（`updater_*`。pe.ts:372-374）、IME 辞書（Mozkey）の download と導入（pe.ts:272）、意味モデルの download（pe.ts:347）。意味モデルは、project を開いたときに model がなければ利用者の操作なしに取得を始める（`src/features/semantic-search/autoIndex.ts:165-193`。S3 と S1 の試走でも起動した）。どれも平文を運ばない。renderer から受け取る値は model の言語だけで、2つの固定の asset の選択にだけ使う（`src-tauri/crates/grimodex-semantic/src/spec.rs:185-191`）。app の route を通らない通信は次の 17 に置く。
17. Chromium 自身の通信（S1 §7.1）: 製品の `webPreferences`（`electron/main/windows.ts:176-183`）は spellcheck を設定せず、`electron/main` には spellchecker の言語や辞書の取得先の設定もない。このため Electron の既定どおり spellchecker が有効で、S1 では、残っていた新しい profile の4つすべてで、Chromium が Google の配信網（`https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic` と、その redirect 先の `r8---…gvt1.com`。QUIC）から辞書（profile の `Dictionaries/en-US-10-1.bdic`）を取得していた。製品の editor を開かない計測の起動でも取得した。送ったのは辞書ファイルの GET（と TLS／QUIC の handshake）で、原稿や認証情報は含まないが、接続元の IP は相手に届く。この通信は app の code が始めるものではなく、IPC の route 台帳（pe.ts）、renderer の CSP（9）、Native の gate のどれも通らない。S1 では env の proxy（`HTTP(S)_PROXY`、`ALL_PROXY`）でも止まらなかった（GNOME の proxy 設定を使ったとみられる。仕組みは確かめていない）。S3 の再試走（T8r、T9r）の遮断も env の proxy だったので、この取得は止まっていなかったとみられる（S3 は Chromium の通信を記録していない）。renderer の `editor.spellCheck` は本文の `spellcheck` 属性を切り替える（`src/features/editor/EditorContentArea.tsx:179-180`。既定は false で、英語の project では true。`src/features/settings/types.ts:418`、609）。

## caller-profile-egress（proposal/3 の差分）

- Baseline (approved; limited): `nir1-l6-l9-contract-proposal/3#caller-profile-egress` の確認済みの本文（l6-l9:121-130）。Electron main が発行する caller identity を profile／workspace／session／caller epoch に束縛し、Native が profile 全体の local-only gate と永続状態を持ち、chat stream／single-shot、CLI／Codex App Server／background、HTTP／MCP／proxy／redirect／接続試験、DB／review／event の平文を一つの台帳で分類する。起動時の gate は workspace／renderer／event の配信より先に評価し、D2a で旧 external と旧 local の経路を閉じて in-flight の handle を失効させる。受入れは l6-l9:130 による。前提の D2a 節（l6-l9:516-524）は、最初の制限対象平文を返す前の順序（:520）と、解除の操作を設けないこと（:524）を定める。proposal/3 の確認で解錠したのは D2a だけで（l6-l9:130）、activation を誰がどの操作で起こすか、restricted 下で NIR の平文をどの条件で返すか、restricted で閉じる既存機能をどう扱うかは定めていない。#588／#590 の実装（restricted で平文を一律に拒否し、unrestricted では検査しない）は baseline ではない。
- Delta (L6-L9 D2a activation／restricted route; nir1-d2a-activation-proposal/1 draft): proposal/3 の本文と D2a 節は保持し、次の8点を加える。詳細は「選択肢と推奨」と「critical path への影響」の後に置く4つの節（activation の trigger と開示、順序と起動時の gate、restricted 下の route 区分、restricted で閉じる既存機能への対処）のとおり。(1) activation の trigger と開示: renderer は要求だけを出し、Main が Native の表示文で確認 dialog を出し、承認のときに発行される ProfileActivation grant を Native が最初の段で消費したときだけ、profile を restricted にする。開示は、アプリの操作では解除できないこと、状態ファイルの削除や別の profile では制限が外れること、閉じる機能と続く機能を含む。製品の UI は PUB-G まで閉じる。(2) 順序と起動時の gate: l6-l9:520 の前に grant の消費を置いて全体を7段の順序に固定し、participant の停止と停止 barrier の drain（起動時の barrier を含む）に上限を置く。消費の失敗は何も閉じずに拒否し、上限の超過は fail-closed にする。状態ファイルの受理条件を Native と Main で一つにし、unavailable には理由を示す。(3) activation の途中の AI 処理: in-flight の stream と非 stream の旧 AI 要求を取り消し、renderer の表示を終端 event に頼らず終わらせ、Main が閉じた後に完了した旧 AI と平文の結果を返さない。(4) restricted 下の route 区分: NIR の平文に `plaintext-publication`（restricted で拒否）を使うのをやめ、`nir1-publication`（両 mode。restricted では登録済み caller、Native の開始時と返却時の再認可、Main の完了時の照合を条件に通す）と `nir1-restricted-only`（restricted だけ。同じ条件）を置く。属する command は下の表に限る。(5) restricted で閉じる既存機能: 基本操作（M）と、平文と関係なく汎用 SQL の形で壊れる機能（T）は平文を開かずに直し、それ以外（D）は閉じたまま、restricted の理由を UI で示して開示する。M と T を直すまで activation の UI を公開しない。(6) license の確認（activate、revalidate、deactivate、定期確認）は、平文を運ばない route `license-control` として restricted でも通す。renderer から受け取る値は activate の key だけで、Native が送信の前に形式と長さを検査する。restricted の通信は proxy と redirect を使わず、固定の送信先へ直接つなぐ。(7) 一方向の範囲: 解除の操作、状態ファイルを消す経路、`restricted:false` を書く writer を置かない。状態ファイルの削除と、別の profile での同じ workspace の利用は、防御の対象外のまま開示する。(8) Chromium 自身の通信: proposal/3 の未分類の egress の拒否を、app の code が始めない Chromium 自身の通信にも当てる。restricted で続けるのは spellchecker の辞書の取得だけで、平文を運ばない通信として開示する（X-1）。Main は spellchecker の言語、辞書の取得先、入力を外部へ送る spellcheck の service を設定しない。ほかの Chromium 自身の通信が見つかれば、閉じるか、新しい draftRef で確認する。外部 AI、旧 send、CLI、Codex App Server、MCP、外部 URL（license の3 command を除く）、Vivliostyle、接続試験、汎用の平文 command は restricted で閉じたままにする。新しい authority、保存先、data category、AI の送信先、解除の操作、分離 profile は加えない。
- Trusted actors: proposal/3 と同じ（Electron main の sender、Native policy gate、profile 状態の store、current workspace authority）。加えて、Native の Main grant の slot（ProfileActivation の preview、issue、consume。DSN §7.2）と、消費で作る process-local な activation の予約、Main が出す OS の確認 dialog（表示文は Native の allowlist だけ）、新しい区分を開始時と返却時に再認可する Native の入口、状態ファイルの受理条件を決める Native の読込（Main は Native の結果を同じ規則で検査する）、平文を運ばない Native の license runtime（grimodex-license。固定の送信先と項目、送信の前の key の検査、restricted での proxy と redirect の無効化。Main の定期確認の scheduler は起動の時期だけを決める）。
- Untrusted actors: proposal/3 と同じ（renderer の session／owner／route／category、stale handle、model／provider の出力、env／config／proxy／redirect）。加えて、renderer の activation の要求と状態の申告、別窓・遷移した sender・destroyed の sender、古い identity・epoch・preview・grant、activation の開始の前に受け付けた要求とその遅れた結果、停止を求められた main participant（外部の CLI、Codex App Server、Vivliostyle の子 process）、in-flight の要求への provider の応答、状態ファイルの中身、renderer が渡す license key の文字列、license server の応答（redirect の応答を含む）、OS と env の proxy 設定、Chromium の spellchecker の辞書の配信元とその redirect。
- In-scope attacks: proposal/3 の In-scope attacks（偽造された caller／project／session、cross-window／workspace／session、旧 local／external への fallback、proxy／redirect、retry の replay、startup race、DB／review／event／CLI／background の平文の漏れ）を保持する。加えて、activation の偽造（Main の確認を経ない activation、確認の偽装、別窓の dialog の流用、grant の再利用や期限後の承認、renderer の IPC から Main 専用の N-API への到達、env・設定ファイル・起動引数・MCP・自動の起動による activation、journey seam の悪用（packaged build での有効化、exact でない env による有効化、grant を経ない activation、sender・window・caller の束縛の省略））、開示のすり替え（renderer の文字列の dialog への表示、承認した開示と違う版や profile での activation）、activation の途中の競合（開始の前に受け付けた要求の結果を後で返すこと、途中での caller の登録、停止の確認の前に新しい区分を開くこと）、activation の途中の AI 処理（終端 event の喪失による renderer の待ち続け、取り消せない非 stream の要求による drain の上限のない待ち、Main が閉じた後に返る旧 AI の結果）、部分的な activation（grant の消費、participant の停止、永続化、停止 barrier の途中の失敗で、平文を返す状態や外部送信が開いた状態が残ること）、状態ファイルの中身の食い違いによる起動時の全拒否と、理由の示されない unavailable、新しい区分の悪用（未登録・古い epoch・別 workspace の identity による平文の取得、台帳にない command の混入、`DENIED_COMMANDS` や `INTERNAL_COMMANDS` との二重登録、ID だけの command からの平文の取得、unrestricted での `nir1-restricted-only` の利用、restricted 以外での Graph の生成）、restricted 下の外部経路の再開（外部 AI、旧 send、CLI、Codex、MCP、外部 URL、Vivliostyle、接続試験、汎用の `fts_search`／`semantic_search`／再開の一覧）、license の route の悪用（renderer が渡す key に任意の bytes を載せて固定の送信先へ運ぶこと、送信先や項目の追加、proxy や redirect による送信先のすり替え）、Chromium 自身の通信による回避（spellchecker の言語や辞書の取得先の変更、入力を外部へ送る spellcheck の有効化、開示の「続く通信」にない Chromium の通信）、平文を含む event の全窓への broadcast と生成出力の他の窓への配信、解除（解除の操作の追加、製品による状態ファイルの削除や `restricted:false` の書込み）、破損を口実にした回避（閉じた機能のために外部経路や汎用の平文 command を開くこと、破損による原稿の保存の停止、license の理由による編集の停止）、起動時の競合（workspace、renderer、event、scheduler、Graph の owner が gate と停止 barrier の前に動くこと）。
- Out-of-scope attacks: proposal/3 と同じ（OS／main／backend の侵害、admin reseal、model の品質、secret privilege、既存 Raw の再設計、network を使わない local の処理）。加えて、利用者や同じ OS ユーザーの process による状態ファイルの削除や改変（削除すると次の起動で unrestricted に戻り、制限中に作られた protected 表のデータも旧 AI の経路と renderer の汎用 SQL から読める。S3 の T12。防御せず、開示に書く。F-1）、別の profile や端末、設定を初期化したアプリで同じ workspace を開くこと（restricted は profile の状態で、workspace には記録しない。F-1）、renderer の侵害による CSP の回避、renderer の侵害（任意のコードの実行）を前提にした、形式に合う key の文字列への値の埋込み（送信先と組織は固定で、activate は同時に1件。任意の bytes は形式の検査で運べない）、OS が信頼する検査用の CA による TLS の傍受、OS の dialog の偽装、開示を読んだうえでの利用者の判断、license の通信の metadata（key と activation ID は既存どおり送る）と、平文を運ばない既存の通信（更新の確認、model と IME 辞書の download、Chromium の spellchecker の辞書の取得。どれも接続元の IP は相手に届く。X-1）、通信そのものの停止（この差分の local-only は制限対象の平文を送らないことを指す）、外部送信の再開・解除・分離 profile（別計画）、非 NIR の自分のデータを restricted 下で表示する区分（O-2。別の draftRef）、local の送信と同意（K5）、本文の開示と宣言（K2）、quarantine 中の未保存の編集の扱い（DSN §1.6 の 5。CP-3b で決める）。
- Mandatory defenses: proposal/3 の Mandatory defenses（main が発行する identity、profile 全体の deny-by-default、未分類の egress の拒否、平文の dispatch の前の停止と active handle の失効、起動の順序・永続状態・restart の試験、将来の local transport の exact endpoint と proxy／redirect の禁止、exception や unlock を作らないこと、外部送信をしないこと）を保持する。加えて次を必須にする。
  - trigger と一方向: renderer は要求だけを出せる。Main は sender、window、束縛した caller を確かめ、Native の preview の表示文だけで dialog を出し（既定は取消、確認の checkbox を要する）、承認のときだけ ProfileActivation grant を発行させる。Native は段 1 で grant を消費して binding（profile ID、caller epoch、開示の版、開示文の digest）を現在の状態と照合し、段 4 の永続化はその消費で作った予約があるときだけ行う。grant を伴わない activation の経路を置かない（env、設定ファイル、起動引数、MCP、renderer の IPC、自動の起動。Native の `cfg(test)` の単体試験だけを除く）。grant を伴わない既存の N-API と Main の経路は、DA-2 で予約を必須にする形に置き換える（下の「writer」）。非 packaged の build の journey seam も、renderer の要求、sender・window・caller の束縛、grant の発行と消費を省かない（下の「公開」）。packaged build では seam は有効にならない。解除の操作を UI、IPC、Native のどこにも置かない。状態ファイルを消す経路と `restricted:false` を書く writer を製品に置かない。PUB-G の前は Main が renderer の要求を拒否する（A-1）。
  - 順序: 下の「順序と起動時の gate」の7段を守る。新しい区分は、activation の完了（停止の永続化と caller の再登録）の後にだけ平文を返す。段 2 より前に受け付けた要求のうち、新しい区分、`plaintext-publication`、旧 AI の経路（old-external-ai、old-local-ai）の要求は、完了が段 2 の後なら平文の結果を返さず、typed な停止の理由を返す。ただし、Native が既に確定した汎用 DB の書込みは、現行と同じく行を返さずに完了として返し、失敗として返さない（`electron/main/ipc.ts:2451-2455`。失敗と見た renderer の再試行で二重に書かないため）。制限対象の平文を返さない route（`internal` と `native-mutation`。typed の bundle による原稿の保存、M と T の typed な writer、protected 表に触れない汎用 DB を含む）はこの完了時の検査の対象ではなく、どの段で完了しても結果を返す（Positive (2)）。
  - 待ちの上限: dialog の期限と、activation の段の待ちを分けて扱う。
    - dialog: 承認の期限は preview から 60 s（grant の期限。DSN §7.1、§7.4）。期限を過ぎた承認では issue を拒否し、Main は時間切れを示す。段 1 の消費が期限切れなどで失敗した場合も、何も閉じていないので、profile と process の状態は変えない（unavailable にしない。Negative (4)）。やり直すときは新しい preview から始める。
    - 段 3 の main participant の停止と、段 5 の停止 barrier の drain（起動時の停止 barrier の drain を含む）: それぞれに上限を置き、超えたら fail-closed にする（その process は unavailable で、平文を返さない）。上限はそれぞれ 30 s 以下で、integrator が実測から選ぶ。`nir1-defensive-resource-limits`（K1b。確認済みの [K1 の draft](nir1-l6-l9-contract-proposal-6-draft.md)）は DA-2 を含まないので、この差分で範囲を定める（下の「待ちの上限」）。grant は段 1 で消費するので、段 3 と段 5 の待ちは grant の期限に関係しない。
  - activation の途中の AI 処理: 下の「activation の途中の AI 処理」の4点（renderer の表示の終端、非 stream の要求の取消、遅れた結果の拒否、試験）を守る。
  - 状態ファイルと起動時の gate: 下の「起動時の gate」の受理条件の表を Native と Main で同じにし、Native が admission を開いたまま Main が unavailable にする組合せを残さない。unavailable には、平文を含まない理由のコードと復帰の手順を示す。
  - 区分: 下の「restricted 下の route 区分」の表を閉じた台帳にし、そこに書いた規則（`satisfies` の制約の維持、二重登録の禁止、網羅的な分岐、ID だけの command、invoke への応答だけでの返却、Graph の二重の gate）を守る。
  - 閉じたままにするもの: 外部 AI、旧 send、CLI、Codex App Server、MCP、外部 URL（license の3 command を除く）、Vivliostyle、接続試験、汎用の `fts_search`／`semantic_search`／`narrative_extraction_list_resumable_runs`、protected 表に触れる汎用 DB、そのほかの `plaintext-publication`、未分類の command、`nir1_graph_query`。
  - 既存機能への対処: 下の「restricted で閉じる既存機能への対処」の M・T・D の規則と表を守る。M と T の対処で restricted の平文を返す command を開かない。M と T を直すまで activation の UI を公開しない。
  - 状態の表示: restricted、activation の途中、unavailable（理由を含む）を、平文を含まない状態の取得の command と通知の event で renderer に伝え、restricted の間はそのことを UI に常に示す。D の機能は restricted の理由を i18n の文言で示し、生の marker、別原因への誤帰属、空の一覧によるデータの消失の見え方を出さない（下の「D の扱い」）。
  - license: `license-control` は、grimodex-license の固定の送信先と既存の項目だけを使い、原稿、会話、AI の入出力、それらから導いた値を運ばない。これを宣言だけにしないため、renderer から受け取る値は `activate_license` の key だけにし、Native が送信の前に exact な文法と長さの上限で検査して、合わなければ送信 0 で typed に拒否する。restricted の通信は proxy（env と OS の設定）を使わず、redirect を辿らず、`https://api.polar.sh` の固定の3 path だけに送る（N-1。下の「license の要件」）。Native の license の入口には profile の gate がなく（lib.rs:6635-6663）、Main の route 台帳だけに頼らないため。AI の transport の例外や解除ではない。
  - Chromium 自身の通信: proposal/3 の未分類の egress の拒否（l6-l9:129）を、app の code が始めない Chromium 自身の通信にも当てる。restricted で続けるのは spellchecker の辞書の取得だけ（X-1。下の「Chromium 自身の通信」）で、Main は spellchecker の言語、辞書の取得先、入力を外部へ送る spellcheck の service を設定しない（静的な検査で固定する）。DA-2 の独立受入れの restricted の試走で外への接続の試みを記録し、開示の「続く通信」にない接続先が見つかれば、閉じる方法を作るか新しい draftRef で確認するまで、DA-2 を `[precheck]` で止める。
  - lifecycle: activation は外部の子 process と非同期の処理を止めるので、DA-2 の mutation の前に有限の owner/lifecycle matrix（GDX-PRECHECK-001 の全項目）を DA-2 の decisions に置く。
  - 試験: 競合は同期点で再現し、固定の sleep に頼らない（post-B §12）。
- Acceptance implications:
  - Positive: (1) restricted の profile で、登録済み caller から、Related Scenes の R／IR（PUB-G の後は Graph も）、Evidence の遷移、A2 review の表示と再開、D-final の capture、Scope の宣言が使える。restricted 下の R（製品の hybrid の Raw と、評価の R arm が使う非 hybrid の R）の membership と順位が、24 件と G-01 で unrestricted と同じ（R の parity。DA-1 の最終候補で、DA-1 が restricted に対応させた評価 harness を両方の mode に通して測る。「品質閾値」）。(2) reload、workspace の切替、別窓、restart の後も restricted が保たれ、各窓は新しい identity で使い続けられる。原稿の本文の保存（typed の bundle。伏線の anchor を含む）は、activation の前、途中、後で続く。汎用 DB を経る書込みのうち restricted で許されるもの（protected 表に触れないもの）は、段 4 から段 7 までは登録済み caller がないので拒否されてよいが、未保存の編集を失わず、完了の後の再試行で保存される（W-1）。段 2 の前に受け付けて Native が確定した書込みは、完了が段 2 の後でも失敗として返らない（Mandatory defenses の「順序」）。M と T の操作は restricted 下で動く。l6-l9:130 の「非model Native saveが継続すること」を、この意味で具体化する。(3) activation は、明示操作 → Main の dialog（Native の表示文、既定は取消、確認の checkbox）→ grant の発行 → 段 1 の消費 → 段 2〜7、の順で一度だけ成立し、in-flight の stream と非 stream の旧 AI 要求があっても上限の内で完了する。dialog に出した表示文の digest が grant に束縛されている。(4) proxy を必要としない環境で、license の確認と activate／deactivate が restricted でも動き、license の理由で編集が閉じない（L-1）。D2a の拒否や unavailable を、license の確認の失敗として扱わない。(5) unrestricted の既存の journey の結果と、24 件の R／R+IR の結果（membership と順位）は、DA-1／DA-2 の前後で変わらない。前後で harness の trace の検査が違いうるので、IPC の trace ではなく結果で比べる（「品質閾値」）。(6) restricted の間、UI は restricted であることを常に示す。unavailable のときは、理由と復帰の手順を示す。
  - Negative: (1) 偽造、未分類、local 名だけ、proxy 経由の dispatch が 0（l6-l9:130）。restricted で、実 router、gate、Native を通した旧 AI の command（少なくとも `list_ai_models`、`send_chat_message`、`send_chat_message_stream`）が provider に届かない（S3 の T13 と同じ構成）。(2) 未登録、古い epoch、別 workspace、別 sender の identity では、新しい区分の結果を返さない。Native の開始時と返却時の再認可、Main の完了時の照合のどれかが通らなければ、結果を捨てる。(3) activation の完了の前に、新しい区分の結果、Graph、生成を返さない。段 2 の前に受け付けた要求は、完了が段 2 の後なら平文の結果を返さない（新しい区分、`plaintext-publication`、旧 AI の経路のどれも。Native が確定した汎用 DB の書込みは、行を返さずに完了として返す）。起動時の停止 barrier の完了の前も返さない。(4) 次のどれでも profile は変わらない: dialog の取消、checkbox のない承認、期限切れの後の承認（issue を拒否し、process も unavailable にならない）、段 1 の消費の失敗（何も閉じず、process も unavailable にならない）、別の sender や window、同時の2件目、grant の再利用、grant の消費を経ない Native の activation、renderer の IPC からの Main 専用 N-API の呼出し、PUB-G の前の renderer の要求（A-1。seam のない起動）、env・設定ファイル・起動引数・MCP。(5) activation の要求の command は、応答と全 event に previewId と grantId を出さず、Native の `NAPI_COMMANDS` を経て転送されず、unavailable、activation の途中、restricted、PUB-G の前（seam のない起動）の各状態で typed な状態コードで拒否される（unavailable でも internal の command は `assertInvoke` を通るので、この command 自身が拒否する。pe.ts:675-686）。DA-2 の vitest で固定する。(6) grant も予約もなしに restricted へ進める method が、生成した `index.d.ts` と Main の backend の型（pe.ts:37-40）に残っていない（Native の `cfg(test)` の単体試験を除く）。(7) unrestricted で `nir1-restricted-only` を拒否し、Graph を出さない。(8) restricted で、上の「閉じたままにするもの」をすべて拒否する。(9) allowlist にない event を配信せず、平文を含む event を全窓へ送らない。(10) 解除の操作が UI、IPC、Native のどこにもなく、製品に状態ファイルを消す経路と `restricted:false` を書く writer がない。(11) D の機能は restricted の typed な理由を示し、生の marker、別原因への誤帰属、空の一覧によるデータの消失の見え方、crash、無限の再試行を起こさない。(12) packaged build では journey seam が有効にならず、seam の env を与えても、dialog の置換も PUB-G の前の要求の受付も起きない（profile は変わらない）。seam が有効でも、別の sender や window の要求では profile は変わらない。(13) restricted で、形式に合わない key や長さの上限を超える key の `activate_license` は、license server への送信 0 で typed に拒否される。revalidate と deactivate の request は、保存済みの key と activation ID と固定の項目だけを運ぶ。どちらも cargo test で request の有無と body の項目を固定する。(14) restricted の license の通信は、env の proxy（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`）を与えても proxy を経ず、3xx の応答の `Location` へ送らずに typed な失敗になる（cargo test で、proxy 役と redirect 先の listener が受信 0 であることを固定する）。OS の proxy 設定を使わないことは、restricted の client を作る関数が `no_proxy` と redirect の禁止を指定していることを、試験か静的な検査で固定する。(15) activation の途中に in-flight の stream と非 stream の旧 AI 要求があっても、renderer の表示と audit が終わらないまま残らず、drain が応答を待ち続けず、段 2 の後に完了した結果が renderer に返らない（S3 の T5、T6、T7、T7b を反転させた試験）。(16) 状態ファイルの各状態（「起動時の gate」の表）で、Native が admission を開いたまま Main が unavailable にする組合せがない。(17) DA-2 の独立受入れの restricted の試走で記録した外への接続の試みの接続先が、開示の「続く通信」にあるものだけで、spellchecker の外への要求は辞書ファイルの取得だけである。spellcheck を有効にした本文の入力の後も同じ（X-1）。
  - Recovery: (1) 段 2 から段 6 のどこで失敗しても（待ちの上限の超過を含む）、平文の拒否と旧 handle の拒否を保つ（その process は unavailable で、理由と再起動を案内する）。段 1 の失敗では何も閉じず、その process は使い続けられる。(2) 段 4 の永続化の前の失敗では、状態ファイルは unrestricted のままで、activation は成立していない（再起動の後に新しい preview からやり直せる）。後の失敗では restricted のままで、次の起動で停止 barrier をやり直す。どちらでも途中の状態で平文を返さない。(3) 消費した grant と予約は戻さない。再起動で grant と予約はすべて無効になる。(4) crash の後の起動は状態ファイルに従い（受理条件は「起動時の gate」の表）、restricted なら停止 barrier の完了まで caller を登録しない。(5) unavailable の間は project を開けない（tree の読込も汎用 DB を使う）。再起動か原因の解消（状態ファイルの権限など）まで続き、その間も原稿のデータは消さない。
  - Lane unlocked if confirmed: DA-1（区分、S-1 と V-1 の command、`license-control` と key の検査と restricted の client の構成、宣言 UI の Native の検査、評価 harness の restricted への対応と R の parity の計測。trigger はまだ作らない）、DA-2（trigger と Main の確認、段 1〜7 の順序、範囲の内での待ちの上限の値の選択、activation の途中の AI 処理、状態ファイルの受理条件と unavailable の理由、状態の取得と通知、M と T の対処、D の表示、spellchecker の設定の静的な検査と restricted の試走の記録。UI は PUB-G まで閉じる。MG-1 が前提）、CP-3a の区分付け。activation の UI の公開と開示の文言には Session C-1 の承認が、DD-1 の command には K5 の確認が、さらに要る。
- 受入れへの影響（l6-l9:620）:
  - profile-wide egress: 変更前は、restricted で `plaintext-publication` を一律に拒否し、activation の製品経路がない。license の通信は restricted で拒否され、proxy と redirect の指定がない。Chromium の spellchecker の辞書の取得は、どの台帳にも開示にもない。変更後は、NIR の区分を条件付きで通し、activation は明示操作と Main の確認でだけ起き、license の確認は restricted でも proxy と redirect を使わずに続く。spellchecker の辞書の取得は、平文を運ばない Chromium 自身の通信として分類して開示し、試走で記録する（X-1）。外部 AI、旧 send、CLI、Codex、MCP、外部 URL（license の3 command を除く）、Vivliostyle、接続試験の拒否は変えない。
  - 信頼境界: activation に Main の一回限り grant（ProfileActivation）と、段 1 の消費で作る予約を加え、新しい区分に Native の再認可（開始時と返却時）を加える。renderer を認可の根拠にしないことは変えない。状態ファイルの受理条件は Native が決め、Main は同じ規則で検査する。
  - 保存範囲と data category: 変えない。状態ファイルの形（schema v2）を変えず、`restricted:false` の中身を書き換えずに読み方だけをそろえる。grant、予約、承認した開示の版は保存しない（P-1）。
  - 外部送信先: AI の送信先は加えない。restricted 下で、license server（`https://api.polar.sh`）への既存の通信を、proxy を経ない直接の接続だけで許す（L-1、N-1）。平文を運ばない既存の通信（更新、意味モデル、IME 辞書、Chromium の spellchecker の辞書の取得）は続け、開示する（X-1）。
  - 品質閾値: 変えない。restricted 下の R が unrestricted と同じであること（R の parity。24 件と G-01）を受入れに加える。
    - 今の評価 harness では restricted の R を測れない。trace の検査が Raw の dispatch を command の名前で数え（R arm は `db_execute`、`semantic_search`、`fts_search` を各1回。`scripts/quality/nir1-retrieval/contract.mjs:271-283` の `validateRawIpcTrace`。hybrid は `db_execute`、`related_scenes_begin`、`fts_search` を各1回、`semantic_search` を0回。`scripts/quality/nir1-retrieval/paired.mjs:157-183`）、準備の段も汎用の `semantic_search` で model の warmup と検索可能性を確かめる（`scripts/quality/nir1-retrieval/renderer.ts:122-126`、154-162、241-245）。restricted では汎用の `fts_search` と `semantic_search` が拒否され、S-1 と V-1 の command を使うと件数が合わない。S1 の G-01 の harness も同じ型の検査をする（S1 §2.3）。
    - そこで DA-1 は、S-1 と V-1 の command の名前を決める PR で、評価 harness（24 件の `scripts/quality/nir1-retrieval/` と、CP-0 が S1 から取り込む G-01 の harness）を改める。trace の検査は役割ごとの件数（R arm は `db_execute`、sparse、dense を各1回。hybrid は `db_execute`、`related_scenes_begin`、sparse を各1回で、dense の command は0回）と、全 call の完了と ok（hybrid の `related_scenes_continue` を除くのは現行どおり）で行い、新しい command を使う mode では汎用の `fts_search` と `semantic_search` を0回とする。準備の段の汎用 `semantic_search` は、restricted でも使える同じ働きの呼出しに置き換える。restricted の profile は「公開」の (b) の状態ファイルで作る（setup は今どおり unrestricted で行い、計測の起動だけを restricted にしてよい）。query、Gold、期待値、seed、順序、指標、CP-0 が固定する arm の mode は変えない。
    - R の parity は、DA-1 の最終候補で、改めた harness を両方の mode に通して測る（Positive (1)）。Positive (5) は membership と順位で比べ、DA-1 の前は前の harness、後は改めた harness で測る。この改訂は CP-3a と CP-4 より前に入る（計画では CP-3a は DA-1 の後）。CP-0 の freeze 記録（期待値、Gold、arm の mode）は変えず、CP-4 の receipt は改めた後の harness で取る（K6 の draft の失効の規則）。
    - CP-4 の R、R+IR、R+IR+Graph をどの mode で測るかは K6／CP-0 で固定する（この差分では決めない）。Graph は restricted でだけ出るので、条件をそろえるには全 arm を restricted で測ることになる。S-1、V-1 と上の harness の改訂で、R の arm も restricted で測れる。
  - 受入れに加えるもの: activation の順序と一方向性、段 1 の消費の失敗、待ちの上限の境界（期限の前後）と dialog の期限切れ、activation の途中の AI 処理、activation の途中で拒否された保存の完了後の再試行、新しい区分の条件、R の parity（DA-1 が restricted に対応させた評価 harness で測る）、M と T の操作、D の typed な表示、license（key の検査、proxy と redirect）、起動時の gate と状態ファイルの各状態、packaged build での journey seam の不在、grant なしの export の不在の試験、Main が spellchecker を設定しないことの静的な検査と、restricted の試走での外への接続の試みの記録（Chromium 自身の通信を含む。X-1）。DA-1／DA-2 では main（vitest）、N-API（node:test）、Native（cargo test）の結合試験と、renderer の関数を実 router、gate、Native に通す試験（S3 の T4 と同じ構成）で固定する。実 Electron の journey は CP-4（restricted で動かす Graph の journey）と E-1 に含める（journey を足すのはこの2回だけ）。journey で restricted にする方法は「公開」の journey の項に限る。
  - 変えないもの: Gold、P、24 件と G-01〜G-08 の判定、K1 の値、A-1、unrestricted の既存の journey の結果、Graph と local 送信の公開条件（l6-l9:431-432）と公開時の承認。
  - 可用性: activation の後は D の機能が使えなくなる（一方向）。PUB-G から PUB-L までに activation した利用者は、AI の応答を得る手段がない（chat は capture だけ）。M と T は壊さない。proxy が必須の環境では、restricted の間 license を確認できない（N-1。開示する）。
  - 既存のデータ: 消さず、移さない。閉じた機能のデータも保存されたまま残る。
- 保存先:
  - profile の状態は、既存の `<appData>/profile-egress.json`（schema v2）に restricted として残す。形は変えない。
  - grant、preview、activation の予約、caller の登録、新しい区分の operation、Graph の次 query 用の cache は process-local で、保存しない。
  - 承認した開示の版と時刻は保存しない（P-1。選択肢 P-2 を参照）。
  - S3 と S1 の報告は作業記録に置き、M・T・D の対処の記録は DA-1／DA-2 の PR と作業記録に置く。この draft の bytes には要点と分類だけを含める。
- writer:
  - 状態ファイルを書くのは Native の `ProfileEgressState` だけ（activation、起動時の停止 barrier、停止の確認。atomic replace、fsync、directory の sync。pe.rs:597-657）。Main と renderer は書かない。どの writer も restricted の profile にだけ書き、`restricted:false` を書かず、ファイルを消さない。
  - activation の書込み（段 4）は、ProfileActivation grant の消費（段 1）に成功し、その予約がある process でだけ行う。消費は書込みの前で、その後で失敗しても grant を戻さない（DSN D-17）。
  - DA-2 は、grant を伴わない `activate_profile_egress`（lib.rs:6556-6563）を、予約を必須にする形に置き換えるか消す。それを呼ぶ Main の `activateProfileEgress`（pe.ts:37-40、1331-1333）と `activateFirstRestrictedPublication`（pe.ts:808-883）も合わせる。grant も予約も要らない export を `cfg(test)` の外に残さない。既存の vitest と node:test は、preview → issue → 消費 → activation の順に移す。
  - grant の slot は Native の新しい module（DSN §7.2）が持つ。Main は opaque な id だけを扱い、renderer へは返さない。
  - route 台帳（pe.ts の区分と command の対応）を変えるのは、DA-1 と、確認済みの契約（K5 など）に基づく PR だけ。integrator が所有する。
  - 開示文（Native の allowlist の表示）と開示の版は Native の定数で、文言を変えたら版を上げる。文言は Session C-1 で承認を得る。
- 失効:
  - restricted は失効しない（一方向。解除の操作はない）。状態ファイルの削除による unrestricted への戻りは、失効ではなく防御の対象外の操作である（F-1）。
  - caller identity と dispatch の permit は、activation（epoch が進む）、workspace の open／切替／restore、登録の置換、再起動で失効し、activation の途中は登録しない（既存。pe.rs:196-225、251-269、336-351、pe.ts:656-671）。
  - 新しい区分の結果は、開始時の identity、epoch、登録、revocation generation が返却時や完了時に変わっていれば捨てる。Related Scenes の遷移の handle は click 時に再検証する。
  - grant は 60 s、一回限りで、sender の destroyed・遷移・render-process-gone、window の close、seam の edge、D2a の epoch の変化で失効する。段 1 で消費する。消費で作る予約は、activation の終わり（成功か fail-closed）まで process の中に残る。どちらも保存しないので、再起動で失効する（DSN §7.4）。
  - Graph の次 query 用の cache は、D2a の epoch の変化で捨てる（DSN §3.3）。
  - license の期限の規則は変えない（L-1）。

### 選択肢と推奨

この表について、確認文で確定するのは「推奨」の列の案である。別の案は /2 で起案する。

| ID | 論点 | 選択肢 | 推奨 | 理由 |
| -- | ---- | ------ | ---- | ---- |
| T | activation の導線 | T-1: 設定の専用の項目と、`profile-not-restricted` の案内から要求し、Main の dialog に確認の checkbox を置く。T-2: Graph や local 生成を初めて使うときに dialog を出す。T-3: 初回の起動で選ばせる | T-1 | 一方向の変更を、利用者が自分で選んだときにだけ起こす。T-2 は作業の流れに割り込み、誤操作で一方向の変更に至りやすい。T-3 は既存の利用者に不意の選択を迫る |
| R | NIR の区分 | R-1: 新しい区分2つ（`nir1-publication`、`nir1-restricted-only`）。R-2: `plaintext-publication` に NIR の例外を足す | R-1 | R-2 は「restricted で拒否」という意味を残したまま例外を重ね、台帳が読めなくなる（DSN D-12） |
| S | Raw の sparse 成分 | S-1: scene の ID と順位だけの command。S-2: sparse を Native の begin へ移す。S-3: restricted では sparse のない R を受け入れる | S-1 | 製品の hybrid（fetchNir1RelatedScenes.ts:171-180）と非 hybrid の R（fetchRelatedScenes.ts:101-108）は、`fts_search` の結果の ID だけを使う（`src/features/chat/semanticRecall.ts:315-328`）。S-1 は R を変えず、平文の面を広げない。S-2 は R を作り直すので、24 件の parity を証明し直す必要がある。S-3 は評価の変更（G-01、P、24 件）で、再確認を要する（DSN D-13） |
| V | Raw の dense 成分の退避 | V-1: Related Scenes 専用の dense の command（scene の chunk に限り、`related_scenes_begin` の dense と同じ形を返す）。V-2: restricted では理由付きの unavailable | V-1 | listener がないときの退避（fetchNir1RelatedScenes.ts:181-192）と、評価の R arm が使う非 hybrid の R（fetchRelatedScenes.ts:88-100）は汎用の `semantic_search` を使い、restricted では R が空になる。V-1 と S-1 で、restricted でも R を変えずに使え、K6／CP-0 が全 arm を restricted で測る推奨を取れる（評価 harness をこれらの command で測れるように改めるのは DA-1。「品質閾値」）。返すのは begin の dense と同じ形なので、begin より平文の面を広げない。V-2 では、退避と評価の R arm が restricted で使えない |
| O | restricted で閉じる非 NIR の機能 | O-1: 閉じたまま、M（基本操作）と T（汎用 SQL の形による破損）は平文を開かずに直し、D は restricted の理由を示して開示する（分類は下の「restricted で閉じる既存機能への対処」）。O-2: restricted 下で、同じ workspace の自分の保存データを登録済み caller に表示する区分を新設し、S3 で列挙した読取（汎用 DB の protected 表の読取を含む）を `nir1-publication` と同じ条件で通す。外部へ出る command、全窓への event、AI の送信、NIR の内部表（`nir1_*`、`narrative_proposal_*` など。typed reader だけを使う）は含めない | この draftRef では O-1 | O-1 は確認できる範囲を最小に保つ。代わりに、S3 の D に日常の機能が入った（会話の履歴、伏線とプロットと lint の一覧、版の過去の本文の表示、全文検索、Codex のハイライト、執筆統計など）。これらは activation の後に使えなくなり、M の一覧は本文を含まない projection になる。O-2 は、egress が閉じた restricted 下では自分のデータの表示が外部へ出ないので、l6-l9:429 の「制限対象平文を返す入口は D2a の完了を activation の前提にする」という当初の意図に近く、製品を続けて使える。restricted でも renderer は現在の原稿の本文を読める（tree_nodes は protected 表ではない）ので、O-1 で閉じる表示が守るものは小さい。代わりに平文の公開面が広がり、DA-1 の対象（Native の authorizer の変更を含む）と独立受入れの範囲が増える。起案の時点で決めた条件（S3 の D に日常の機能が入ること）を満たしたので、O-2 を /2 として起案し、独立レビューの後に同じ Session B で /1 と並べて示すことを推奨する。どちらを確認するかは利用者が選ぶ |
| L | license の確認 | L-1: activate、revalidate、deactivate と定期確認を `license-control` として restricted でも通す。L-2: 閉じたまま。L-3: restricted の profile では license の期限の判定を止める | L-1 | L-2 では、trial の終了の後に編集が閉じて戻せず、手動の再確認の拒否でも編集が閉じる（l6-l9:130 の「非 model の Native save が続く」に反する。S3 も静的な追跡で同じ時間差の破損を挙げた）。license の失効も検出できない。L-3 は licensing の方針の変更で、NIR の範囲を超える。L-1 は既存の送信先と項目だけで、原稿や会話を送らない。ただし、restricted 下で外部の送信先を一つ許す点が「外部は閉じたまま」からの差分になるので、この確認の対象に含める |
| N | restricted の license の通信経路 | N-1: proxy（env と OS の設定）と redirect を使わず、`https://api.polar.sh` の固定の3 path にだけ直接つなぐ。N-2: redirect は辿らないが、proxy は env と OS の設定に従う（TLS の接続先は `api.polar.sh` のまま） | N-1 | N-1 は proposal/3 の「proxy／redirect の禁止」と同じ形で、「固定の送信先」の主張がそのまま成り立つ。代わりに、proxy が必須の環境では restricted の間 license を確認できず、license の期限の規則（trial の終了、最終確認から 30 日）で編集が制限されうる（開示する）。N-2 はその環境でも確認できるが、proxy が接続先と時刻を知り、OS が信頼する検査用の CA がある環境では key と activation ID を読める。どちらも平文は運ばない |
| F | 状態ファイルの削除と別の profile | F-1: 同じ OS ユーザーの操作として防御の対象外のまま、開示に事実どおり書き、製品には削除の経路と `restricted:false` の writer を置かない。F-2: workspace の DB にも restricted の記録を置き、unrestricted の profile がその workspace を開くときに閉じる。F-3: profile の中の別の場所に sentinel を置き、状態ファイルだけが消えたときは restricted で始める | F-1 | F-1 は proposal/3 の脅威モデル（OS の侵害を対象外にする）と、分離 profile を扱わないこと（l6-l9:524、618）に合い、保存先を増やさない。F-2 は workspace ごとの制限で、分離 profile に近い別計画になり、保存先と schema の差分、restore と import の規則が要る。F-3 も保存先を増やし、両方を消す操作は防げない（誤って片方だけ消えた場合を守るだけ）。F-2 か F-3 を選ぶなら、/2 の確認まで activation の UI を公開しない |
| J | 状態ファイルの中身が `restricted:false` のとき（停止の bit を問わない） | J-1: ファイルがないときと同じく unrestricted として読み、bit を正規化する（ファイルは書き換えない）。J-2: 壊れた中身と同じく restricted（停止未確認）で始める | J-1 | 製品は `restricted:false` を書かないので、この中身は手で書き換えたときにだけ生じ、ファイルを消す操作（F-1 で防御の対象外）と同じ扱いでよい。J-2 は、利用者が有効にしていない profile を明示操作なしに restricted にする（T-1 に反する）。どちらでも、Native が受け付けて Main が全て拒否する現行の食い違いは無くなる |
| W | activation の途中の汎用 DB の書込み | W-1: 段 4〜7 の間は拒否し、未保存の編集を保って完了の後に再試行する。W-2: 有限の queue で受け付け、段 7 の後に新しい identity の再認可を経てから書く | W-1 | 原稿の本文の保存は typed の bundle で途中も続くので、拒否されるのは汎用 DB を経る書込みだけで、その時間は段 5 の上限とその前後の短い処理の内に収まる。W-2 は queue の件数と bytes の上限が K1b にもこの差分の範囲にも含まれないので、選ぶなら値ごとに確認する |
| P | 承認した開示の記録 | P-1: 保存しない。P-2: 状態ファイルに開示の版と時刻を記録する（schema v3） | P-1 | P-1 は保存範囲を変えない。P-2 は後から説明しやすくなるが、保存範囲の差分と状態ファイルの移行が要る |
| X | app の code が始めない Chromium 自身の通信（spellchecker の辞書の取得。現状 17） | X-1: 平文を運ばない通信として restricted でも続け、開示の「続く通信」に加える。restricted で続ける Chromium 自身の通信はこれだけにし、Main は spellchecker の言語、辞書の取得先、入力を外部へ送る spellcheck の service を設定しない。試走で外への接続の試みを記録し、ほかが見つかれば `[precheck]` で止める。X-2: restricted の process では、Main が Chromium の spellchecker を止めて辞書を取得させない（起動時は window を作る前、activation では段 2）。spellcheck は restricted の間使えない（D）。X-3: 全 mode で止めるか、辞書を app に同梱して取得先を app の中に置く | X-1 | X-1 は、この差分の local-only（制限対象の平文を外部へ送らない）の定義と、意味モデルや IME 辞書の download と同じ扱いで、製品を変えない。代わりに、app の route 台帳、CSP、Native の gate のどれも通らない通信を、Main の設定の禁止、開示、試走の記録で縛ることになる（取得先は Google の配信網で、redirect を辿る。S1 では env の proxy で止まらず、OS の proxy 設定に従ったとみられる）。平文を運ばないので、proposal/3 の proxy／redirect の攻撃（平文の送信先のすり替え）には当たらない。X-2 は restricted の外への接続を app が管理するものだけにできるが、英語の project で既定の spellcheck（`src/features/settings/types.ts:609`）が restricted の間使えなくなる。また、Chromium が起動のどの時点で辞書を取りに行くかは確かめていないので、DA-2 が window を作る前に止められることを実測で示す必要がある（示せなければ `[precheck]`）。X-3 は unrestricted の挙動か同梱物（辞書とその license）を変え、NIR の範囲を超える |

### critical path への影響

- この差分の確認が止めるもの（続行計画の契約表）: DA-1、DA-2、CP-3a、PUB-G、DD-1。D2a の成立を前提にする PUB-L と E も、間接に止まる。
- Session B（D+3〜5）で確認されれば、merge 列の DA-1（CB-1 の次）と DA-2（MG-1 を含む CB-2 と、CP-3a の後）に入れる。DA-2 は MG-1 の Main grant の基盤を使うので、CB-2 が遅れると DA-2 も遅れる。DA-1 は MG-1 を待たない。
- S3 の結果で DA-2 の範囲が増えた: M の対処5件（版履歴、ゴミ箱、snapshot、原稿の export と import、外部書込みの反映）、T の対処（Map、Label、Prompt template）、activation の途中の AI 処理、状態ファイルの受理条件と unavailable の理由、状態の表示と D の表示、restricted で動かす journey の seam（「公開」の (a)）。既存の journey の oracle は変えない（「restricted で動かす journey と受入れの記録」）。integrator は DA-2 を複数の PR に分けてよい（U3）。CP-1、CP-2a、CB と並行して進められるが、activation の UI の公開（PUB-G）は M と T の完了を待つので、PUB-G の計画上の目安（D+20〜25）より遅れうる。integrator は見積りを Session B で示す。
- 確認されなければ、DA-1／DA-2 を `[precheck]` で止める。Graph と local 生成の公開は D2a の成立を条件にするので（l6-l9:431-432）、PUB-G 以降が止まる。C-product の内部（CP-1、CP-2a、CB-1〜4）、DT、HP、DF+ は止めない。
- O-2 の /2 を選ぶ場合は、/2 の起案、独立レビュー、確認の分だけ DA-1 の開始が遅れ、DA-1 の範囲と独立受入れが増える。代わりに D が減り、M の一覧の projection の一部が要らなくなる（T の対処は O-2 でも要る）。O-2 を選ぶ見込みがあるなら、integrator は M の projection の実装を確認の後に回す。
- L-1 と N-1 は DA-1 の小さな変更（3つの command の区分、定期確認の起動条件、Native の key の検査、restricted の client の構成、それらの試験）で済み、critical path にほぼ影響しない。L-2 を選ぶと、licensing を有効にした release build では activation を公開できないので、PUB-G が止まる。
- DA-1 には、評価 harness の restricted への対応（trace の検査と準備の段）と R の parity の計測が加わる（「品質閾値」）。CP-3a と CP-4 より前に入り、CP-0 の freeze 記録（期待値、Gold、arm の mode）は変えない。
- X-1 は製品を変えず、開示、静的な検査、試走の記録だけを加える。X-2 を選ぶと /2 の確認が要り、DA-2 に spellchecker の停止、起動時に辞書を取りに行く時点の実測、spellcheck の D の表示が加わる。
- F-2 か F-3 を選ぶと、保存先の差分を持つ /2 の確認まで activation の UI を公開しない。
- DA-1／DA-2 は高リスクの PR で、独立受入れの lifecycle とセキュリティの観点を2名にする（続行計画の役割の分離）。DA-2 は mutation の前に activation の owner/lifecycle matrix を要する。

### activation の trigger と開示

要求:

- renderer が出せるのは「activation の要求」だけである。要求の command（名前は DA-2 で決める）は Main が処理し、Native へ転送しない。台帳では internal に置く。renderer に返すのは状態（activated、cancelled、expired、busy、already-restricted、unavailable、PUB-G の前の not-activated など）だけで、grant や preview の id は返さない。
- 導線（T-1）は、設定の専用の項目にある操作と、Graph や local 生成が `profile-not-restricted` で unavailable のときの案内の2つで、どちらも同じ要求になる。
- in-flight の旧 AI 処理があっても要求は受け付け、段 5 で取り消す（開示に書く）。
- アプリの起動、更新、Graph や local 生成の利用、MCP、env、設定ファイル、起動引数からは activation を起こさない。例外は、非 packaged の build の journey seam だけである（下の「公開」）。

Main の確認:

1. sender が destroyed でないこと、`BrowserWindow.fromWebContents` で得た window が要求の window と一致すること、sender が Main の束縛した caller であることを確かめる。
2. profile が unrestricted で、unavailable でも activation の途中でもなく、ほかの grant の dialog が開いていないことを確かめる。同時に1件だけで、2件目は待たせずに busy で返す。
3. Native の preview（ProfileActivation）を呼ぶ。Native は現在の profile ID、caller epoch、開示の版から binding を作って Native の中に保持し、Main には dialog の表示文（allowlist）と opaque な previewId だけを返す。
4. Native の表示文だけで dialog を出す。既定のボタンは取消にし、確認の checkbox（アプリの操作では解除できないことの確認）を置く。承認のボタンと checkbox の両方が揃ったときだけ承認とみなす。
5. 承認されたら、同じ sender と window から issue を呼ぶ。preview から 60 s を過ぎていれば issue は拒否され、Main は時間切れを示す（DSN §7.4）。このときは段 1 の前なので、profile と process の状態は変えない。取消、期限切れ、エラー、sender の destroyed・遷移、window の close のときは revoke する。
6. issue の後、下の順序の段 1（grant の消費）から activation を行う。

開示に必ず含めるもの（文言は Session C-1 で承認を得る）:

1. 対象: この profile（このアプリの設定）のすべての workspace、作品、会話、窓に及び、再起動の後も続く。別の端末や別の profile、設定を初期化したアプリで同じ workspace を開いた場合は制限されない。
2. 一方向: アプリの操作では解除できない（l6-l9:37）。設定のフォルダにある状態ファイルを消すと、次の起動で制限が外れ、制限の間に作られた会話などのデータも外部の AI の経路から読める状態に戻る（F-1）。外部の AI を使い続けたいなら有効にしない。
3. 閉じるもの: 外部の AI への送信と既存の AI の全経路（provider、local の Ollama、inline、CLI、Codex App Server を含む）、実行中の AI の処理（取り消す）、AI の補助機能（タイトル、要約、校閲、Agent、伏線の提案など）、外部 URL を開く操作、Vivliostyle、MCP の連携、D に分類した機能（下の表の D。S3 で確かめた一覧）。
4. 続くもの: 原稿の編集と保存、M と T に分類した操作、Related Scenes、A2 review、Scope の宣言。Graph は公開の後に使える。local 生成は PUB-L の後に、別の同意を経て使える。それまでは AI の応答を得る手段がない。
5. 続く通信: license の確認（L-1。proxy を使わずに直接つなぐ。proxy が必須の環境では確認できず、license の期限の規則で編集が制限されうる。N-1）、更新の確認と download、意味モデルの download（model がなければ project を開いたときに自動で始まる）、IME 辞書の download、Chromium の spellchecker の辞書の取得（アプリの画面の部品が、Google の配信網から辞書を取得する。S1 では新しい profile の起動で取得した。X-1）。どれも原稿や会話を送らないが、接続元の IP は相手に届く。
6. データ: 何も消さない。閉じた機能のデータも保存されたまま残る（restricted の間は表示しない）。
7. 開示の版。

開示の設計注記: 開示は事実より強く書かず、「元に戻せない」ではなく「アプリの操作では解除できない」とし、状態ファイルの削除と別の profile での利用の結果（項目 1、2）を隠さない。状態ファイルの削除や改変で unrestricted に戻ること（pe.rs:166-174）は、防御の対象外（Out-of-scope。F-1）である。

grant:

- ProfileActivation の binding は、profile ID、caller epoch、開示の版、開示文の digest である（DSN §7.3 の「policy の版」を開示の版として扱う）。u64 は Native の中だけに置く（DSN §7.2）。
- 段 1 で、Native は grant を消費する（DSN §7.2 の consume）。種類、sender、window、期限、状態（Issued）を確かめ、binding を現在の状態（profile ID、caller epoch、unrestricted であること、開示の版）と照合する。一致しなければ何も閉じずに拒否する。
- 消費に成功すると、Native はこの process に限った activation の予約を持つ（保存しない）。予約がある間は、種類を問わずほかの preview と2回目の消費を拒否する。段 4 の永続化は、この予約があり、binding が現在の状態とまだ一致するときだけ行う。
- 開示文の digest は、Native が preview で自分の表示文から計算する。Main や renderer が表示文を差し替えると一致しない。

公開:

- DA-2 は要求の command、Main の流れ、Native での grant の消費と予約を作るが、PUB-G の gate が閉じている間は、Main が renderer の要求を not-activated で拒否する（A-1）。UI は PUB-G で開く。
- 単体と結合の試験（vitest、node:test）は dialog を mock し、Main の代わりに Native の preview、issue、消費を呼ぶ。grant を伴わない activation の経路は、Native の `cfg(test)` の単体試験のほかに置かない。
- 実 Electron の journey（CP-4、E-1）は restricted の profile で動かす。restricted にする方法は次の2つに限る。
  - (a) journey seam: 非 packaged の build で、journey の runner が所有する exact な env の値があるときだけ有効になる seam（既存の journey seam と同じ条件。`electron/main/productJourneyAi.ts:74-84`、index.ts:120-137）。seam が置き換えるのは2点だけである。一つは、PUB-G の前に Main が activation の要求を拒否する gate を、この要求の command に限って開けること。もう一つは、OS の dialog を出さずに、seam の値が決める応答（承認と checkbox、取消、時間切れ）を返すこと。要求は、journey の runner が開いた製品の window から、preload の同じ command で送る。Main はその sender と window で確認 1〜5（4 の dialog だけを seam の応答に置き換える）を行い、preview、issue、消費、段 1〜7、待ちの上限を製品と同じ経路で通す。sender、window、caller の束縛は省かないので、別の sender や window の要求の試験（Negative (4)、(12)）はこの経路でも成り立つ。seam は試験の入口として隔離し、renderer から選べない（post-B §4.4）。A-1 は、packaged build と、seam の env がない起動で検査する。
  - (b) 状態ファイル: activation の流れを確かめない journey は、runner が journey 用の `<appData>` に restricted の正しい状態ファイル（schema v2 の `profile-egress.json`）を置いてから起動してよい。これは activation ではなく、起動時に restricted として読む既存の挙動で（pe.rs:135-176）、アプリに経路を加えない（状態ファイルの改変は Out-of-scope）。
  - restricted で動かす journey の oracle は、renderer の `db_execute` で protected 表や PRAGMA を読まない（restricted では拒否される。S3 で oracle が原因の失敗が 12 件あった）。app を終えてから SQLite を直接読むか、試験専用の Native 側の入口を使う。
  - packaged build では seam は有効にならず、env の値を読まない。dialog の置換と、PUB-G の前の要求の受付は存在しない（Negative (12)）。
- renderer へは、平文を含まない状態（restricted、activation の途中、unavailable とその理由、activation の可否）だけを返してよい。この状態の取得は internal に置く。

### 順序と起動時の gate

activation の順序（l6-l9:520 の前に grant の消費を置いて具体化したもの）:

| 段 | 内容 | 現行 | この差分 |
| -- | ---- | ---- | -------- |
| 1 | Native が ProfileActivation grant を消費し、activation の予約を作る | なし | 新規。何も閉じていないので、失敗（期限切れ、sender の destroyed、window の close、binding の不一致）では profile と process を変えず、unavailable にしない。消費に成功したら、Main はほかの待ちを挟まずに段 2 へ進む |
| 2 | Main が同期で閉じる（restricted の意味へ切り替え、外部 URL を拒否し、main participant の登録を閉じる） | pe.ts:818-819 | 変えない。加えて、全窓へ「activation の途中」の状態を通知する（平文を含まない）。この時点から完了までに完了した、新しい区分、`plaintext-publication`、旧 AI の経路の結果は返さない |
| 3 | main participant（CLI AI、Codex App Server、Vivliostyle）を止める | pe.ts:823-842、index.ts:497-509。activation の側の待ちに上限はない | license の確認は止めない（L-1）。並行する停止の全体の待ちに上限（下の「待ちの上限」）を置き、超えたら fail-closed |
| 4 | Native が予約と binding を確かめ、epoch を進め、caller の登録を消し、permit を失効させ、restricted を停止未確認として永続化する | pe.rs:196-225 | 予約の確認を加える。ほかは変えない |
| 5 | Native の停止 barrier（admission を閉じ、chat・inline・post-effect と非 stream の旧 AI 要求を取り消し、dispatch を drain し、停止を永続化して admission を開く） | lib.rs:6457-6504。非 stream の要求は取り消せず、drain に上限はない | 非 stream の旧 AI 要求も、stream と同じ登録制で取り消す。drain に上限（下の「待ちの上限」）を置き、超えたら fail-closed（状態ファイルは restricted で停止未確認のまま。次の起動でやり直す） |
| 6 | Main が epoch と policy を更新し、identity を消す | pe.ts:868-873 | 変えない。全窓に、完了（restricted）の状態を通知する |
| 7 | 各 caller が新しい epoch で登録され、新しい区分が開く | pe.ts:638-673 | 新しい区分は登録済み caller にだけ平文を返す |

- 段 1 は、l6-l9:520 の順序の前に置く認可の段で、外部 dispatch の受付を閉じる最初の段は段 2 のままである。段 4 と段 5 の2回の永続化（restricted と停止未確認、次に停止の確認）は、l6-l9:520 の「実行中処理の停止を確認し、profile制限を永続化」を、途中で crash しても restricted が残る形にしたもので、現行の構造（pe.rs:196-225、273-289）を変えない。
- 段 2 から段 7 の間、Main は caller を登録せず（pe.ts:656-671）、新しい区分の要求を invoke の時点で拒否する（区分の意味の (2)）。Native も、段 4 から段 7 までは登録済み caller がないので拒否する。段 2 の前に受け付けた、新しい区分、`plaintext-publication`、旧 AI の経路の要求は、完了が段 2 の後なら Main が平文の結果を返さない（pe.ts:714-728 と同じ型の検査を、新しい区分と旧 AI の経路に広げる）。Native が確定した汎用 DB の書込みは、現行どおり行を返さずに完了として返す（ipc.ts:2451-2455）。制限対象の平文を返さない route はこの検査の対象ではない（次の項）。
- 原稿の本文の保存（typed の bundle）は Native の profile gate を通らないので、どの段でも続く（lib.rs:9802-9815。S3 の T7 と T7b では、barrier の間も typed の command が通った）。汎用 DB（`db_execute`）を経る書込みは、段 2 から Main が restricted の規則を当て（protected 表を拒否する）、段 4 から段 7 までは登録済み caller がないので Native が全て拒否する（lib.rs:9088-9091、pe.rs:299-318。S3 の T7b）。この間に拒否された保存のうち restricted で許されるもの（protected 表に触れないもの）は、未保存の編集を失わず、完了の後の再試行で保存する（W-1）。protected 表への書込みは D の機能で、restricted ではその入口を閉じる（「D の扱い」）。
- Graph と生成は、Native が restricted と停止確認済みを確かめてからでないと作らないので、段 7 の前には作られない。
- どの段の失敗も fail-closed にする。段 1 の失敗では何も閉じていないので、profile と process を変えない。段 2 から段 4 の永続化の前の失敗では、状態ファイルは unrestricted のままで、その process は unavailable、再起動で unrestricted に戻る（activation は成立していない）。段 4 の後の失敗では、状態ファイルは restricted のままで、次の起動で停止 barrier をやり直す。どちらでも途中の状態で平文を返さず、外部送信を開かない。

activation の途中の AI 処理（DA-2）:

1. 段 2 の通知を受けた renderer は、AI の入口を閉じ、終端の届いていない AI の処理（chat、inline、CLI、Codex App Server、post-effect、agent、single-shot）の表示と audit を、「restricted による停止」の typed な理由で終える。Main が捨てる終端 event（pe.ts:768-779）を待たない。stream の invoke の settle（Ok を含む）も終端として扱う。Main が平文を含まない終端を合成して送るかは DA-2 が決める（U3）。
2. 段 5 で Native は、stream に加えて非 stream の旧 AI 要求（lib.rs:14720-14725 の経路）も取り消す。取り消せない dispatch が残れば、drain の上限で fail-closed になる。
3. 段 2 の後に完了した旧 AI の経路（old-external-ai、old-local-ai）と `plaintext-publication` の結果は、Main が完了時に拒否する（ipc.ts:2436-2459 の検査を旧 AI の経路に広げる）。renderer には typed な停止の理由を返す。Native が確定した汎用 DB の書込みの扱い（ipc.ts:2451-2455）と、制限対象の平文を返さない route を対象にしないことは変えない（Mandatory defenses の「順序」）。
4. 受入れは、S3 の T5、T6、T7、T7b を反転させた試験（終端が届かずに残る表示、応答を待ち続ける drain、段 2 の後に返る結果の、どれも起きないこと）と、in-flight の非 stream 要求があっても activation が上限の内で完了する試験である（Negative (15)、Positive (3)）。

待ちの上限（DA-2）:

- 対象は、段 3（並行する main participant の停止の全体）と段 5（停止 barrier の drain）の2つである。起動時の停止 barrier の drain（lib.rs:6457-6504 の同じ関数）にも段 5 と同じ上限を当てる。上限はそれぞれ 30 s 以下にし、integrator が実測から選ぶ。値、単位、検査する位置、超えたときの結果、実測の条件を、DA-2 の PR 本文と作業記録に残す。
- 起動時は、gate を renderer、CI seam、workspace の event、scheduler より先に作るので（index.ts:115-118）、drain の対象は 0 件のはずである。起動時の上限はこの前提が崩れたときの安全網で、前提は試験で固定する（起動時の barrier が待たずに終わり、終わるまで dispatch の admission が閉じていること）。
- 超えたら fail-closed にする。段 3 なら状態ファイルは unrestricted のまま、段 5 と起動時なら restricted で停止未確認のままで、どれもその process は unavailable になり（理由を示す）、平文を返さない（上の段の失敗と同じ）。
- この上限には、K1b（2026-10-12T23:58 JST に確認済み）の規則 1〜8 のうち待ちに当てはまるもの（規則 3 の allocation の前の検査を除く）を同じ意味で当てはめる。activation は開始の後に利用者が取り消せないので、規則 2 の取消は、上限への到達と process の終了による停止を指す。厳しくするのは確認なしで行えるが、正常な activation が上限の内で完了すること（Positive (3)）を保つ範囲に限る。30 s を超える値と、merge の後に緩める変更は、再確認を要する。
- K1b の Lane unlocked は C-body、C-product、H-store／H-current、D-transport で、対象の表の「barrier の待機」も D-transport の行である。DA-2 の上限は K1b に含まれないので、この差分の確認で範囲を定める。K1b の範囲は広げない。
- dialog の 60 s は grant の期限（DSN §7.1）で、この上限とは別に扱う（Mandatory defenses の「待ちの上限」）。grant は段 1 で消費するので、段 3 と段 5 の待ちが grant の期限を越えても activation は失敗しない。

起動時の gate:

- 変えないもの: backend の構築の直後、CI seam、workspace の event、scheduler、renderer より先に gate を作る（index.ts:115-118）。restricted なら停止 barrier をやり直し、終わるまで caller を登録しない（pe.rs:231-256）。gate を作れなければ unavailable にし、汎用 DB を含めて拒否する（pe.ts:677-685、1294-1344）。状態ファイルがなければ unrestricted、壊れているか版が不明なら restricted で停止未確認として始める（pe.rs:135-176）。
- 加えるもの: 新しい区分は停止 barrier の完了まで平文を返さない。Graph の product owner は、restricted、停止確認済み、PUB-G の gate が開いていること、がすべて揃うまで `Disabled` にして spawn しない（DSN §1.2）。license の確認（L-1）は unrestricted と restricted で起動する。unavailable では起動せず、license の3 command も拒否する（下の「区分の意味」の表）。unavailable のときは、平文を含まない理由のコードで、理由と復帰の手順を示す。
- 状態ファイルの受理条件: Native と Main は次の表の一つの規則を使う。Native が受け付けて admission を開いた状態は、Main も受け付ける。Main の検査（pe.ts:1274-1292）は、Native がこの表に従って返す状態だけを正とする。試験は表の各行を Native（cargo test）と Main（vitest）の両方で固定する（S3 の T12 と同じ形）。

| 状態ファイル | Native | Main の gate | 現行との違い |
| ------------ | ------ | ------------ | ------------ |
| ない | unrestricted（epoch 0、新しい profileId。pe.rs:166-174） | 通常 | なし（開示する。F-1） |
| `restricted:true`（schema v2 の正しい形） | restricted、epoch を保つ。停止 barrier をやり直す（pe.rs:231-246） | restricted | なし |
| `restricted:true` で、schema v1 か、停止の bit が欠けるか食い違う | restricted、epoch を保つ。停止未確認として barrier をやり直し、v2 の正しい形で書き直す | restricted | なし（現行も barrier で書き直す。試験で固定する） |
| `restricted:false`（schema v1／v2。停止の bit を問わない） | unrestricted。bit を unrestricted の値（`handlesInvalidated:false`、`inFlightStopped:true`）に正規化し、ファイルは書き換えない | 通常 | 変える。現行は Native が admission を開いたまま、Main が unavailable にして汎用 SQL を全て拒否する（pe.rs:150-151、177、pe.ts:1311-1316）。製品は `restricted:false` を書かないので、この中身はファイルがないときと同じ扱いにする（J-1） |
| JSON として壊れている、版が不明、profileId が不正 | restricted（新しい profileId、epoch 1）、停止未確認（pe.rs:156-164） | restricted | なし |
| 読めない（権限など） | backend を作れない（pe.rs:175） | unavailable（理由: 状態ファイルを読めない） | 理由と復帰の手順の表示を加える |
| `restricted:true` で、起動時の barrier の永続化に失敗する（userData に書けない） | admission を閉じたまま（pe.rs:244、280-286） | unavailable（理由: 状態ファイルに書けない） | 理由と復帰の手順の表示を加える |

- 登録の失敗の扱い: Main は、caller の登録に失敗している sender の command を停止系のほかは拒否する（pe.ts:759-765）。S3 では、製品の起動の順序でこの状態は起きなかった（T11 と T11r の計 6 回の起動で 0 件）。DA-2 は、main が束縛を観測する前に Native が workspace を束縛する経路が製品にないこと（main 直の open、recovery、web editor の handoff）を試験で固定する。回復の command（`open_workspace`、`restore_backup`、`list_recovery_candidates` など。平文を返さないもの）を登録の失敗で閉じないようにするかは、DA-2 が決めて記録する（U3）。
- lifecycle: DA-2 の mutation の前に、entry、start、retry、reentrant、admission closure、pending start、active handle、cancellation、bounded wait、終了の証拠、error／timeout／onClosed、restart の状態を並べた activation の有限の owner/lifecycle matrix を DA-2 の decisions に置く（GDX-PRECHECK-001）。integrator はこの条件を DA-2 の TASK.md に写す。

### restricted 下の route 区分

区分の意味:

| 区分 | unrestricted | restricted | unavailable |
| ---- | ------------ | ---------- | ----------- |
| `nir1-publication` | 現行どおり通す（L0〜L5 の R／IR と A2 の既存の製品を変えない） | 次のすべてを満たすときだけ通す。(1) main が発行した caller identity が付いている（`db_execute` と同じく必須）。(2) activation の途中でも unavailable でもない（invoke の時点と完了の時点）。(3) Native が開始時と返却時に、登録済み caller との一致、caller epoch、workspace、revocation generation が変わっていないことを確かめる（`begin_dispatch` と `with_authorized_dispatch` と同じ型）。(4) Main が完了時に、identity が発行時のままであることを確かめる | 拒否する |
| `nir1-restricted-only` | 拒否する | `nir1-publication` と同じ条件で通す | 拒否する |
| `license-control`（L-1） | 通す | 通す。平文を運ばず、proxy と redirect を使わない（下の license の要件） | 拒否する（現行どおり。unavailable は fail-closed の状態そのもので、理由と再起動を案内する。`get_license_state` は internal のままで、状態は読める） |
| `plaintext-publication`（現行） | 現行どおり通す | 拒否する（変えない） | 拒否する（変えない） |

unavailable は、gate を作れなかった process（pe.ts:1294-1344）と、activation に失敗した process（pe.ts:874-877）を指す。

区分の規則:

- 区分と command の対応は閉じた台帳にする。`D2aTypedResultPolicy` を union に広げても `satisfies` の制約は保ち、`DENIED_COMMANDS` や `INTERNAL_COMMANDS` と新しい区分に同じ command を載せない（現行は license の3 command が `DENIED_COMMANDS` と `INTERNAL_COMMANDS` の両方にある。pe.ts:77-79、160、204、331）。`assertInvoke` と完了時の検査は、区分を網羅的に分岐する。どれも試験で固定する。台帳にない command は未分類として拒否する（変えない）。
- 新しい区分に command を加えるのは、確認済みの契約（下の表、K5）がその command を名指すときだけにする。restricted で閉じる既存機能の M と T の対処で作る、平文を含まない typed projection と writer は `internal` に置く（「restricted で閉じる既存機能への対処」の規則）。
- 新しい区分の結果は invoke への応答としてだけ返す。平文を含む event を全窓へ送らない。
- ID だけを返す command は、title、excerpt、本文などの平文を返さない。
- Graph は、IPC の区分とは別に、Native が restricted、停止確認済み、PUB-G の gate のすべてを確かめてから出す（二重の gate。DSN §4.2）。`nir1_graph_query` は未登録のまま（lib.rs:11674-11676）。
- 新しい区分の Native の入口は caller identity を受け取る（Related Scenes と A2 の reader は、現在は受け取らない）。受け取り方は DA-1 で決める（U3）。

区分の構成:

| 対象 | command／event | 現行 | unrestricted | restricted |
| ---- | -------------- | ---- | ------------ | ---------- |
| Related Scenes の R／IR と Evidence の遷移 | `related_scenes_begin`、`related_scenes_continue`、`nir1_evidence_qualify` | plaintext-publication（pe.ts:114、116-117） | `nir1-publication`（現行どおり通す） | `nir1-publication` |
| Related Scenes の Graph | 上の command と、Graph の待受けの command（新。名前は CP-3a） | 未登録 | `nir1-publication`。Native は Graph を出さず `profile-not-restricted` を返す | `nir1-publication`。Native が二重の gate を確かめてから Graph を出す |
| Raw の sparse 成分 | scene の ID と順位だけを返す command（新。S-1。名前は DA-1） | 現行は `fts_search`（plaintext-publication。pe.ts:113）で、結果の ID だけを使う（semanticRecall.ts:315-328） | `nir1-publication`。unrestricted でも新しい command に切り替えるかは DA-1 が決める（U3。どちらでも、評価 harness の trace の検査は DA-1 が同じ PR で改める。「品質閾値」） | `nir1-publication`。汎用の `fts_search` は拒否のまま |
| Raw の dense 成分の退避 | Related Scenes 専用の dense の command（新。V-1。scene の chunk に限り、`related_scenes_begin` の dense と同じ形。名前は DA-1） | 現行は `semantic_search`（plaintext-publication。pe.ts:110）を、listener がないとき（fetchNir1RelatedScenes.ts:181-192）と非 hybrid の R（fetchRelatedScenes.ts:88-100）が使う | `nir1-publication`。unrestricted でも新しい command に切り替えるかは DA-1 が決める（U3。どちらでも、評価 harness の trace の検査は DA-1 が同じ PR で改める。「品質閾値」） | `nir1-publication`。汎用の `semantic_search` は拒否のまま |
| A2 review の表示 | `nir1_entity_relation_revision_read`、`_read_current`、`_restore` | typed policy の plaintext-publication（pe.ts:63-65） | `nir1-publication` | `nir1-publication` |
| A2 review の再開の一覧 | NIR1 の entity-relation review surface に限った一覧（新。名前は DA-1）。現行は `narrative_extraction_list_resumable_runs`（pe.ts:134、`src/features/codex/codexEntityRelationReviewApi.ts:128-132`） | plaintext-publication | `nir1-publication` | `nir1-publication`。その surface の run の ID と状態だけを返す。汎用の一覧は拒否のまま |
| A2 review の書込み | `nir1_entity_relation_revision_prepare`、`_create`、`narrative_extraction_capture_workspace_binding` | internal | 変えない | 変えない（平文を返さない） |
| Related Scenes の解放 | `related_scenes_release` | internal | 変えない | 変えない |
| D-final | `capture_current_chat_input`、`cancel_current_chat_input`、`retire_current_chat_input` | internal。capture は restricted のときだけ行い、Native が登録済み caller を確かめる | 変えない | 変えない |
| 宣言 UI（Scope） | `narrative_scene_scope_read`、`_update`、`_registry_update` | internal。Native は workspace だけを確かめる | 変えない | internal のまま通す。Scope の binding と registry の名前を返すので、Native の入口で登録済み caller と workspace を確かめる検査を加える（DA-1） |
| 宣言 UI（本文の宣言と取消） | K2 が置く typed な入口2つ（A1 の保存とは別。名前は CB-2） | 未作成 | internal。K2 の Main grant（BodyDeclaration）を要し、PUB-G まで製品で閉じる（K2 の確認による） | 同左。Native の入口で登録済み caller と workspace も確かめる |
| D-dispatch | K5 で決める command | 未作成 | `nir1-restricted-only`（拒否） | `nir1-restricted-only`（K5 の確認で加える） |
| profile の状態の取得 | renderer が restricted、activation の途中、unavailable とその理由を知る command（新。名前は DA-2。平文、id、epoch を返さない） | 未作成 | internal | internal（unavailable でも答える） |
| event | `related-scenes:invalidated`、`related-scenes:index-ready` | 許可 | 変えない | 変えない |
| event | `related-scenes:graph-ready`（新。payload は projectId だけ。DSN §3.4） | 未登録 | 許可 | allowlist に加える |
| event | profile の状態の通知（新。Main が出す。名前は DA-2。payload は状態コード（activating、restricted、unavailable）と unavailable の理由のコードだけで、平文、id、epoch を含まない） | 未登録 | — | 段 2（activating）、段 6（restricted）、activation の失敗（unavailable）のときに全窓へ送る（平文を含まないため）。event の台帳に加える |
| 生成出力 | K5／DD-1 で決める | — | — | 全窓への event に載せず、invoke した sender にだけ返す |
| license | `activate_license`、`revalidate_license`、`deactivate_license`、Main の定期確認 | external-url（pe.ts:77-79）。restricted では定期確認を始めない（index.ts:487-493） | `license-control` | `license-control`（L-1、N-1。activate の key は Native が送信の前に検査する。unavailable では拒否） |
| 閉じたまま | 上の表にない `DENIED_COMMANDS`（外部 AI、旧 send、CLI、Codex App Server、MCP の設定、接続試験、外部 URL、Vivliostyle、汎用の平文 command）、protected 表に触れる汎用 DB、`nir1_pack_context`（製品の D-final は Native の Packer だけを使う。K6）、未登録の command | 現行 | 変えない | 拒否のまま（O-1） |

license の要件（L-1、N-1）:

- 送信先は grimodex-license の固定の送信先（`https://api.polar.sh` の activate、validate、deactivate の3 path。`src-tauri/crates/grimodex-license/src/lib.rs:419`、508、546、584）で、項目は既存のもの（license key、組織 ID、activation ID、端末の label）だけにする。原稿、会話、AI の入出力、それらから導いた値を含めない。
- renderer から受け取る値は `activate_license` の key だけである。Main の IPC は文字列であることしか確かめず（`electron/shared/ipcContract.ts:1150-1158`、9685-9697）、Native はその key をそのまま送る（license の lib.rs:205-221、503-515）。そこで restricted では、Native が送信の前に key を exact な文法と長さの上限（Polar が発行する key の形式から DA-1 が固定し、試験に置く）で検査し、合わなければ送信 0 で typed に拒否する。unrestricted でも同じ検査を使うかは DA-1 が決める（U3）。revalidate と deactivate は保存済みの key と activation ID だけを送り、renderer から値を受け取らない（lib.rs:6645-6663）。
- restricted の通信は、proxy を使わない client（`no_proxy`。env の proxy と OS の proxy 設定の両方を外す）で、redirect を辿らない方針（`redirect::Policy::none()`）にする。3xx の応答は typed な失敗にし、`Location` の先へ送らない。https の固定の URL だけを使う。現行の client（license の lib.rs:446-458）はどちらも指定していないので、DA-1 が restricted の client を分ける。unrestricted でも同じ構成にするかは DA-1 が決める（U3。既存の proxy の利用者への影響を記録する）。
- 応答は license の状態だけを更新する。失敗しても既存の fail-soft の規則に従い、D2a の状態と区分に影響しない。renderer は、D2a の拒否と unavailable による拒否を license の確認の失敗として扱わない（手動の再確認でも `staleConfirmed` を立てない。store.ts:82-92）。
- これは AI の transport の例外や解除ではなく、平文を運ばない route の分類である（更新の確認や model の download と同じ扱い）。送信先や項目を増やす変更と、proxy や redirect を使う変更（N-2 を含む）は、再確認を要する。

Chromium 自身の通信（X-1）:

- 対象は、app の code が始めず、IPC の route 台帳、renderer の CSP、Native の gate のどれも通らない、Chromium（Electron）自身の外への通信である。`a153743b` で分かっているのは spellchecker の辞書の取得だけである（現状 17）。proposal/3 の未分類の egress の拒否（l6-l9:129）は、この種類の通信にも当てる。
- spellchecker の辞書の取得は、平文を運ばない通信として restricted でも続け、開示の「続く通信」に書く。取得先は Chromium の既定（Google の配信網とその redirect 先）のままで、外への要求は辞書ファイルの取得に限る。原稿と入力の文字列は送らない。spellcheck の機能（`editor.spellCheck`）は restricted でも変えない。
- Main は、spellchecker の言語、辞書の取得先、入力を外部へ送る spellcheck の service を設定しない（現行どおり。`electron/main` に設定はない）。DA-2 は、`electron/main` が spellchecker の設定の API を呼ばないことを静的な検査で固定する。これらを変える変更と、restricted で続ける Chromium 自身の通信を増やす変更は、再確認を要する。
- DA-2 の独立受入れの restricted の試走（下の「restricted で動かす journey と受入れの記録」）で、外への接続の試み（Chromium の net log などの記録と、app の log）を記録する。開示の「続く通信」にない接続先か、辞書ファイルの取得でない spellchecker の要求が見つかれば、閉じる方法を作るか新しい draftRef で確認するまで、DA-2 を `[precheck]` で止める（Negative (17)）。
- これは AI の transport の例外や解除ではない。restricted で spellchecker を止める案（X-2）を選ぶなら、/2 で起案する。

### restricted で閉じる既存機能への対処

S3 rev 2 は、`a153743b` の製品コードを変えずに restricted を強制し、renderer の関数を実 router、gate、Native に通す試験（T4）、全 command の判定（T1）、全表の SQL の判定（T3）、実 Electron の探索と product journey（T8、T9。表示と D-Bus を隔離し、env の proxy の行き止まりで app の外への通信を塞いだ再試走 T8r、T9r でも同じ結果。env の proxy は Chromium の辞書の取得を止めない。現状 17）で棚卸しした。下の表はその結果を、この差分の分類にしたものである。

分類:

- N: この差分の区分で通す（上の表）。
- M（基本操作）: 原稿の編集と保存（伏線の anchor を含む）、workspace の open／切替／restore／backup と Safe Mode の復旧、版履歴（記録、一覧、復元）、削除した原稿の復元、snapshot の作成と復元、原稿の export と import、外部書込みの反映と競合の検出。restricted 下でも壊さない。
- T（汎用 SQL の形による破損）: 平文を返さない機能のうち、汎用 SQL の形（DML の RETURNING、protected 表を親に持つ FK、payload の列を含む `select *`）のために restricted で壊れるもの。M と同じく restricted 下でも壊さない。
- L: license（L-1、N-1）。
- D: それ以外で restricted で閉じるもの。閉じたまま、restricted の理由を示して開示する。

M と T の対処の規則:

1. 使ってよいもの: 既存の typed command。平文を含まない typed projection（ID、種類、位置、版、件数、時刻、大きさと、restricted でも汎用 DB で読める表（`tree_nodes` など）にある title だけを返すもの。会話の title など、protected 表にしかない title は返さない）と、平文を返さない typed writer を新しく作り、`internal` に置くこと。RETURNING を使わない書込みと、書込みの後の非 protected 表の再読取。閉じた部分を飛ばして理由を typed に示し、残りを完了させること。
2. 使ってはいけないもの: 会話、prompt、AI の出力、注釈、過去の本文、review や audit の本文を返す command を restricted で開くこと。それが要る M や T は `[precheck]` で止め、新しい draftRef（O-2 など）で確認する。
3. 版の復元は、利用者の明示操作で過去の本文を現在の原稿に戻すもので、restricted でも renderer が読む現在の原稿（`tree_nodes`。protected 表ではない）の範囲を変えない。復元の前に過去の本文を表示する操作は D とする。
4. 新しく作る projection と writer は、独立受入れが field の一覧を確かめる（平文がないこと）。
5. M と T の操作が restricted 下で動くことを、activation の UI を公開する前（PUB-G の前）に試験で示す。示せない M か T が残るなら、activation の UI を公開しない。

D の扱い:

- restricted の理由を、状態の取得の command と i18n の文言で typed に示す。既存の `isD2aEgressDenied` による無言の縮退（`src/lib/tauri.ts:27` を使う 7 file 8 箇所）はこの規則に合わせて見直す。生の marker（`D2A_EGRESS_DENIED:`）と、別原因への誤帰属（例: Ollama の metadata を確認できないという表示。chatOllamaPreflight.ts:83-97）を出さない。会話の履歴や伏線の一覧を空の一覧として出さず、restricted のため表示しないことを示す（データが消えたように見せない）。
- 一覧を閉じる機能は、作成と編集の入口も restricted では UI で閉じ、書けるが見えない状態を作らない。
- AI の入口は、restricted と activation の途中には閉じる。
- crash、データの消失、無限の再試行、未保存の編集の消失を起こさない。データは消さず、移さない。
- 表の一覧を開示に載せ、Session C-1 で承認を得る。

restricted で動かす journey と受入れの記録:

- 常設の journey は CP-4 と E-1 で足すものだけで、oracle の規則は「公開」の journey の項のとおり。既存の journey とその oracle は、この差分では変えない。S3 で oracle が原因だった12件と同じく、既存の journey の多くは renderer の `db_execute` で protected 表を読むので、restricted の回帰試験にはそのまま使えない。
- N、M、T の restricted 下の動作と、D の typed な停止の判定は、DA-1／DA-2 の結合試験と、renderer の関数を実 router、gate、Native に通す試験（S3 の T4 と同じ構成）で行う（「受入れに加えるもの」、M と T の対処の規則の 5）。journey の結果は、この判定の代わりにしない。
- DA-2 の独立受入れでは、S3 と同じ restricted の試走（T8r と T9r の構成。restricted の profile は「公開」の (b) の状態ファイルで作る）を DA-2 の最終候補で繰り返し、次を記録する。
  - S3 で restricted でも PASS した5件が PASS のままであること。FAIL になれば回帰として DA-2 で直す。
  - `external-write-conflict`（M）が PASS すること。この journey の oracle は非 protected の `tree_nodes` だけを読む（`electron/scripts/product-journeys.mjs:1151-1156`、1190-1199、1205-1209、1228-1235）。PASS しなければ、止まった箇所が製品（M の対処の不足）か journey の前提かを記録し、製品なら PUB-G の前に直す。
  - S3 で製品が原因だった残りの12件は、journey としては FAIL のまま残る。止まった箇所と理由を記録する。
    - `codex-entity-relation-review-apply-reopen`（N）は、S3 で止まった review panel の「未承認」の表示を越えるが、oracle が protected 表（`narrative_extraction_runs`、`narrative_proposal_*`）を renderer の `db_execute` で読むところで止まる（`electron/scripts/codex-entity-relation-product-journey.mjs:74-124`）。
    - `snapshot-native-roundtrip`（M）は、過去の本文を返す `project_snapshot_restore_context` を直接呼んで本文を確かめ（`electron/scripts/product-journey-native-roundtrips.mjs:621-645`。M と T の対処の規則の 2 により restricted では閉じたまま）、oracle も protected の `project_snapshot_tree_nodes` を読む（同 646-660）ので、S3 と同じ箇所で止まる。
    - D の10件（chat 6 件、agent 2 件、Codex の文脈 pin、lint の用語辞書）は、D の機能を試す journey なので止まる。agent の2件は、oracle が `ai_audit_events` を renderer の `db_execute` で読むので（`electron/scripts/product-journeys.mjs:886-898`）、journey の記録からは製品の停止を判定できない（S3 でも先に止まったのは oracle）。D の UI が restricted の typed な理由を示すこと（生の marker、別原因への誤帰属、空の一覧がないこと）は、S3 の T8 と同じ探索（実 Electron で D の各機能の入口を操作し、UI の文言を採取する）で確かめる。
  - oracle が原因だった12件（C2-5B の11件と抽出）は、変わらず oracle の読取の拒否で止まることを記録する。
  - 外への接続の試みを記録する（Negative (17)。「Chromium 自身の通信」）。試走の外への通信の遮断は、Chromium の通信にも効く方法で行い（env の proxy は効かない。S1 §7.1）、network namespace を使うなら `/tmp/.X11-unix` も隔離する（S1 §7.2 では、隔離しなかったために host の X11 socket の path が消えた）。

S3 の結果と分類（O-1）:

| 機能 | restricted 下の現状（S3 rev 2） | 根拠（`a153743b`） | 分類と対処 |
| ---- | ------------------------------- | ------------------ | ---------- |
| 原稿の作成、入力、保存、再起動後の復元 | 動く（journey `editor-persistence` が PASS） | `src/features/editor/persistSceneBody.ts:375`、421-451、lib.rs:9802-9815 | M（済み）。受入れで保つ |
| 伏線の mark がある scene の保存 | Electron は typed の bundle で保存し、拒否されない。Drizzle で `foreshadows` を読む `saveForeshadowAnchors` を呼ぶのは、Electron 以外の経路と、AI が提案した setup を本文へ挿入する操作だけである | persistSceneBody.ts:375、502-511、`src/features/foreshadow/saveAnchors.ts:193-200`、`src/features/foreshadow/foreshadowStore.ts:1163` | M（済み）。AI の setup の挿入は D（AI の機能） |
| workspace の open と切替、backup、restore、Safe Mode の復旧 | open と切替は動く（`workspace-switch-authority` が PASS）。backup と restore と復旧の command は internal | pe.ts:268-269、303、328-329、378 | M。restricted 下で動くことを試験で示す |
| 版履歴（自動と手動の版の記録、一覧、復元） | 記録が無言で失敗し（警告だけ）、一覧も拒否される | `src/features/revision/autoRevisionScheduler.ts:56-69`、98-108、`src/features/revision/api.ts:23-32` | M。記録は typed な writer、一覧は本文を含まない projection、復元は ID で行う（`revision_scene_restore` は internal。pe.ts:332）。過去の本文の表示は D |
| 削除した原稿の復元 | `trash_bin_list` が拒否され、復元するものを選べない | pe.ts:142、`src/features/trash-bin/api.ts:92-98` | M。本文を含まない一覧の projection。復元（`trash_bin_restore`。pe.ts:367）は internal のまま |
| snapshot の作成と復元 | 作成はできるが、復元の文脈（`project_snapshot_restore_context`）が拒否される。汎用 SQL での `project_snapshots` の削除と作成も FK の検査で拒否される（S3 の T3。journey `snapshot-native-roundtrip` が FAIL） | pe.ts:59、320-321 | M。本文を含まない復元の文脈の projection と、typed な削除。適用（`project_snapshot_apply_restore`）は internal のまま |
| 原稿の export（ZIP）と import | ZIP の export は伏線を汎用 DB で読むので常に失敗する。import の会話の部分の書込みも拒否されうる | `src/features/export/zipExport/buildArchive.ts:162-171` | M。protected の部分（会話、伏線、プロットなど）を飛ばして理由を示し、原稿の部分を完了させる。import の protected の部分は、typed な writer で保存するか、理由を示して取り込まない（DA-2 が決める。U3）。黙って捨てない |
| 外部書込みの反映と競合の検出 | feed が `change_events` を payload ごと読んで拒否され、止まる（journey `external-write-conflict` が FAIL） | `src/features/concurrency/externalWriteFeed.ts:542-559`、609-610 | M。payload を返さない typed な projection にし、反映は現在の原稿の再読込で行う（方法は DA-2。U3） |
| Map の編集、Label と Prompt template の作成と更新 | 例外になる（RETURNING の一律の拒否。Map の sticky は protected の `chat_messages` を親に持つ FK） | execute.rs:985-990、`src/features/map/mapApi.ts:244-252`、1457-1484 ほか、`src/features/labels/labelApi.ts:16-33`、`src/features/prompt-library/api.ts:41-48` | T。RETURNING を使わない書込みと再読取、または typed な writer。sticky は typed な writer |
| Related Scenes（R／IR、Evidence の遷移）、A2 review | 拒否される（journey `codex-entity-relation-review-apply-reopen` が FAIL） | pe.ts:63-65、113-117、134 | N（S-1、V-1 を含む） |
| 会話の履歴と chat の session | 読込と保存が拒否され、過去の会話が無言で空に見える。session を作れないので、chat と Codex の文脈 pin が止まる（journey の chat 6 件と `cross-feature-authoring` が FAIL） | `src/features/chat/chatHistoryApi.ts:98-118`、defaultProjectLifecycle.ts:233-238、`src/application/chat/chatSessionStoreActions.ts:329` | D。restricted では chat の入口を閉じる。local 生成の会話の表示と保存は K5／DD-1 で決める |
| 伏線、プロット、lint の無視、用語辞書 | 一覧が拒否され、作成はできる（書けるが見えない。journey `lint-native-roundtrip` が FAIL） | pe.ts:60-62、122-132 | D。作成と編集の入口も restricted では閉じる |
| 全文検索、Codex のハイライト | 拒否される。ハイライトは無言で消える | pe.ts:107、113、`src/features/editor/codexMatchOrchestrator.ts:62-80` | D。Related Scenes の sparse は S-1 で通す |
| 執筆統計、タイムラプスの再生 | `change_events` の payload を読むので例外になる。記録は typed なので続く | `src/features/writing-stats/writingStatsQuery.ts:102-140`、`src/features/timelapse/queryEvents.ts:16-45` | D |
| AI audit の閲覧、検証、export、post-effect の注記と lens、抽出の review と再開、agent の提案の再表示、生成の出所の表示 | 拒否される（audit の export も `ai_audit_read_snapshot` で読む。`src/features/ai-audit/exportBundle.ts:229`） | pe.ts:97-104、133-140、profile_egress_policy.rs:19-104（`prose_staging`、`generation_logs`） | D（O-2 なら通す）。監査の記録は Native が書き続け、閉じるのは閲覧、検証、export だけ。restricted 下での監査の閲覧と export は K5 の draft（`nir1-d2b-local-send-proposal/2`）が K3 に委ねており、この draftRef では閉じたままにする |
| maintenance の inbox | 拒否される（S3 は UI を試していない） | pe.ts:141 | D。要復旧の状態から戻る操作に inbox の表示が要ると分かれば M として扱う（DA-2 で確かめる） |
| 外部 AI の chat、inline、agent、校閲、model の一覧、接続試験、CLI、Codex App Server、MCP の設定 | 拒否（意図どおり。provider への到達 0。S3 の T13） | pe.ts:70-96 | D。PUB-L までは AI の応答を得る手段がない（chat は capture だけ） |
| Vivliostyle の build と preview、外部 URL を開く操作 | 拒否（外部 URL は無言で捨てられる） | pe.ts:94-95、781-784 | D。ほかの形式の書出しは続く |
| license | 定期確認を始めず、activate、revalidate、deactivate を拒否する。trial の終了の後と、手動の再確認の失敗の後に編集が閉じる | 現状の 10 | L（L-1、N-1） |
| 更新の確認、model と IME 辞書の download | 続く（平文を運ばない） | 現状の 16 | 変えない。開示に「続く通信」として書く |
| Chromium の spellchecker の辞書の取得（app の route を通らない） | 続く（平文を運ばない。Google の配信網へ。env の proxy では止まらない） | 現状の 17 | 変えない（X-1）。開示に「続く通信」として書き、DA-2 の試走で外への接続の試みを記録する。Main は spellchecker の言語、辞書の取得先、入力を外部へ送る service を設定しない |

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-d2a-activation-proposal/1 for contractId caller-profile-egress.`

## 確認後の記録（この draft の外で行う）

- 台帳: `caller-profile-egress` の行（l6-l9:98）の draftRef を `nir1-d2a-activation-proposal/1`、confirmedRef を `nir1-d2a-activation-proposal/1#caller-profile-egress` にし、confirmedScope を「proposal/3 の範囲とこの差分」とする。この draft の SHA-256 と確認文を記録する。proposal/3 の本文（l6-l9:121-130）は確認時点の baseline として残す。
- l6-l9 の lane snapshot に D2a の行を加え、残 HOLD 表の「D2a activation」の行（G0 で加える）を更新する。
- DSN §4 と §7 を、確認された区分の名前と構成（S-1 と V-1 の command、A2 の再開の一覧、`license-control` と key の検査と restricted の client、宣言 UI の Native の検査、profile の状態の取得と通知、DA-2 の待ちの上限）と、ProfileActivation の消費を段 1 に置いて予約を作ること（DSN §7.2、§7.3）に合わせる。K2 の宣言と取消の入口（internal）と、K5 が委ねた監査の閲覧と export の扱い（O-1 では閉じたまま）、model の download と Chromium の spellchecker の辞書の取得の扱い（続く通信。X-1）を、それぞれの draft の記録とそろえる。
- integrator は、評価 harness の restricted への対応と R の parity の計測（「品質閾値」）を DA-1 の TASK.md に写し、CP-0 の TASK.md には、harness の trace の検査を DA-1 が役割ごとの件数に改めること（期待値、Gold、arm の mode は変えない）を注記する。
- S3 と S1 の報告、M・T・D の対処の記録を DA-1／DA-2 の PR と作業記録に置き、Session C-1 の開示の材料にする。
- O-2 を選ぶ見込みがあれば、integrator は /2 を起案して独立レビューにかけ、Session B で /1 と並べて示す。
- 確認されなければ、DA-1／DA-2 を `[precheck]` として HOLD 表に残す。別の案（O-2、L-2、N-2、F-2、F-3、J-2、W-2、P-2、X-2、X-3 など）を選ぶ場合は /2 で起案する。

## 確認文

確認は contractId ごとに次の 1 文で行う（l6-l9:108）。

- I confirm draftRef nir1-d2a-activation-proposal/1 for contractId caller-profile-egress.
