# 自分の autosave で editor が read-only にならない直し（EAR）の判断の記録

- 状態：**判断を記録済み（実装前）。ユーザーの回答 4 件は 2026-11-22 に受領済み。** 実装は作業ブランチ `claude/editor-focus-autosave` で PR-1〜PR-4 の順に行う（push・PR・merge は別の指示）。
- 目的：Electron の経路で、作者が打つのを止めて autosave が走るたびに editor が read-only になり、focus が body に落ちて続きの打鍵が入らない不具合を、自分の保存だけ read-only にしないことで根本から直す。
- 正本の起案：`/home/grimodex/fusion-eval-data/design-notes/cp4-final-freeze-prep-2026-11-19/editor-autosave-fence-root-fix-draft.md`（リポジトリの外。改訂 2、2026-11-22）。
  この文書は起案の要点・回答・信頼境界・lifecycle の表・試験の一覧を、実装の前の記録として写したもの。以下の「§」は起案の節を指す。起案と食い違う実装が必要になったら、実装せず起案と報告で扱う。
- ID：`EAR-n`。各 PR 本文にも同じ ID と信頼境界を載せる。AGENTS.md の NIR-1 の事前委任はこの lane に及ばない（NIR-1 の残レーンではない）ので、新しい送信先・保存範囲の拡大・新しい契約や authority は黙って決めない（下の信頼境界のとおり、いずれも無い）。
- 基点：この worktree の HEAD `765d4e1dc`。`c38235bc1` との差分は再現の試験 2 file だけ（`src/features/editor`、`src/features/timelapse`、`src/hooks/useAutoSave.ts`、`src/features/license` で確認）。
  codex／snippet／Rust は `c38235bc1` との差分を見ていない（現 worktree の実体で読んだ）。`origin/master` はさらに進んでいるので、実装の着手時に差分を再確認する。
- 起案の作成と改訂では build・試験・Electron の起動を行っていない。再現の試験（実 Chromium）は 765d4e1dc までに commit 済みで、この文書の commit ではコードを変えない。

## 1. 起案の要点

- **根（§2）：** `acquireTimelapseReplacementFence` が (1) 入力の閉鎖、(2) 文書 lease、(3) commit 時の再基準化 の 3 役を 1 つの同期 API に束ねている。自分の保存に必要なのは (3) と「doc.step と本文 snapshot の順序」だけ。
  (1) が editor を read-only にし、`setEditable(false→true)` で focus が body に落ちて戻らない（実 Chromium で再現済み）。
- **直し（§3）：** 自分の保存（`writer: "editor-autosave"`）は fence も lease も取らず、recorder に「自分の保存の capture hold」を新設する。窓内の `doc.step` は queue でなく hold の buffer に積み、
  Native の commit の後に元の順で queue へ放流する。これで「anchor N より前の step は snapshot（T0）に含まれ、N より後の step は T0 を土台にする」が保たれる。
  外部置換（agent 書込み、revision 復元、undo、rename、project 復元、import、mount）は従来どおり fence で read-only にする（範囲外）。
- **範囲（§6）：** シーン本文（EditorPane、LinearSceneBlock）、設定資料（Codex 本文）、断片（Snippet 本文）。Native／IPC／Rust は変えない。
- **選ばなかった案（§9）：** minimal（fence を残して枝分け）、separate-lease（保存窓＋own-save 用 lease カウンタ）、proof で snapshot を省く案。

## 2. ユーザーの回答（2026-11-22）

| # | 問い | 回答 |
| --- | --- | --- |
| 1 | 範囲：まずシーンだけか | **「全部一度に」。** シーン・Codex・断片を今回まとめて直す（起案の PR-4 も今回に含める） |
| 2 | 保存の時期 (a) 保存中に打った分の次の保存は通常の間隔（初期設定 2 秒）を待つ。(b) 日本語の変換中に、前の保存の伏線の印の更新が届いて未適用のとき、次の自動保存を変換が終わるまで数百 ms ずつ遅らせる。閉じる・切替は遅らせない | **(a)(b) どちらも採用** |
| 3 | 元に戻す・名前の一括変更・履歴からの復元・AI の自動反映・プロジェクトの復元の最中に入力が一瞬止まる現状 | **今回は範囲外**（外部の書き換えの最中） |
| 4 | 保存中に打った分まで執筆履歴（タイムラプス）に正確に残すか | **「残す」**（hold の案） |

## 3. 判断

区別：**決定**＝ユーザーの回答、**技術判断**＝この lane の判断（根拠はコード読み。実行は未）、**確認**＝この改訂でコードを開いて確かめた事実。

