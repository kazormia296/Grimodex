# 削除の undo で DB の行を削除前に戻す（DR-UND-1・DR-UND-2）

作成：2026-11-23。lane E1。計画書は `fusion-eval-data/handoff/mastra-mp3-materials/plan-undo-ipc-20261124.md`（反証の記録が本文に優先）。

## DR-UND-1 削除の undo で DB の行を削除前の状態に戻す

ユーザー承認：2026-11-22「`tree_node_create` の payload に欄を足す」（IPC の契約の変更）。2026-11-23「全部戻す」（欠落している列を全部。取りこぼしを残す案ではない）。

### a. 欠落していた欄と、戻す欄・戻さない欄

削除は `tree_nodes` の行を `DELETE` する。undo は `tree_node_create` を呼ぶが、INSERT は 14 列（id・project_id・parent_id・node_type・title・sort_order・synopsis・status・source_uri・source_mtime・content・char_count・created_at・updated_at）だけで、renderer は source の 2 列と note の本文も渡していなかった。store は削除前の値を全部持つので、store だけが元に戻り、DB は欠落した行のまま reload まで食い違っていた（DR-MP4-8、K-5 (8)、PR-6 の記録 11、Q5 (b)）。

- 戻す（`restoreState` の 19 欄）：`intent`・`storyTimeOrder`・`storyTimeLabel`・`povCharacterId`・`locationId`・`contextMode`・`aliases`・`excludedAliases`・`unplacedBeatsDoc`・`unplacedBeatPreview`・`placedBeatPreview`・`createdAt`、と年表の 7 列（下の「年表の 7 列」）。
- 既存の欄で戻す：`sourceUri`・`sourceMtime`・note の `content`。note の本文は store の値でなく、削除の直前に DB から読んだ行の値（store の `content` は開いた時点の値で、編集の後は古い。反証 P1-2）。
- 戻さない：`version`（0 のまま）・`updated_at`（作り直した時刻）・`char_count`（content から計算）。Source token `v{version}@{updated_at}` が前のどの値にも戻らないための選択。代わりに renderer が create の応答の `version`・`updatedAt` を store に反映する（Chronicle の一括操作は store の `updatedAt` を OCC の token に使う）。
- 年表の 7 列（`chronicleStartTime`・`chronicleStartMinute`・`chronicleStartGranularity`・`chronicleEndTime`・`chronicleEndMinute`・`chronicleEndGranularity`・`chroniclePrecision`）：**1 組として戻す**（開始・終了・precision は組で意味を持つ。年表 lane の返事）。当初は CED/1 の担当との調整のため保留したが、ユーザー決定「全部戻す」（2026-11-23）と、書込みの検証が行の中だけで決まることを確かめて（c）、戻すことにした。
- 除外：`archived_at`（tree store は archived でない行だけを持つので、戻す node は archived でない）。

### b. 契約

- 既存 command `tree_node_create` の payload に、入れ子の optional `restoreState` を足す。新しい command・権限・保存範囲の拡大はない。`deny_unknown_fields`。`null` と欠落は同じ（触らない）。
- `origin` が `undo` のときだけ受ける。redo・human・import・restore・migration は拒む（反証 P2-6。Undo Journal の `op_kind == delete` と対）。Native・Main・browser mock の 3 層で同じ。
- **3 層で同じなのは、origin の gate・key 集合・型（nullable string／nullable 安全な整数）・年表の組と語の検査（granularity・precision の列挙）まで。** 値の中身の検査（`contextMode` の 4 値・`aliases` 系の JSON 配列・`unplacedBeatsDoc` の JSON 配列・`createdAt` の形・POV／場所の project 所属）は Rust と browser mock だけで、Main は掛けない（Main は引数の形の再検証。値の意味は書き手の Native が決める）。Native は Main を通らない経路でも同じ値を検査する。key 集合が 4 か所（Rust の `TREE_NODE_RESTORE_COLUMNS` と `TreeNodeRestoreState`、Main の `TREE_NODE_RESTORE_STATE_KEYS`、mock の `BROWSER_TREE_RESTORE_COLUMNS`、renderer の `TreeNodeRestoreState`）にあるので、`src/features/tree/restoreStateKeys.parity.test.ts` が 4 つの一致を機械的に固定する。
- `"restoreState": null`：Main と mock は object でないとして拒む。Rust は `Option` なので null を「無し」（通常の create）として受ける（試験で固定）。Rust だけが緩いが、production は Main を通るので届かず、通常の create と同じ結果になるだけで、権限は広がらない。揃えるために Rust にだけ専用の拒否を足すと `Option` の通常の意味（欠落と null）が崩れるので足さない。
- Rust：`TreeNodeCreatePayload` は変えず（struct literal が 24 か所あり、他の lane の file に及ぶ。反証 P2-1 の (b)）、wire struct `TreeNodeCreateWire`（`#[serde(flatten)]` の payload と `restore_state`）で受ける。`skip_serializing_if = "Option::is_none"` で、`restoreState` を使わない create の request fingerprint は変わらない（試験で固定）。N-API は `tree_node_create` の closure の型を wire に替えるだけ（`#[napi]` の doc コメントは触らないので d.ts は不変）。
- 入れ子にする理由：通常の呼び手が間違って渡せない。1 か所で gate と検査ができる。将来の欄の取りこぼしを `deny_unknown_fields` が拒む。同じ wire を `RendererCanonicalWriteContext` も読み、その struct は top-level の `contextMode` を持つので、平らに置くと衝突する。
- INSERT は今のまま。直後、`ensure_scene_scope_binding_in_tx` と `select_tree_node` の前に、同じ tx で 1 本の `UPDATE` で戻す。行・journal・feed・receipt は 1 tx（失敗で何も残らない）。応答・feed の `afterState` は復元後の行。

### c. 参照の扱い、整合の検査、temporal_scene_patch との差