| ID | 区分 | 判断 | 根拠・記録先 |
| --- | --- | --- | --- |
| EAR-1 | 技術判断 | 自分の保存は fence も lease も取らず、recorder の capture hold で順序を守る。fence／lease／`useLicenseEditableSync` の述語／pipeline の fence 判定は外部置換の契約として変えない | §2.2、§3.1〜3.4 |
| EAR-2 | 技術判断（改訂 2） | **hold は常に実の hold を開く（inert を廃止）。** 窓の途中で記録可に遷移（bind 完了・切替の終了・ON）しても `queueGeneration` は進まないので、inert だと窓内の step が queue に直行し、anchor より前の seq で T0 に無い step を生む。窓内の step は held／lost／外部 fence 拒否のどれかで、queue に直行しない | §3.3b-1、確認：`invalidateCoverageAuthorities` の呼び手 6 か所に bind 完了は無い |
| EAR-3 | 技術判断（改訂 2） | 世代が進んだ hold は**墓標**として release まで残し、同じ窓の step を捨てる（null、doc は broken。次の保存が `rebaseline`）。valid な receipt を返して捨てる案、queue に通す案は採らない | §3.3b-4 |
| EAR-4 | 技術判断（改訂 2） | **lost（held に穴がある）と broken（recorder の状態）を分ける。** lost は理由を問わず記録し、broken にするかは release の規則が決める（無効・project 不一致・世代不一致では broken にしない）。project 不一致の guard は `markDocumentInputBroken` が持たない、hold 側の新設 | §3.3b-2/6/8 |
| EAR-5 | 技術判断 | hold の owner：scene は tail 操作の内側 `finally`＋外側 `task.finally`（操作が呼ばれずに reject する経路の owner）。codex／snippet は開いた呼び手の `finally`。`release()` は冪等。**release は tail の内側で行う** | §3.2、§3.3 の bodyWriteMode 行、§3.6、確認：`genesisBarrier.ts:251-275` |
| EAR-6 | 技術判断 | scene の hold は、呼び手が渡した `timelapseDocumentIdentity` があるときだけ開く（推測した identity では開かず従来の fence）。codex／snippet は identity が api で一意に作られ storage の推測違いが無い | §3.2、§3.3c |
| EAR-7 | 決定（回答 2） | 保存の時期：(a) 背景の追従保存は debounce（`MAX_DRAIN_RUNS` 維持、flush は即時）。(b) 伏線 mark の更新は変換中は遅らせて必ず適用し、pending があり変換中に次の背景保存の T0 が来たときだけ保存を延期する（新しい値：延期の間隔は数百 ms。PR 本文に記録） | §3.3 の useAutoSave 行、§3.3a |
| EAR-8 | 技術判断（案）。改訂 2 の新しい発見 | 伏線 mark の dispatch は editor が writable な間は `onUpdate` で dirty・`schedule()`（Linear は `editGenerationRef` も）を立てる。今は fence 中の writable ref の偽で隠れていた可能性が高い。**guard（`isApplyingForeshadowRefresh`）は案に留め、既定は入れない（web 経路と同じ）。** 入れると再ロード後の `baseVersion` の引き直しに依存し、その経路を示せなかった。T-8 (h)（保存→再ロード→mark の前に打って保存が `FORESHADOW_VERSION_MISMATCH` にならない）の実測で決める。Linear は T0 の適用を `editGenAtStart` の前に置く | §3.3a-7、確認：`EditorPane.tsx:1158-1190`、`LinearSceneBlock.tsx:518-575`、`useEditorDocumentSession.ts:35`、`refreshForeshadowPayoffMarkVersions` の呼び手 3 か所（`EditorPane.tsx:758`、`LinearSceneBlock.tsx:403`、`foreshadowStore.ts:1260`） |
| EAR-9 | 技術判断 | `useLicenseEditableSync` に同値 guard（望む値が `editor.isEditable` と同じなら `setEditable` を呼ばない）。述語・購読は不変 | §3.3、§5-4 |
| EAR-10 | 決定（回答 1・3） | 範囲：シーン・Codex・断片を今回まとめて直す。外部置換の最中の入力停止は範囲外（従来どおり read-only） | §6 |
| EAR-11 | 決定（回答 4） | 保存中の step は履歴に「残す」（hold の案） | §9、§10 |
| EAR-12 | 技術判断（改訂 2） | codex／snippet は content の捕捉と hold の取得を同じ同期区間にするため、**呼び手が hold を開いて `ownSaveCapture` として api に渡す**（`runTimelapseEditorBodyWrite` に `input.capture`）。`ownSaveCapture` が無い呼び出し（外部の呼び手）は従来の fence。anchor は scene と同形（`agent_writes.rs:3718-3727`、`snippet_writes.rs:686-695` で確認） | §3.3c |
| EAR-13 | 技術判断 | 追従保存が外部置換の lease に当たった `DocumentMutationLeaseActiveError` は、背景の保存では toast なしの silent retry（dirty 維持、debounce 間隔）。flush は従来どおり throw | §3.3 の useAutoSave 行 (b)、T-5 |
| EAR-14 | 技術判断 | hold の件数・時間の上限と bounded wait を新設しない（hold は memory だけ、窓は Native commit の長さで有界）。長い hang は今の fence でも同じで、hold は editor を止めないので悪化しない | §3.5、§3.6 A17 |
| EAR-15 | 技術判断（PR-3 の実装で記録） | **新しい値：** 伏線 mark の更新が変換中で適用できないとき、背景の保存を延期して張り直す間隔は **300 ms**（`SAVE_DEFER_RETRY_MS`、`src/hooks/useAutoSave.ts`）。通常の debounce（既定 2000 ms）より短く、変換が終われば次の試行が通る。上限は置かない（変換が終われば解ける）。延期の間に作者が打てば次の試行は通常の debounce に戻る。flush（閉じる・切替・手動保存）は延期しない。pending が無い場面（伏線 mark の無い場面を含む大半）には影響しない | §3.3 の useAutoSave 行 (a)、§3.3a、§8-9 |
| EAR-16 | **起案との食い違い・確認待ち**（PR-3 の実装で記録。コードは実装済み。起案どおりに戻す場合は下記の変更箇所） | **peer の保存の通知は、自 editor が変換中なら処理を遅らせる。** 起案の「`setContent` は適用しないが `advancePeerSave` は行う」は、古い本文のまま版だけ進めて後の保存が peer の編集を上書きしうるので採らず、「通知ごと遅らせ、変換が終わった後（compositionend／blur）に同じ通知を処理し直す（版も本文もそこで進める）」にした。処理し直す時点で dirty なら従来どおり何もしない（保存の OCC が競合を示す）。flush で変換を確定させるときの blur は、flush（手動保存を含む）の T0 で伏線 mark の pending があり変換中のときだけ起きる。**起案どおりに戻す場合の変更箇所：** `EditorPane.tsx`／`LinearSceneBlock.tsx` の `persistedBindingHandler` の `isEditorComposing` の分岐（`deferredPeerPersistRef` への退避）を、「`setContent` を飛ばして `advancePeerSave` だけ行う」に置き換え、`installCompositionIdleListener` の onIdle から peer の処理し直しを外す | §3.3 の EditorPane 行、§5-2 |
| EAR-17 | 技術判断（PR-4 の実装で記録。起案どおり） | **codex／snippet の接続。** 呼び手が content の捕捉と同じ同期区間で `openOwnSaveCapture` を開き、`updateText`／`snippetStore.update` の `ownSaveCapture` として `updateCodexEntry`／`updateSnippet` に渡す。api は `data.content` と `ownSaveCapture` があるとき `runTimelapseEditorBodyWrite({ capture })` を使い、無ければ従来の fence（`runTimelapseBodyWrite`／`runTimelapseBodyReplacement`）。snippet は `timelapseDocument` が付いていても `ownSaveCapture` を優先する。codex は `persistTextPatch` の `data.content !== undefined` の先頭（content を確定する呼び手と同じ同期区間）で開き、`enqueueVersionedWrite` の writer の内側の `finally` と外側の `finally` の両方で release する（`writeTailRef` の先行書込みの失敗の後も残らない）。snippet は `saveFn` の `getHTML()` の直後で開き、`onSave` の `finally` で release する。**web でも挙動が変わる：** 両 api は `isElectron` の分岐を持たず、これまで web でも保存の間 fence で editor を read-only にしていた。この変更で web も hold に替わる（recorder が無効なら release は何もせず捨てるだけで、editor は writable のまま）。scene は web で fence を取らない（`runTimelapseMutation`）ので、これで 3 種の本文が揃う。codex の key の `projectId` は `entry.projectId`（`CodexContentEditor` が authority を作る `projectId` と同じ値）、snippet は `snippet.projectId` | §3.3c |
| EAR-18 | 技術判断（レビューの order 指摘。起案の §3.6 A12・A19 への追加） | **外部置換の commit は、同じ文書（project 全体の fence なら同じ project）に開いたままの hold の held を捨て、その hold の `rebaseline` を解く。** codex／snippet は呼び手が hold を writer が project tail に載るより前に開くので、先行書込みを待つ間に外部置換（undo／agent／revision 復元）が先に tail に載って snapshot M を commit しうる。そのとき held は置換前の本文を土台にした step で、M の後ろに放流すると再生が食い違う。置換の間 editor は read-only なので、commit 時点の held はすべて置換前の step。lost／broken にはしない（M が再基準化する）。T0 で broken だった hold は、置換の commit が broken を解いた後に打たれた step を own の失敗の release (5) が黙って捨てて穴にしないよう、`rebaseline` も解く。置換が commit されなければ（失敗・release のみ）捨てない。**前提の確認（コード）：** 文書の identity 付きの fence は本文を書く・消す書込みだけが取る（codex の `updateCodexEntry`／agent の codex 書込み／`createCodexEntry`、snippet の同等の経路は、いずれも `content` を伴うときだけ fence で、content なしの更新は fence を取らない `runTimelapseMutation`）ので、summary／notes／name／構造パッチ・phase body の書込みで held を捨てることは無い。scene は open と tail への enqueue が同期で FIFO が一致するので、commit の時点で hold は release 済みで変わらない。**残る穴：** project 全体の fence で、置換されなかった別文書の hold の置換前の step も捨てる（再生に小さな穴。その文書は次の保存の snapshot が再基準化する。codex／snippet の先行書込み待ちの隙と project 全体の置換が重なるときだけ）。診断は件数だけ（本文なし） | §3.6 A12・A19、`recorder.ts` の `supersedeOwnSaveCapturesByReplacement` |
| EAR-19 | **起案との食い違い・確認待ち**（レビューの ime-ux 指摘。起案 §3.3a-2 (i)「compositionend の次の task」） | **idle の適用（compositionend 経路）は、compositionend の後 250 ms 静止してから行う。** 連続入力では compositionend の直後に次の compositionstart が来るので、0 ms の timer が両者の間に doc を変える transaction を入れうる。静止の間に compositionstart が来れば取り消し、keydown／beforeinput が来れば静止を数え直す。**新しい値：`COMPOSITION_QUIET_MS = 250`。** blur の適用・T0 の直前の適用・flush は不変。compositionend 経由の適用をやめる案は採らない（同じ onIdle に EAR-16 の peer 通知の処理し直しが乗っていて、blur まで取り残される）。実 IME での連続入力は未確認。**起案どおりに戻す場合：** `pendingForeshadowRefresh.ts` の `installCompositionIdleListener` の `arm` を `setTimeout(fireIfIdle, 0)` にする | §3.3a-2、§5-1 |
| EAR-20 | **起案への追加・確認待ち**（レビューの ime-ux／lifecycle 指摘。起案 §3.3a-4 は保つ） | **flush の T0 で変換中に blur して composition を確定させたら、適用の後に focus を戻す。** flush は手動保存・agent の自動適用・rename・post-effect など editor を閉じない呼び手も通り、blur は作者の focus を奪って続きの打鍵が body に落ちる（本件で直す不具合と同じ症状）。blur の前の `view.hasFocus()` を覚え、editor が生きていれば `view.focus()` で戻す。起案どおり blur と force 適用は残す（種別を lifecycle／非 lifecycle に分けて呼び手へ通す案は、`useAutoSave`・quiescence・registry・unmount の全経路の変更になるので採らない。focus 復帰で足りない実機の挙動が出たら切り替える）。**残る：** 変換が blur で確定されること自体（IME の変換の途中経過は失われうる）は変わらない。実 IME での確認は未了 | §3.3a-4、§5-3 |
| EAR-21 | **起案との食い違い・確認待ち**（レビューの ime-ux 指摘。EAR-15・§3.3a-3「上限は置かない」の前提の訂正） | **固着した変換は、変換中と見なさない。** prosemirror-view 1.42.3 の source で確認：compositionstart／update／end は `view.editable` が偽の間処理されず（`initInput`）、desktop に composing の時間切れは無く（`timeoutComposition = android ? 5000 : -1`）、blur でも解けない。変換中に外部置換などで read-only が挟まり、その間に compositionend が来ると `view.composing` が真のまま残る（実 Chromium で `editorFocusAutosaveFence.browser.test.tsx` が固定）。そのまま「上限なし」だと背景の保存が無音で延期され続ける。`isEditorComposing` に、composition・打鍵の最終活動（compositionstart／update／end、keydown、beforeinput）から 10 秒以上経った composing は固着と見なして false を返す判定を足す（T0 の適用と blur の適用が解ける。compositionend の後も composing が固着したままなら、静止の timer が固着と見なされるまで見張り、解けた時点で idle の適用と peer の処理し直しも行う）。固着と見なすとき件数なしの診断 warn を 1 回出す。**新しい値：`COMPOSITION_STALE_MS = 10000`。** 変換が 10 秒以上無活動の本物の変換は、固着として扱われ、mark の dispatch が変換中に入りうる（稀）。listener を付けない editor には効かない（従来どおり）。**起案どおりに戻す場合：** `isEditorComposing` の固着の分岐を外す | §3.3a-3、§5-1、§8-9 |
| EAR-22 | 技術判断（レビューの lifecycle 指摘。EAR-13・EAR-15 の「上限なし」は維持） | **背景の保存の silent defer／silent retry の連続を観測する。** 開始時刻と回数を `createAutoSave` の中で持ち、10 秒続いたら `debugLog.warn` を 1 回だけ出す（operation〔`save-defer`／`lease-retry`〕・回数・経過 ms だけで本文は出さない）。保存の成功・失敗（toast になる経路）・`cancel` で数え直す。止める上限ではない。**新しい値：`SILENT_RETRY_WARN_MS = 10000`。** 「defer が閾値を超えたら背景側も force 適用に切り替える」案は採らない（EAR-21 の固着の判定が原因の側で解くので、`useAutoSave` に composition の知識を持ち込まない）。lease の silent retry は外部置換が hang すれば続くが、診断が残る | §3.3 の useAutoSave 行、§3.6 A14 |

## 4. 信頼境界

- **新しい送信先は無い。** renderer の中の recorder の buffer と、既存の `timelapse_append_batch`／本文保存の IPC しか使わない。外部 egress・subprocess・背景 process は増えない。
- **保存範囲の拡大は無い。** hold の buffer は memory だけで何も永続しない（再起動後の状態は無い、§3.6 A16）。永続するのは Native が書く snapshot と step だけで、内容・形式は変えない。診断の warn は件数だけで、本文・step の中身は出さない。
- **新しい IPC・contract・authority は無い。** Native／IPC／Rust は変えない。`writer` と `ownSaveCapture` は renderer の中の引数で、既定は「外部」（付け忘れ・外部の呼び手は従来の fence に倒れる）。renderer 由来の coverage proof を信用して snapshot を省くことはしない（§9）。
- **閾値の変更は無い**（確認台帳の閾値・Gold に触れない）。新しい値は背景保存の延期の間隔（300 ms、EAR-15）と、レビューの指摘で足した COMPOSITION_QUIET_MS（250 ms、EAR-19）・COMPOSITION_STALE_MS（10 s、EAR-21）・SILENT_RETRY_WARN_MS（10 s、EAR-22）で、PR 本文に記録する。
- **actor：** 作者（編集と autosave）が信頼される actor。外部置換（agent 書込み、revision 復元、undo、import、mount）は別の writer で、fence が従来どおり editor を閉じて衝突を防ぐ（OCC：Native の `version`、`mutationGate.commitSave`、`useAutoSave` の合体）。
- **守る防御：** (1) anchor N より前の step は snapshot に含まれ、N より後は T0 を土台にする、(2) 保存中の打鍵は本文・dirty・追従保存に入る、(3) 外部置換との競合は fence／lease／OCC が防ぐ、(4) 付け忘れは安全側（従来の fence）。