- `povCharacterId`・`locationId`：同じ project の Codex があればそのまま。undo の間に Codex が消えていれば NULL に倒す（FK の `ON DELETE SET NULL` と同じ結果。ここで失敗させると subtree の途中で undo が止まり半端になる）。別 project の id は拒む。renderer は応答の値を store に反映する（store と DB が食い違わない）。
- **年表の 7 列の検査（組で受ける）**：3 つの NOT NULL の key（`chronicleStartGranularity`・`chronicleEndGranularity`・`chroniclePrecision`）は、7 つのどれかがあるなら 3 つとも必須（なければ 7 つとも無し）。day・minute は nullable の安全な整数（null と欠落は同じ。INSERT の既定が NULL）。granularity は `none`・`season`・`year`・`month`・`day`・`time`、precision は `exact`・`approx`・`unknown`。検査は**形だけ**（整数・安全な整数・列挙・組の必須）で、Rust・Main・mock の 3 層で同じ。**範囲の不整合（end が start より前、`time` で day か minute が無い、範囲外の minute）は拒まずに書き戻す**（下の「忠実に戻す」）。
- **年表の書込みの検証を実際のコードで読んだ結果**：`temporal_scene_patch` の `validate_range` は `validate_canonical_chronicle_date_range`（互換検査＋厳密な persistence matrix：`none` は day・minute なし、`season`〜`day` は day のみ、`time` は day と minute、end があれば start が要る）で、どれも**その行の列だけ**で決まる。他の場面との整合（cross-row）はなく、`temporal_constraint_commit` の試験は commit・Freshness・Scope の経路の試験で、日付の整合を他の場面と照らす規則ではない。したがって、削除と undo の間に他の場面が変わっても、戻す値の整合は変わらない（試験 `restore_state_chronicle_does_not_depend_on_other_scenes`）。厳密な matrix も範囲の整合も掛けない：`tree_node_patch` は年表の列を**検査なしで**書き（`domain_writes.rs` の patch 経路。列に CHECK も無い。`treeStore.ts` も「逆順や不完全な legacy の範囲には安全な書き戻し先が無い」と認めている）、matrix より前の行（粗い粒度に minute が付いた行、`none` に day が付いた行）もあるので、そういう行は DB に実在する。undo が範囲の不整合を拒むと、`createNode` が throw し、`deleteTreeSubtree` は復元の loop の前に `cancelTrash` を呼ぶため、削除から 1.5 秒以内の Ctrl+Z で node が DB にも Trash にも無くなりうる（レビュー P2-1）。そこで、**範囲の不整合は書き戻し、形の検査は残す**（形の検査は `tree_node_patch` より狭い〔patch は granularity に任意の文字列を書ける〕ので、信頼境界は広がらない。試験 `restore_state_puts_back_an_inconsistent_legacy_range_faithfully`・mock・Main の同種の試験）。**形の検査に引っかかる legacy の値**（整数でない day・minute、列挙外の granularity）では undo 全体が失敗しないよう、renderer が送る前に同じ判定を掛け（`chronicleGroupIsRestorable`）、通らない組は送らずに `debugLog.warn("tree", "undo date range not restorable", …)` を出して、日付だけ従来どおり欠落させる（undo は成功する。他の欄は戻る）。renderer は範囲が INSERT の既定（NULL・`none`・`none`・`exact`）と違うときだけ組で送る。
- 値の形：`contextMode` は 4 値、`aliases`・`excludedAliases` は文字列の JSON 配列、`unplacedBeatsDoc` は JSON 配列、`createdAt` は RFC 3339 か SQLite 既定の `YYYY-MM-DD HH:MM:SS`（既存の行が持つ両方の形）。
- 厳密な年表の整合（`validate_canonical_chronicle_date_range`）も、互換の範囲検査（`validate_chronicle_date_range`）も掛けない。形の検査だけ（上の年表の 7 列の検査と、書込みの検証の項）。
- **create の feed が `calendar` の path を持たないことは足りるか（レビューの注 c）**：create の feed event は `changeKind: content`（scene）・path `["/"]` で、`temporal_scene_patch` が出す `calendar`／`order` の個別の path は無い。undo の create は行が新しくできる（削除の feed で依存は一度無効になり、create で全依存が再作成される）ので、`calendar` の path で個別に無効化する必要はない。年表の依存のうち、Chronicle の一括操作の OCC は store の `scene.updatedAt` を token に使い、renderer が応答の `updatedAt`・`version` を store に反映するので DB と一致する。年表の secret の位置は読む順だけを使い、日付には依らない（PR-6 の記録の 11）。human field の印（`record_human_field_write`）は戻らない（上の差の項）。
- `temporal_scene_patch` との差（反証 P2-4）：story order の専用 writer は version の加算・Scope の source token の更新・Freshness の伝播・human field の印・`order`／`calendar` の feed path を行う。undo の create は行が新しくできるので、全依存が再作成される前提で足りる。Scope の source token は registry と binding（incarnation・version・updatedAt 等）から作られ、story order を含まない（`narrative_scene_scope::source_token`）。binding は従来どおり `UnknownRepairOrRestore` で作り直す。human field の印は戻らない。UPDATE を feed の row 取得より後にすると応答・feed の `afterState` が復元前になるので、順序は試験（変異）で固定した。

### d. 退けた案

- B：undo が create のあとに `temporal_scene_patch`／`tree_node_patch` で戻す。2 回の書込みで atomic でなく、journal・feed が増え、途中失敗で半分戻った行が残る。patch は `baseVersion` が要り、note の欄・`createdAt` を覆えない。
- C：Rust が undo の create で delete の journal の `before_json` を読む。store に無い子孫も戻せる唯一の案だが、承認は payload の拡張で、journal の内容を create の復元の入力にする新しい結合になる。束縛を緩める案は DR-UND-2 で採った（子の create は今までどおり renderer が送り、Rust は記録を復元の入力にしない）。
- D：INSERT を全 34 列にする。通常の create の SQL と試験の全面更新が要り、得るものが無い。
- A のうち入力：計画書の本文は store の `deletedNodes` から組む案だった。反証 P2-3 に従い、削除の直前に DB から読んだ行（`loadTreeNodeRestoreSnapshot`。scene の本文書込みの barrier を通る）にした。redo の前にも読み直し、undo→編集→redo→再 undo で編集が失われない（記録にある node について。DR-UND-2 の Q1：undo の後・redo の前に足した node は、記録に無いので再 undo では戻さない）。