## 5. hold の規則（起案の §3.3b を写したもの。以下の表が引く規則）

hold の状態：`{ documentKey, projectId, generation, cutoffs, rebaseline, held[], lost, committed, tombstoned, released }`。`activeOwnSaveCaptures`（Set）に載せる。
`cutoffs` は取得時の各 `acceptedPrefix`（`acquireTimelapseReplacementFence` と同じ取り方、`recorder.ts:962-1018`）、`rebaseline` は取得時の `documentCaptureIsBroken(scope)`。

**1. open は常に実の hold（確認：コード読み）。**
窓の途中で記録可に遷移する経路は `queueGeneration` を進めない。`invalidateCoverageAuthorities` の呼び手は `setRecorderEnabled(false)`（`:1094`）、`beginWorkspaceSwitch`（`:1143`）、
`invalidateWorkspaceBindingForLifecycle`（`:1198`）、`resetRecorderChain`（`:1386`）、`_resetRecorderForTests`（`:1414`）、`discardPendingTimelapseEvents`（`:1815`）の 6 か所で、
`initRecorderForProject` の完了（`:1306`、`:1360`）、`endWorkspaceSwitch`、`setRecorderEnabled(true)` は含まれない。
したがって取得時に inert にすると、窓内に bind が完了した後の step は hold を経由せず queue へ直行する。直行した step は (i) debounce の flush timer（`scheduleFlush`、`:1597`）が Native commit より先に流すか、
(ii) 次の `flushStrict` が anchor より前に流し、「seq は anchor より前なのに T0 の snapshot に含まれない step」になる（§2.2 の不変条件の破れ）。
従来は fence が窓内の step を捨てていたので無かった穴で、改訂 1 の inert 案が持ち込んだものだった。
採らなかった案：「inert のまま、窓内で記録可に遷移したら lost 扱い」。遷移の検出点が 3 か所以上（bind 完了、切替の終了、ON）要り、検出漏れがそのまま順序違反になる。実の hold なら検出点は要らない。

**2. 窓内の `doc.step` の分類**（`recordChangeEvent` の入口。対象は同じ documentKey の最新の未 release の hold。上から順）。
 (i) 外部 fence が一致 → 従来どおり（捨てる・null・lost にしない。admission denial）。実際は pipeline が `isTimelapseReplacementFenceActiveForDocument` で recorder に来る前に return する（`sceneEditorTransactionPipeline.ts:203-213`、`miniEditorTimelapse.ts:108-117`）。
 (ii) hold が墓標 → 捨てる（null）。held に入れない。`markDocumentInputBroken` を従来どおり呼ぶ（enabled のときだけ doc を broken にする）。
 (iii) 「broken 以外の判定」が通り、hold の `projectId` が `getTimelapseGenesisCaptureTargetProjectId() ?? state.projectId` と一致 → `createPendingEvent(…, "committed")` を `held` に積み、通常と同じ receipt（`createDocumentStepReceipt`）を返す。queue・`acceptedPrefix`・flush timer には触れない。
 (iv) それ以外（無効・未 bind・切替中・project 不一致・`bindingInvalidated`）→ 捨てる（null、従来どおり `markDocumentInputBroken`）。**理由を問わず `lost = true`**。
**不変条件：窓内の `doc.step` は「held に積まれる」「lost に数えられる」「外部 fence に拒まれる」のどれかで、queue に直行しない。**
lost は「held に穴がある」ことだけを表す。recorder の状態（broken）にするかは release の規則 (3) が決める（無効の間に落ちた step の後で bind されても、穴のある held は放流しない）。

**3. 壊す経路への連動。** `markDocumentScopeBroken`（`:532`）／`breakTimelapseDocumentCapture`（`:712`）が当たった文書の open な hold（墓標を含む）は `lost = true`。
pipeline の `captureAccumulator.accept(null)`→`markBroken`→`breakTimelapseDocumentCapture` は `enabled` を見ずに broken を作る（`documentCoverage.ts:57-66` と `sceneEditorTransactionPipeline.ts:229-240`、確認）ので、`serializeTransactionSteps` の throw などもここで拾う。

**4. 世代を進める経路（墓標）。** `invalidateCoverageAuthorities` は全 hold を `tombstoned = true` にし、`cutoffs` を空にし、`held` が空でなければ**件数だけの診断 warn を 1 行**出して `held` を捨てる（本文・step の中身は出さない）。
hold は set から消さず release まで残す。墓標は 2-(ii) で同じ窓の step を捨てる（捨てた結果 doc は broken になり、次の保存の hold が `rebaseline` で再基準化する）。
採らなかった案：「墓標を残さず、後続の step を queue に通す」。OFF→ON の rebind や `resetRecorderChain` は editor を read-only にしないので、通すと anchor より前の seq で T0 の snapshot に無い step を生む。
「捨てて valid な receipt を返す」案も採らない（recorder に穴がある状態を accumulator に健全と伝える）。代償：窓内の OFF→ON では editor の accumulator が壊れ、その editor の履歴記録は閉じるまで戻らない（§8-3 の既存の性質。従来の fence でも OFF 中は null だった）。