### e. 直らないもの（作者から見える残る制限）

- **中身のある章（子のある folder）の undo は DR-UND-2 で直った。** E1 の時点では、章だけが DB に戻り、画面には何も戻らず、Ctrl+Z の履歴が消える既存の不具合だった（削除から 1.5 秒以内だと中の場面が DB にもゴミ箱にも無くなる恐れがあった）。原因・直し方・残る制限は下の DR-UND-2。
- **PR 本文用（作者から見える言葉）**：削除して Ctrl+Z で元に戻るのは、場面・メモ・章（中身のある章も、入れ子の章・場面・メモごと）。Ctrl+Z が途中で止まったときは、戻った分だけが画面に出て、戻らなかった場面はゴミ箱に入る（今までは、削除から 1.5 秒以内だと DB にもゴミ箱にも無くなった）。
- 削除で cascade 消去される子の表：label・pin・伏線の setup と回収・scene の年表イベントへの紐付け・map の位置・lint の無視・Scope の制約（作者が決めた制約は既定に戻る）。反証 P2-2 で数え直した追加分：付箋（`editor_stickies`）・スレッドの段階マーカー（`plot_thread_scene_links`）・スレッドの開始／終了（`plot_threads.start_node_id`・`end_node_id`）・`foreshadow_payoffs`・版履歴（`content_versions`）・post-effect の注釈・`scene_lens_data`・`events.reveal_scene_id`（年表の lane の表）。archived の子孫。これらは `restorePersisted` が `createNode` 1 回だけであることによる（読み取りで数えた。実行で全件は確かめていない）。DR-UND-3 の入力。
- Trash 復元・redo of create の欄の欠落：別の lane。
- **fail-open の限界（レビュー P2-3）**：snapshot（削除の直前の DB の行）が読めないと、`deleteTreeSubtree.ts` は黙って従来の経路（create の欄だけ）に落ちる。undo は止まらない（可用性のため妥当）が、その undo では欠落が残り、reload の後に hidden の note は `mentioned` に戻る（秘匿が弱い向き）。読めなかったことは `debugLog.warn("tree", "undo snapshot unreadable", …)` に残す（診断用。AI に渡る内容と UI は変えない）。
- **barrier は scene の本文書込みだけ**：`loadTreeNodeRestoreSnapshot` は `awaitPendingSceneContentWrite` を待つ。直前の inspector の編集（intent・別名など）がまだ DB に届いていないと、DB は少し古い値で戻る（確率は低い。読みで見込み、実行では確かめていない）。
- **store の note 本文は古いまま**：undo は `{...node, ...fields}` で store の node を戻すが、`fields` に `content` は無い。store の note の `content` は開いた時点の値で、undo の後も DB（編集後の本文）と違う。従来からの挙動で回帰ではない（DB 側は今回直った）。
- **試験していない経路**：feed の `afterState`（復元後の行が入ること。応答の行と同じ値を feed に渡すコードの読みだけ）、Scope の source token・freshness が復元後の story order から計算されること（source token は story order を含まないので計算は変わらない、と読んだ）、project 切替をまたぐ undo の中断で restoreState を送らないこと（既存の navigation authority の経路で、新しい試験は足していない）。実 addon の通し（`electron/main/treeUndoRestore.pipeline.spec.ts`）は書いたが、この lane では実行していない（`pnpm napi:build` が要る。親が回す）。

### f. 画面・AI で見える変化

- 戻る：scene の story order・**作中暦の日付（年表の位置）**・POV・場所・意図・未配置ビート（Grid の preview も）・外部ファイルの紐付け・作成時刻、note の AI 注入モード・別名・本文。
- 年表の日付が古い形式で壊れていても undo は成功する：逆順（終わりが始まりより前）や、`time` なのに時刻が無い日付は、そのまま戻る。整数でない時刻や未知の粒度など、形が壊れた値の日付だけは戻らず（未設定に戻る）、undo 自体は成功し、診断ログに残る。外部ファイルの紐付けは、同じ file の別の scene があるときは戻らない（画面にも紐付けの無い scene として出る）。
- AI に見える内容は**両方向**に動く（reload・再起動の後の話）：`hidden`・`suppress` の note は今より隠れ、`always` の note は今より多く入る。別名は mention の検出対象を戻す。story order は Phase の `auto` の判定を削除前に戻す。いずれも削除前の状態に戻るだけで、新しい公開はない。日付が戻ると、年表の snapshot の anchor（`resolveSceneAnchor` が使う `sceneChronicle`。`chatContextPreparationComposition.ts` の場面の年表の解決と `chronicleTools.ts` の anchor）も削除前に戻る（今は reload の後、日付が欠けたまま anchor が解決されていた）。
- **直る欠陥の範囲（限定）**：legacy の AI 文脈は note の `contextMode`・`aliases`・`content` を **store** から読む（`sceneContextSource.ts`）。store は従来も undo で削除前の値に戻っていたので、欠陥が出るのは **DB から hydrate し直した後（reload・再起動の後）**で、その後は作者が直すまで続く。その間、hidden の note は `mentioned` 扱いで AI に出ていた（ADR 013 の「hidden は守る」に反する側）。直った後は、undo の直後も reload の後も同じ（画面で見える変化の記述も同じ限定）。
- **外部ファイルの紐付け（`sourceUri`・`sourceMtime`）が戻ることの影響（レビュー P2-1）**：外部ファイルを mount した scene を削除して undo すると、従来は紐付けの切れた scene（DB だけの行）として戻っていた。今は紐付けも戻り、mount は「同じファイルの scene」として扱い続ける。試験で 2 通りを確かめた（`api.restoreState.test.ts`、実 DB の browser mock）。(1) 削除して何もせず undo：他に同じ file の node は無く、紐付けが戻り、scene は 1 件。(2) 削除のあとに mount の reconcile が同じ file の node を作ってから undo：`source_uri` に unique 制約が無いので、紐付けを戻すと**同じ file の scene が 2 件**になる（`verifyExternalMountSourcesOnDisk` が `Multiple persisted Scenes share an external source` で止まる見込み）。**選んだ方針：同じ `sourceUri` の別の node が DB に在るときは `sourceUri`・`sourceMtime` を戻さない**（`api.findNodeIdBySourceUri`。確かめられないとき〔読みの失敗〕も戻さない＝従来の undo と同じ）。他の欄は戻る。**store も同じ**：戻さなかったときは、undo が store に反映する `fields` に `sourceUri = null`・`sourceMtime = null` を入れる（`TreeRestoredFields`）ので、store が DB に無い紐付けを持ち続けて同じ file の scene が store に 2 件並ぶことは無い（レビュー P2-2。試験は `treeStore.deleteNode.test.ts`）。理由：identity の渡し方（`storage: "file"`）を変える案は、timelapse の body 差し替えの扱いが変わるが実害を試験で確かめられず、(2) の 2 件化は防げない。紐付けを戻さないだけなら小さく、結果は従来と同じ（store も DB も、紐付けの無い scene）。作者から見える結果：reconcile が先に新しい scene を作っていたなら、undo で戻る scene は紐付けの無い DB だけの scene（従来と同じ。作者が消すか整理する）。何も起きていなければ、紐付けごと元に戻る。**残る競合と数え方**：`findNodeIdBySourceUri` の確認から `createNode` までの間に reconcile が node を作る競合（TOCTOU）は残る（窓は 1 回の IPC の間で小さい。排他は取っていない）。`findNodeIdBySourceUri` は archived の行も衝突に数える。mount の reconcile も `listAllNodes` から `sourceUri` で既存を探し、archived なら unarchive して再利用するので（`mountManager.ts` の file の reconcile）、archived の行がある file に紐付けを戻すと重複するため、数え方は reconcile と揃っていて、安全な側（戻さない側）に倒れる。
  (b)（undo の create が既定の `storage: "database"` の identity を使う）は変えていない。実害は未確認で、紐付けを戻す (1) の場合に file の write-back との相互作用があるかは、実 addon でも未確認。
- 変わらない：上の e。

### g. 脅威モデル

変更なし。新しい送信先・保存範囲の拡大・閾値の変更・新しい authority はない（route は既存の `history-replay`）。新しい欄は同じ project の自分のデータの復元で、renderer→Native の信頼は今の create と同じ。replay の authority 契約は触っていない（DR-UND-2 で undo の create の対象 id を記録の id まで広げた。authority の route・caller・control は不変。下の DR-UND-2）。

### h. drift guard

`domain_writes.rs` の単体試験 `every_tree_nodes_column_is_classified_for_the_undo_restore`：`pragma table_info(tree_nodes)` の全列が「INSERT の列」「`TREE_NODE_RESTORE_COLUMNS`」「除外（理由つき）」のどれかに入ることを固定する（年表の 7 列は restore に移した。保留の区分は無くした）。別の lane が `tree_nodes` に列を足すと落ちて判断を強制する。key と列の対応は `TREE_NODE_PATCH_COLUMNS` と同じ（`createdAt` だけ undo 専用）であることも固定した。Main の key 集合は `electron/shared/ipcContract.ts` の `TREE_NODE_RESTORE_STATE_KEYS`、browser mock は `BROWSER_TREE_RESTORE_COLUMNS` で、Rust と同じ 19 key。4 か所の一致は `restoreStateKeys.parity.test.ts` が固定する（上の b）。

### i. Scope の writer の分類（`narrative_scope_storage_authority.rs`）

`crates/grimodex-db/tests/narrative_scope_storage_authority.rs` は、Scope の世代と本文の Source token `v{version}@{updated_at}` が成り立つように、`narrative_scene_scope_bindings`・`tree_nodes`・`codex_entries` の production の SQL writer を閉じた manifest と照合する。restoreState の UPDATE（`restore_tree_node_state_in_tx`）と、create の wire 化（関数名が `tree_node_create_wire_with_authority` になった）が、この静的走査の網羅に載っていなかった（PR #1051 の ci.yml で 3 本が赤。不具合でなく、分類の求め）。次のように分類した。

- **manifest**：INSERT の行は `tree_node_create_wire_with_authority`（class `SceneCreate`。従来どおり binding を作る）に付け替え、restore の UPDATE を新しい class `TreeRestoreInCreateTx` として 1 件登録した。
- **「version を進めない Scene の書換え」の集合**（T method）：restore の UPDATE を足した。足すだけでなく、試験は class の契約を機械的に確かめる（`assert_restore_runs_inside_the_create_transaction`）：(a) UPDATE を持つ関数の本体が `version`・`updated_at` を一切書かない、(b) 呼び手が create の writer 1 つだけ、(c) その writer の中の順序が「undo の gate → INSERT → restore → binding の作成」。
- **3 つの creation writer の限定**：名前を `tree_node_create_wire_with_authority` に追従しただけ。呼ぶ writer は同じ 3 つ（`tree_node_create`〔wire〕・`apply_ai_tree_plan`・`promote_sticky`）のまま。
- **保証の根拠（コードで確かめた）**：
  - restore の UPDATE は Scope の列（`story_time_order`・`pov_character_id`）を書く動的な SET で、`version` を進めない。だが **Scope の世代を進める相手も、守る token の履歴も無い**。undo の create の行と binding は新しく、delete が binding を消している（`tree_node_delete`）。create は UPDATE の**後**に `ensure_scene_scope_binding_in_tx` で binding を新しく作る（新しい incarnation、version 1、token は完成した行から計算。`UnknownRepairOrRestore`）。
  - UPDATE は INSERT と同じ transaction の中にあるので、restore 前の値を持つ commit 済みの状態・読み手・Source token は存在しない。
  - UPDATE は `version` も `updated_at` も書かないので、token は INSERT が作った `v0@now` のまま（restore が無かった従来と同じ。試験 `restore_state_does_not_roll_back_updated_at_or_version`）。単調性は壊れない。
  - Scope の source token は registry と binding（incarnation・version・updatedAt 等）から作られ、story order を含まない。POV は新しい binding の holder・audience（Reader の既定）に影響しない。したがって、§c・§g の記述（binding は従来どおり作り直す、Scope は戻らない、脅威モデルは変わらない）と食い違わない。
  - 到達は create の writer の `origin == Undo` の gate の後だけ。Undo Journal の束縛は `validate_tree_replay_target_in_tx` が見る。