**5. `commit()`。** released／墓標／lost なら何もしない。それ以外は `committed = true` とし、`cutoffs` の各 state について `broken = false`、`durablePrefix`／`committedPrefix` を `max(現在値, cutoff)` に進める（現行の `fence.commit` と同形。lease は呼ばない）。
cutoff に載らない state（窓内の held で作られたもの）には触れない。

**6. `release()`（冪等）。上から順：**
 (1) released 済みなら何もしない。`released = true` にして set から外す。
 (2) 墓標 → 何もしない（`held` は空。broken にも触れない）。
 (3) `!state.enabled`、または hold の `projectId` が現在の recorder の project と不一致、または取得時の世代と不一致 → `held` を捨てる。broken には触れない（`flushNow` は `!state.enabled` で queue を空にし、不一致 project は "mixed Project authority" で throw する、`:1620-1660`。OFF 後に stale な editor の 1 打で epoch を作り直さない）。
 (4) `lost` → `held` を捨て、その文書の state を `broken = true` にする。
 (5) `rebaseline` かつ未 commit → `held` を捨て、broken を残す。
 (6) それ以外 → `held` を元の順で `state.queue` 末尾へ移し、各 `doc.step` に `acceptPendingDocumentStep` を適用し（ここで `acceptedPrefix` を加算）、`scheduleFlush()`。

**7. 複数の hold が同じ文書に開いた場合。** step は最新の未 release の hold が受ける（最新が墓標でも、より新しい生きた hold があればそちら）。release は tail の FIFO で、先の hold が先。

**8. 事実の帰属（付録の指摘への回答）。** 上の (3) の (a)（`enabled` が false なら broken にしない）と、外部 fence 一致で poison しない（2-(i)）は、`markDocumentInputBroken`（`recorder.ts:536-553`）が実際に持つ前提。
**project 不一致の guard は同関数が持たない**（同関数は `input.projectId ?? captureTarget ?? state.projectId` で scope を決めるだけで、現在の project と比べない）。hold 側で新しく足す guard（`flushNow` が混在 project で throw することへの備え）である。

**9. 試験の reset。** `_resetRecorderForTests` は墓標にせず `activeOwnSaveCaptures` を空にする（release されなかった墓標を次の試験に残さない）。本番の無効化の経路（OFF・切替・lifecycle・chain reset・discard）は墓標にする。

## 6. lifecycle の表（GDX-PRECHECK-001 の finite matrix。起案の §3.6）

hold の owner：scene は「hold を開いた `runTimelapseEditorBodyWrite` の tail 操作」（open は同じ関数の同期区間）。codex／snippet は「hold を開いた呼び手」（§3.3c）で、api に届いた後は tail 操作が先に release する。
release は冪等で、**終了の証拠は `released === true`（`activeOwnSaveCaptures` から外れたこと）**。試験は set の大きさが 0 に戻ることを見る。reject・error 通知だけを終了の証拠にしない。

### 6.1 表 A：事象 × hold（規則の全文は起案の §3.3b）