- 他の走査：`graph_index_dirty_tests.rs` の feed append の呼び手の数（domain_writes.rs は 7、変更なし）、`scripts/quality/validate-native-writer-ownership.mjs`・`validate-change-feed-writers.mjs`・`scripts/c2zc-product-journeys.test.mjs`（create の関数の範囲を切り出して `let now = chrono::Utc::now()` を見る）は、名前の変更・新しい UPDATE で影響を受けなかった（node の試験と validate を実行して通った）。

## DR-UND-2（候補）残りの欠落

## DR-UND-2 中身のある章（folder）の削除の undo で、中の場面・note・folder も戻す

作成：2026-11-23。lane H（E1 の枝の上の stacked branch）。計画書は `fusion-eval-data/handoff/mastra-mp3-materials/plan-folder-undo-20261123.md`。

ユーザー承認：2026-11-23「中身のある章の削除の undo が、章だけ戻り中の場面が戻らない既存の不具合を、別の PR で直す」。範囲は「undo の journal の束縛を、削除の記録 `before_json.nodes` に含まれる id まで緩める。書ける範囲は増やさない（削除された子孫の id だけ）。設計と試験を示してから実装」。新しい command・schema・migration・送信先・保存範囲の拡大は無い。IPC の契約（`ipcContract.ts`）・Main・N-API・d.ts は変更しない。Q の既定（推奨どおり）：Q0＝undo 経路の id 集合の拡大を PR 本文に明記する、Q1＝undo の後・redo の前に章へ入った node は再 undo では戻さない、Q2＝途中で止まったら戻せた node だけ store に反映する（推奨 (b)）。**加えて、計画書が採らないとした (c)「戻せなかった場面をゴミ箱に積み直す」の変形を採った**（レビュー P2-2）。計画書の懸念（`cancelTrash` が void で、1.5 秒を過ぎた undo の保留が書込み済みかどうか分からず、積み直すと重複する）は、`cancelPending` が取り消せたかを返すようにして、取り消せた保留だけを積み直すことで避けた。ゴミ箱の実装の意味（保留・書込み・取消し）は変えていない。

### a. 不具合の経路（直す前）

削除の Undo Journal は root（章）1 件（`entity_id = root`）で、`before_json` が `{"rootId", "nodes": [subtree の全行]}`。undo は親→子の順に各 node の `tree_node_create`（origin undo）を同じ journal で呼ぶ。Native の `validate_tree_replay_target_in_tx` は `("create", Undo)` で `entity_id == node_id` を要求するので、root は通り、最初の子が `tree replay target does not match the named Undo Journal` で拒まれた。renderer は throw し、store への反映（`applyNodes`）は loop の後ろなので何も戻らず、DB には章だけが戻り、undo の履歴は `clear()` された。ゴミ箱の保留は loop の前に一括で取り消されるので、削除から 1.5 秒以内だと中の場面が DB にもゴミ箱にも無くなる恐れがあった。Main の `hasRendererHistoryJournal` による sender の束縛は、tree の undo／redo の create・patch・delete には掛かっていない（`agent_apply_undo_journal` と `ai_tree_plan_undo`／`redo` だけ）。tree の undo の node ごとの門は、Native の lineage 検査とこの束縛だけである。

### b. 規則（Native。`domain_writes.rs` の 1 関数と新しい private fn）

`validate_tree_replay_target_in_tx` の通す条件を、`entity_kind == "tree_node"` かつ `op_kind` が操作に合い、かつ次のどちらか、にする。

1. `entity_id == node_id`（root。これまでどおり。記録は読まない）。
2. **`("create", Undo)` のときだけ**、`recorded_subtree_contains`：名指しした journal（同じ project）の `before_json` を、`rootId` と `nodes[].id`・`nodes[].projectId` だけの型に parse し、`rootId == entity_id` で、`nodes` のどれかが `id == node_id` かつ `projectId == project_id` なら true。記録が無い・NULL・JSON でない・別の形・別の root・node の `id` か `projectId` の欠落・別 project の node は false（fail closed。文言は同じ）。部分一致は使わない（id が別の node の本文・`parentId`・title に現れるだけでは通らない）。

`("create", Redo)`・`("delete", *)`・`("patch", *)`・lineage の検査・`restoreState` の gate（origin undo だけ）は厳密のまま。エラー文言は変えない。

### c. 信頼境界（PR 本文にも明記する）

**変わるのは 1 点：undo の経路が INSERT できる id の集合が、「root 1 件」から「その journal に Native が記録した削除済みの id 全部」に増える。** authority の route（`history-replay`）・caller・control は不変。renderer が書ける範囲全体は増えない（human 経路の create は新しい id を元々自由に作れる。undo の create の `parentId`・`nodeType`・本文・`restoreState` の値が renderer の値であることは root も今そう）。

| 誤用 | 結果 | 根拠・試験 |
|---|---|---|
| 記録に無い id（未使用・別の経路で消した id）を undo で create | 拒む | `a_replay_journal_does_not_create_an_id_that_it_did_not_record` |
| 別の delete（J2）の子の id を J1 の journal で | 拒む | `one_deletes_journal_does_not_create_another_deletes_nodes` |
| すでに在る行（記録の id でも）を作り直して書き換える | INSERT の主キー衝突で拒まれ、行は不変（`restoreState` の UPDATE は同じ tx の INSERT 直後の行にだけ掛かる） | `a_replay_create_cannot_overwrite_a_row_that_already_exists` |
| 別 project の payload | 拒む（journal の SELECT・lineage が project で絞られる） | `a_replay_journal_of_another_project_creates_nothing` |
| 壊れた・偽の記録（SQL NULL・JSON でない・配列・nodes 無し・rootId 違い・node の projectId 欠落／別 project・id が別の欄にだけ現れる） | 拒む（fail closed） | `a_damaged_or_forged_delete_record_does_not_bind_a_child`、単体 `recorded_subtree_contains_reads_only_what_a_tree_delete_recorded` |
| journal の `op_kind`／`entity_kind` が delete の tree_node でない | 拒む | `a_journal_that_is_not_a_delete_does_not_bind_a_child` |
| Redo の create・delete・patch、Undo の delete・patch を descendant の id で | 拒む（緩めていない） | `only_an_undo_create_may_name_a_recorded_descendant` |
| `restoreState` を記録外の id に付ける | 束縛で先に拒まれる | `restore_state_does_not_open_a_create_that_the_journal_did_not_record` |

あえて足さない検査：子の `parentId`・`nodeType` を記録と一致させる。store は DB より最大 750 ms 古いことがあり、一致を要求すると読みの食い違いで undo が途中で止まる新しい失敗になる。一方で足しても書ける id の範囲は変わらない（既存の行は PK 衝突で守られ、親は既存の folder 検査で守られる）。残る穴（今と同じ）：記録にある id が後で別の操作で消された場合、同じ journal でその id を作り直せる（root も今そう）。history の stack は利便で、security の境界ではない。確定文書：ADR 006 と `change-feed-writers.json` の `history-replay` は original-transaction と journal-lineage を要求するだけで、tree の create の entity 束縛を書いていないので、文面の改訂は不要と読んだ。scope の決定記録 `docs/plans/nir1-lane-decisions/scope-default-decisions.md` の DR-SDEF-18 は「配下の node を 1 つずつ別の Undo Journal で消し、undo は各 node の journal で作り直す」と古い仕組みを述べている。現在は root 1 件の journal で、子の create は記録の id で通る（この DR）。復元した場面の束縛が `unknown`（`UnknownRepairOrRestore`）で作られる結論は変わらず、T1（`undo_of_a_folder_subtree_returns_every_node_as_it_was`）が `compatibility_marker = 'unknown'` で固定する。DR-SDEF-18 には追記だけした（既存の記述は消していない）。`narrative_scope_storage_authority.rs` の静的走査は `tree_nodes` 等の INSERT／UPDATE を持つ関数名を分類する。この変更は SELECT だけの新しい関数と既存関数の条件で、書込みの関数は増えない（全件 `cargo test -p grimodex-db` で確かめる。親が回す）。

### d. renderer（`deleteTreeSubtree.ts`）

- **Q1（再 undo の対象）**：redo は journal を書き直さないので、記録は最初の削除のまま。redo の後の再 undo は、最初の削除の id に含まれ、かつ root まで記録された node でつながる node だけを送る（`recordedSubtree`）。undo の後・redo の前に足した node（redo の cascade で既に失われている）と、その子を持つ記録の node（親が作れない）は送らない。送ると、Native が拒んで undo がまた途中で止まる。
- **Q2（途中で止まったとき）**：loop が throw したら、戻せた node だけを store に反映して（`reflectRestored`）から rethrow する。何も戻せていなければ store は変えない。active scene は、前の active scene が戻った node に含まれるときだけ戻す。結果不明で保持された undo の再実行は、store に既にある同じ id を入れ替えるので重複しない。history の `clear()` は今までどおり（`globalHistoryStore`）。
- **ゴミ箱（`cancelTrash`）**：結論は「loop の前の一括取消しを残し、**止まったら、取り消せた保留のうち戻っていない scene をゴミ箱へ積み直す**」。`cancelPending` が戻り値（保留を 1 件でも取り消したら true）を返すようにした。loop の後に取り消す・node ごとに取り消す案は、長い undo で保留が loop の途中で 1.5 秒を過ぎると、戻した scene がゴミ箱にも重複して残る（今は一括取消しで起きない）ので採らない。積み直しは、取り消せた（まだ保留だった）scene だけ・戻っていない scene だけ・新しい tempId で行う。すでにゴミ箱へ書かれていた（false）scene は積み直さない（重複を作らない。1.5 秒より後の undo が元々ゴミ箱に残る挙動は変えない）。保持された undo の再実行は積み直した tempId を取り消す。変更は `deleteTreeSubtree.ts` と `cancelPending`／`cancelPendingTrash` の戻り値（ゴミ箱の実装の意味は変えない）。
  - **redo → 再 undo が止まった場合（レビュー P2-1）**：redo は保留を作り直さない。最初の undo が保留を取り消した scene は、redo の後はゴミ箱にも DB にも無い。そこで、取り消せた scene の集合（`outOfTrash`）を持ち、再 undo は取り消し済みの scene の取消しを繰り返さず、止まったらこの集合のうち戻っていない scene を、redo の時点の本文で積み直す。最初の undo で取り消せなかった（すでにゴミ箱にある）scene は積み直さない。成功する再 undo は何も積まない。redo の挙動は変えていない。
  - **重複する場合（失わない）**：書込みの処理中（`createTrashItem` が返る前。保留はキューに残る）に取り消すと true が返るが書込みは完了するので、その undo が止まって積み直すと同じ scene がゴミ箱に 2 件になる。結果不明で保持された undo を 1.5 秒より後に再実行すると、積み直した scene が書かれた後に DB へも戻り、重複する。
- 子の create にも各 node の `restoreState` を付ける（E1 の流れのまま。`restorePersisted` は node ごとに snapshot を渡す）。

### e. 画面で見える変化と、残る制限