| # | 事象 | 保留 step | hold の状態・broken | 試験 |
| --- | --- | --- | --- | --- |
| A1 | open（T0、同期。await なし） | — | 常に実の hold。世代・cutoff・`rebaseline` を記録。記録可でなくても開く | T-2、T-3 (m) |
| A2 | 窓内の doc.step（記録可） | held に積む（queue に触れない） | — | T-1、T-3 (a) |
| A3 | 窓内の doc.step（無効・未 bind・切替中・project 不一致） | 捨てる（null） | `lost = true`。release が (3) で broken にするか決める（無効のままなら broken にしない） | T-3 (m)(n) |
| A4 | 窓内の doc.step（外部 fence が一致） | 捨てる（外部が優先） | lost にしない | T-3 (o)、T-5 |
| A5 | 窓内で**記録可に遷移**（bind 完了・切替の終了・ON。世代は進まない） | 以後の step は A2。遷移前に落ちた step があれば lost のまま | hold は生き残る（inert 廃止の理由） | T-1 (f)、T-3 (m2)〜(m4) |
| A6 | `breakTimelapseDocumentCapture`／`markDocumentScopeBroken` | 以後も受ける | `lost = true`（held に穴）。commit は broken を解かない | T-3 (k)(l) |
| A7 | 世代が進む（OFF、切替の開始、lifecycle の無効化、chain reset、quiescence の discard） | held を捨てる（件数だけの warn 1 行） | **墓標**。release まで残り、同じ窓の step は捨てる（null、doc は broken）。commit は no-op、release は何もしない | T-3 (q)(r)(s) |
| A8 | flushStrict が throw | release で queue 末尾へ（T0 以前の未 flush の後ろ）。`rebaseline` なら捨てる | commit 無し | T-3 (c) |
| A9 | Native commit が失敗／結果不明（IPC 応答欠落） | A8 と同じ。tx の後に入るので順序は壊れない | broken は触らない | T-1 (d)(e)、T-3 (c) |
| A10 | Native commit 成功 | `commit()` の後に release → queue 末尾へ | lost でなければ `broken = false`（現行の `fence.commit` と同じ。非 `rebaseline` は元から false） | T-1、T-3 (b)(e) |
| A11 | 操作が呼ばれずに reject（`runAfterTimelapseGenesis` の stale／genesis 失敗・abort） | 外側の `task.finally(release)` が owner。snapshot は無いので held は queue 末尾へ（順序は保たれる）。lost／`rebaseline`／墓標なら捨てる | A8 と同じ | T-3 (t)、T-6 |
| A12 | 同じ文書の 2 つ目の hold | 新しい step は最新の hold へ。release は FIFO | scene は `saveTails` で重ならない。codex／snippet が重なるかは **〔未確認〕**（`useAutoSave` の drain が `saveFn` を直列に待つなら重ならない）。重なる場合は release を `writeTailRef` に載せる writer の内側の `finally` にも置く（起案 §3.3c-4） | T-3 (g)、T-11 |
| A13 | 外部 fence が窓の途中で開く | editor は read-only、step は外部 fence 側で捨てる。own の hold は own の commit 後に放流 | tail が FIFO なので外部置換の `flushStrict` より先に放流される | T-5 |
| A14 | 窓の入口で外部の lease が active（追従保存が `DocumentMutationLeaseActiveError`） | **hold は開かれない**（`runCoordinatedDocumentSave` の入口で throw、T0 より前） | 背景の保存は toast なしの silent retry、flush は throw | T-5 |
| A15 | editor の unmount／破棄が窓の途中 | hold は editor に依存せず tail が続く。破棄後の step は来ない。閉じる・切替の保存は flush（`preexistingDraft`）で、延期しない | release は通常どおり | T-6 (1)、T-8 (f) |
| A16 | renderer の crash／reload が窓の途中 | hold は memory だけで**何も永続しない**。held は消える（保存前の打鍵が消えるのは従来の crash と同じ） | Native の tx が commit 済みなら snapshot（T0）が残り、無ければ前の snapshot が最新。再起動後は新しい session で、次の保存の snapshot が再基準化する | T-3 (q) |
| A17 | tail が結果不明のまま長く滞る（IPC が返らない） | held は積み上がる（memory だけ、1 件数百バイト程度の推測） | **bounded wait は新設しない**（§3.5）。今の fence も同じ hang で開いたままで、editor ごと止まる。hold は editor を止めないので editor 側は悪化しない。ただし**release が来ない hang では、墓標は窓内の step を捨て続け、生きた hold は held を積み続ける**（墓標は捨てた step の分 doc を broken にする）。滞りは保存の失敗・abort で終わり release が働く | T-3 (j)、実測は実装時 |
| A19 | codex の `writeTailRef` 待ち（hold は呼び手が開いたまま、api に届く前） | 窓内の step は held に積む。先行書込みの失敗の後も呼び手の `finally` が release | 呼び手の `finally` が owner（起案 §3.3c-3） | T-11 (a)(b) |
| A20 | `SaveDeferredError` による保存の延期（伏線 mark の pending と変換中） | **hold を開く前に戻る**（`saveLatestFn` が `captureSave` より前に返す）ので hold は無い | silent retry の timer だけが残る | T-8 (c) |
| A18 | genesis 待ち | hold は保留し続ける。baseline（anchor=0）より前には並ばない | 上限は置かない | T-3 |

### 6.2 表 B：GDX-PRECHECK-001 の項目

| 項目 | 本案での扱い |
| --- | --- |
| entry／start／retry／reentrant | entry は 4 つ（EditorPane の背景保存・flush・手動保存、LinearSceneBlock、codex／snippet の `saveFn`）。すべて `persistSceneBody`／`updateCodexEntry`／`updateSnippet` の同期区間で hold を開く（scene は `timelapseDocumentIdentity` が渡るときだけ。無ければ従来の fence）。retry は `useAutoSave` の debounce（silent retry を含む）で、再 entry は新しい hold。reentrant（保存中の保存）は `saveTails`／`projectBodyTails` の FIFO で直列化され、hold は A12 |
| admission closure | 自分の保存は何も閉じない（editor は writable のまま）。閉じるのは外部置換の fence／lease だけで、hold より優先（A4、A13、A14）。墓標は同じ窓の step を捨てて閉じる（A7） |
| pending-start work | genesis 待ち・project tail の順番待ち。hold は open 済みで、その間の step を保留する（A18）。tail に載る前に reject した場合は外側の `task.finally`（A11） |
| active handle の owner | scene：tail 操作（内側 `finally`）＋外側 `task.finally`（操作が呼ばれない場合）。codex／snippet：開いた呼び手の `finally`＋api の内側 `finally`。どれも冪等な `release()` |
| cancellation | recorder の OFF・切替・lifecycle 無効化・chain reset・quiescence の discard は墓標（A7）。保存自体の cancel は無い（既存どおり。失敗・abort で終わる） |
| bounded wait | **新設しない**（A17、§3.5）。genesis 待ちと Native commit の既存の待ちに従う。quiescence の autosave stage の flush は保存の完了を待つ（`useAutoSave.ts:500-545`、`quiescenceCoordinator.ts:127`、`:208`、`:236`） |
| actual termination evidence | `released === true`／`activeOwnSaveCaptures` が空（試験 hook）。Native commit の結果は bundle の応答。kill／error 通知だけは証拠にしない |
| error／timeout／onClosed の owner | error は内側 `finally` が release（A8、A9）。timeout は無い（A17）。onClosed に当たる editor の破棄は A15 |
| persisted restart state | **無い**（A16）。hold・墓標・held は memory だけ。永続するのは Native の snapshot と step だけで、順序は §2.2 の不変条件で守る |