- **変わる**：中身のある章（folder の下に場面・note・入れ子の章がある）を消して Ctrl+Z すると、章と中身が全部戻る（以前は DB に章だけが戻り、画面には何も戻らず、Ctrl+Z の履歴が消えた）。各 node の列は E1 の `restoreState` の範囲で戻る。削除から 1.5 秒以内でも、成功すれば中の場面は戻り、ゴミ箱に重複しない。
- **途中で止まったとき**：束縛が原因で止まることは無くなった。ほかの原因（親が消えた・source の衝突など）で止まったら、戻せた node は画面にも出て、戻らなかった場面はゴミ箱に入る（削除から 1.5 秒以内の undo の場合。それ以降はすでにゴミ箱に入っている。redo の後の再 undo が止まった場合も同じ。ゴミ箱に 2 件になる場合は上の d の「重複する場合」）。**画面で見える挙動の追加**：以前は、削除から 1.5 秒以内の undo が止まると、中の場面が DB にもゴミ箱にも無くなった。undo の履歴は消える。戻らなかった **note と folder はゴミ箱に入らない**（ゴミ箱に積むのは場面だけ。今までも同じ）。
- **redo**：章と中身がまとめて消える（root の delete 1 回の cascade）。redo → 再 undo は、記録にある node が全部戻る。**undo の後・redo の前に章へ足した node は、再 undo で戻らない**（redo の時点で既に失われている。まれな手順。「戻す」には redo が journal を書き直す契約変更が要り、別の承認）。**取りこぼし**：記録にある node を、undo の後に作った folder へ移した場合、その node も再 undo では戻らない（親が記録に無く作れないので、送らない）。**未確認**：完全に戻った後、`reflectRestored(true)` が前の active scene を指すが、その node が戻っていない（記録外・再 undo で送らなかった）ことがあり得る。影響（active scene が store に無いときの画面）は確かめていない。
- 変わらない（E1 の残る制限）：cascade で消える子の表（label・pin・伏線・map の位置・版履歴など）、archived の子孫（store に無く、renderer は送らない）、ゴミ箱の復元の欄、redo of create。1.5 秒より後の undo でゴミ箱に場面が重複して残る挙動も同じ。
- 子のない folder・scene・note、redo、undo→redo→undo の root だけの経路は、挙動も DB の結果も同値（root は `entity_id == node_id` で、記録を読まない）。

### f. 性能の測定

子の create ごとに記録を parse する（O(N × 記録の大きさ)）。root の create は parse しない。測定試験 `measure_a_large_folder_undo`（`#[ignore]`。閾値の assert は無い。debug build・他の lane の負荷が高い環境の値）：

| 章 | 記録 | 子の create 1 件 | undo 全体 |
|---|---|---|---|
| 300 場面 × 20 KiB | 約 6.4 MB（SQLite の length で 2,285,096 文字） | 69.5 ms | 20.9 s |
| 300 場面 × 1 KiB | 約 0.3 MB | 15.4 ms | 4.6 s |
| 100 場面 × 5 KiB | 約 0.25 MB | 12.0 ms | 1.2 s |

**release build の測定（レビュー P2-3。同じ測定試験を `cargo test --release` で 1 回）**：

| 章 | 記録 | 子の create 1 件 | undo 全体 |
|---|---|---|---|
| 300 場面 × 20 KiB | 約 6.4 MB | 14.9 ms | 4.46 s |
| 300 場面 × 1 KiB | 約 0.3 MB | 4.6 ms | 1.38 s |
| 100 場面 × 5 KiB | 約 0.25 MB | 4.8 ms | 0.48 s |

記録の読みと parse の追加分は、release で 1 MB あたり約 1.6 ms（debug は約 9 ms）。通常の章（数十場面・数百 KB）では 1 件 1 ms 未満で誤差。極端な 6.4 MB の記録（300 場面 × 20 KiB）で、子 1 件が約 10 ms（基準の 4.6 ms との差）、undo 全体で約 3.1 s の上乗せ（全体 4.5 s）。**memo は入れなかった**：(1) 数秒に届くのは本文 6 MB 超という極端な章だけで、場面ごとに 1 IPC の undo は renderer 側でも元々その規模では遅い（別の問題）。(2) process 内の memo は、journal の id が試験や別 DB で再利用されうるため、鍵に DB の同一性を持てず、古い記録を読む危険が増える（状態を持つ）。(3) 追加分は O(N × 記録の大きさ) で、閾値が超えると測れたときに、同じ契約のまま足せる（`(project_id, journal_id, 記録の長さ)` を鍵にした記録の id 集合の memo。DB の同一性の扱いを先に決める）。親の判断で足す場合の設計の注：memo の鍵に connection の同一性を含める。事前の弾き（`instr`）は、含まれる id（通常の経路）では効かないので入れていない。数千場面の章の undo は、場面ごとに 1 IPC で元々遅い（別の問題）。

### g. 採らない案

bulk 復元 command の新設（承認の範囲外）、node ごとに別の journal（記録の形と redo の意味が変わる）、Native が記録から subtree 全体を復元する案 C（記録を復元の入力にする新しい結合。再検討の候補のまま）、記録に無い id も親が復元済みなら許す・journal が有効なら id を問わない（承認に反する）、journal 無しの origin `restore` で create（lineage を失う）、記録の id の一覧を新しい列・表に持つ（schema 変更）、renderer が id を主張する（信頼できない）。browser mock に束縛を足さない（mock は元々 target の束縛を持たない別の契約。往復の試験だけ足した）。

### h. 試験と変異試験

反転した試験：Rust `current_undo_of_a_folder_subtree_child_is_pinned`（拒否を固定）→ `undo_of_a_folder_subtree_child_is_bound_to_the_delete_record`（通る）。実 addon の spec `(4)`（子の create が拒まれる）→ 子のある章が全部戻る・redo→再 undo・記録外の拒否の 4 case（親の順の拒否を含む）に置き換え。

追加：Rust 実 DB の T1（3 階層 5 node の往復）・T3（親より先の子）・T4（途中の再開と同じ requestId の再送）・T5（redo → 再 undo と記録外）・T6（feed）・root が記録を読まない試験・信頼境界 8 本・測定 1 本、単体 1 本。renderer `deleteTreeSubtree.test.ts` に 13 本、`cancelPending` の戻り値 1 本、browser mock の往復 1 本。

変異を 1 つ入れて落ちた件数（終わったら戻した）：

| 変異 | 落ちた件数 |
|---|---|
| Rust M1 束縛を常に通す | 7 |
| M2 `rootId` の照合を外す | 1 |
| M3 node の `projectId` の照合を外す | 1 |
| M4 `before_json` の部分一致だけで通す | 1 |
| M5 緩和を create 以外の操作（Undo origin）にも適用 | 1 |
| M5c 緩和をすべての操作・origin に適用（delete の Redo を含む） | 1 |
| M6 緩和を Redo の create にも適用 | 1 |
| M7a `op_kind` の検査を外す | 1 |
| M7b `entity_kind` の検査を外す | 1 |
| M8 parse できない記録を通す | 1 |
| M10 root の短絡を外す（root も記録を読む） | 2（`the_root_is_put_back_without_reading_the_record`。もう 1 件 `redo_then_undo_again_restores_the_recorded_nodes_only` は、この変異が root の delete の Redo の通過も外すため） |
| renderer R1 redo が記録外の node も送る | 2 |
| R2 記録の node への連結を要求しない | 1 |
| R3 途中で止まったとき store に反映しない | 1 |
| R4 再実行で store の node を入れ替えず重複させる | 1 |
| R5 戻らなかった scene をゴミ箱に積み直さない | 3 |
| R6 取り消せなかった（すでに書かれた）scene も「ゴミ箱に無い」とみなす | 2 |
| R7 戻った scene も積み直す | 2 |
| R8 止まったときも active scene を前の値にする | 1 |
| R9 積み直した tempId を保持しない | 1 |
| R10 取消しを loop の前でなくす | 4 |
| P1 redo の後の再 undo で取り消し済みの保留をまた取り消す | 1 |
| P2 積み直す本文を redo の時点の本文にしない | 1 |
| P3 積み直した scene を「ゴミ箱に無い」集合から外さない | 1 |

Rust の件数はすべて integration（`tests/tree_node_restore_state.rs` の binary）の数。M2・M3・M8 は単体（`domain_writes` の lib の `recorded_subtree_contains_reads_only_what_a_tree_delete_recorded`）でも落ちる見込みだが、単体の件数は測っていない。renderer の件数は `deleteTreeSubtree.test.ts`（20 本）の数。

### i. 試験していない経路

実 addon の spec（`electron/main/treeUndoRestore.pipeline.spec.ts`）は書いたが、この lane では実行していない（`pnpm napi:build` が要る。親が回す）。`treeStore.deleteNode` に実 api を繋いだ通し（loop の順序を store 経由で）は書いていない（port 経由の単体と、api を node ごとに呼ぶ spec で代える）。結果不明（unknown outcome）の再実行は port の mock で確かめ、実 IPC では確かめていない。全件の `cargo test -p grimodex-db` は、この lane の枝では回していない（`narrative_scope_storage_authority` の 3 本が E1 の分類の未反映で赤い：E1 の `restore_tree_node_state_in_tx`・`tree_node_create_wire_with_authority` が分類に無いため。H の関数は SELECT だけの `recorded_subtree_contains` で、この試験に載らない）。親が回す。

## DR-UND-3（候補）残りの欠落

上の e の子の表・Scope binding・Trash 復元・redo of create。子のある folder の undo は DR-UND-2 で直した。年表の 7 列は DR-UND-1 で戻すことにした（上）。

## 変異試験の記録

（年表の 7 列の「範囲検査を外す」の行は、範囲検査そのものをやめたので無い。下の P2-1 の行が対になる。）

変異を 1 つ入れて、対応する試験が落ちる件数を確かめた（終わったら元に戻した）。

| 変異 | 落ちた件数 |
|---|---|
| Rust：gate を外す（human でも通る） | 1 |
| Rust：欄を UPDATE から外す（intent／excludedAliases／createdAt／unplacedBeatsDoc／contextMode） | 2／1／3／1／1 |
| Rust：`skip_serializing_if` を外す（fingerprint が変わる） | 2 |
| Rust：存在しない参照を NULL でなくエラーにする | 1 |
| Rust：別 project の参照の検査を外す | 1 |
| Rust：version・updated_at を巻き戻す | 4 |
| Rust：UPDATE を feed の row 取得より後に移す | 1 |
| Main：origin の gate を外す／未知 key を許す／型検査を外す | 2／3／2 |
| renderer：restoreState を渡さない／note の本文を store から渡す／source を渡さない／version 等を store に反映しない | 1／2／1／1 |
| renderer：redo の読み直しをしない／応答の反映を捨てる | 2／2 |
| renderer：api が restoreState を落とす／snapshot が aliases を落とす | 2／2 |
| browser mock：gate を外す／欄を落とす | 1／6 |
| **年表の 7 列** Rust：start_time／precision／end_granularity を戻さない | 3／2／1 |
| 年表 Rust：組の必須を外す／安全な整数の検査を外す／precision の検査を外す | 各 1 |
| 年表 Main：整数の検査を外す／組の必須を外す | 1／0（等価：語の検査が同じ入力を拒む） |
| 年表 mock：組の検査を外す | 1 |
| 年表 renderer：範囲を送らない／end_time を送らない | 2／2 |
| 外部 file：常に `sourceUri` を戻す／確かめられないとき戻す／自分自身を衝突とみなす | 1／1／1 |
| 診断：`debugLog.warn` を外す | 1 |
| key 集合：mock の key を 1 つ落とす／renderer の key を 1 つ足す | 10（parity 含む）／1 |
| mock の `createdAt` が naive T 形を受ける | 1 |
| **範囲の不整合を書き戻す（レビュー P2-1）** Rust：end が start より前を拒む／`time` で minute 無しを拒む | 1／1 |
| 同 Main：end が start より前を拒む | 1 |
| 同 mock：end が start より前を拒む | 2 |
| 同 renderer：形の判定を常に通す／範囲を常に送らない／warn を出さない | 7／4／7（Shape 6＋legacy 1） |
| store：戻さなかった `sourceUri` を store に残す | 1 |
| key 集合：snapshot の select から key を落とす／Main の整数 key を 1 つ落とす | 4（parity 含む）／3 |