## 7. 試験の一覧（起案 §4・§7。試験 file は実装の PR で作る）

| ID | 内容 | 水準 |
| --- | --- | --- |
| T-1 | 保存の開始後の 6 点（flushStrict の前・IPC の間・後、bundle の IPC の間、応答の後、**窓内の bind 完了後**）で打った step が、最新 snapshot＋`seq > anchor` の再生で最終 doc と一致する。commit 失敗の分岐も | unit／fake（中核） |
| T-2 | hold の取得が serialize と同じ同期区間（`persistSceneBody` の top-level に await が入ったら落ちる） | unit |
| T-3 | recorder 単体：(a)〜(l)（保留・放流・commit 失敗・lost・T0 broken・世代・重なり・fence・durable≤accepted・FIFO）、(m)〜(m4)（無効の全体／窓内の bind 完了／穴のある held／enable ON）、(n) project 不一致、(o) 外部 fence、(p) key の食い違い、(q) discard／abort、(r) 墓標、(s) 墓標と生きた hold、(t) release の owner（操作が呼ばれずに reject） | unit／fake timer |
| T-4 | 実 Chromium：autosave の間 editable が true、保存後も focus が editor、保存中の文字が本文に入り dirty・追従保存が走る（悪い直しの検出を含む）。Linear も | browser（既存の再現の反転） |
| T-5 | 外部置換は従来どおり read-only。own の in-flight 中の外部置換の順序と OCC。追従保存と lease の重なりは toast なしの silent retry | unit＋browser |
| T-6 | `runTimelapseEditorBodyWrite` の間 own の lease が無く `saveTails` で直列化。`preexistingDraft`／`didCommit` | unit |
| T-7 | `createAutoSave`：保存の所要より短い間隔の連続入力で背中合わせに走らない。flush は即時 | unit／fake timer |
| T-8 | 伏線 mark の遅延適用（保存中に mark より前へ打つ・composing 中の保存結果・延期・flush・破棄・Linear）と、(h) **dispatch の後の追従保存が有界で、保存→再ロード→mark の前に打って保存が通る**（guard の要否を決める実測） | browser＋unit |
| T-9 | `useLicenseEditableSync` の同値 guard（unit、実 Chromium、codex の autosave 中に scene を打つ journey） | unit＋browser |
| T-10 | bind した recorder と実 EditorPane の結合（receipt で accumulator が壊れない、key の一致） | browser |
| T-11 | codex／snippet：捕捉と hold が同じ区間、呼び手が開いた hold の release、`ownSaveCapture` なしは従来の fence、実 Chromium | unit＋browser |

既存の試験の扱い（§7）：再現 2 file のうち対照は変えず、【不具合】の 3 本は期待値を反転、click で復帰の 1 本は改名または削除、fence の事実固定は残す。

## 8. 実装の順序（起案の末尾。今回は PR-4 まで含める）

1. PR-1：`useAutoSave` の追従を debounce に（T-7）。独立で入れられる。
2. PR-2：recorder の hold＋`runTimelapseEditorBodyWrite`（呼び手なし、挙動不変。T-1、T-3）。この文書と lifecycle の表を先に記録済み（この commit）。
3. PR-3：シーンの接続（`writer` と identity、伏線 mark の遅延適用、同値 guard、silent retry、再現試験の反転、LinearSceneBlock、T-4〜T-6、T-8〜T-10）。
4. PR-4：codex／snippet（呼び手が hold を開く署名の変更、T-11）。

各 PR は作業ブランチで、変更 file を明示して stage し、Quick と実 Chromium の関係 file だけの試験で検証する。この lane は NIR-1 の残レーンではない。merge・push は別の指示で行う。

## 9. 未確認（実装時に確かめる）

- 実機の IME（変換中の遅延適用・延期・flush の composition の確定）。repo に IME の試験は無い。
- 伏線 mark の dispatch の writable ref の更新時期（推測）。web 経路の追従保存が連鎖しないこと（version が変わらなければ止まる見込み）。
- ~~`persistTextPatch` の content の確定点、`snippetStore.update` 前後に await が無いこと、project 段が窓内の入力を巻き戻さないこと。~~ **PR-4 で確認済み（EAR-17）：** 確定点は `persistTextPatch` の先頭（content は呼び手の `contentRef.current`）、`snippetStore.update` は `updateSnippet` を同期で呼ぶ。project 段が窓内の入力を戻さないことは実 Chromium の試験（`codexContentFocusAutosave`／`snippetContentFocusAutosave`）で確認。
- codex／snippet の hold が重なるか：同じ instance の `saveFn` は `useAutoSave` の単一 drain（`useAutoSave.ts:357`）が直列に呼ぶので重ならない。別 instance（unmount の flush と新しい mount の保存）の間は重なりうるが、recorder の規則（最新の hold が step を受け release は FIFO、A12）と、release を writer の内側にも置く形で受ける（重なりの実機の確認はしていない）。
- replay／export の実機の見え方（再生は最新の snapshot 以降の step だけを使うように読める。§8-7）。時刻と sequence の逆転を `frameProducer`／`exportTimelapse` が前提にしていないか。
- 窓内の OFF→ON（墓標）の後、editor の accumulator が閉じるまで履歴が戻らないこと（既存の性質の延長。§8-3）。
