# 削除の undo で DB の行を削除前に戻す（DR-UND-1）

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
- C：Rust が undo の create で delete の journal の `before_json` を読む。store に無い子孫も戻せる唯一の案だが、承認は payload の拡張で、journal の内容を create の復元の入力にする新しい結合になる。DR-UND-2 の候補として再検討する。
- D：INSERT を全 34 列にする。通常の create の SQL と試験の全面更新が要り、得るものが無い。
- A のうち入力：計画書の本文は store の `deletedNodes` から組む案だった。反証 P2-3 に従い、削除の直前に DB から読んだ行（`loadTreeNodeRestoreSnapshot`。scene の本文書込みの barrier を通る）にした。redo の前にも読み直し、undo→編集→redo→再 undo で編集が失われない。

### e. 直らないもの（作者から見える残る制限）

- **folder の下に子がある削除の undo は、今も子が戻らない。** folder 自身は戻るが、子の create が Undo Journal の束縛（`entity_id == node_id`。journal は削除の root 1 件だけ）で `tree replay target does not match the named Undo Journal` と拒まれる。既存の不具合で、実 DB の特性試験で確定した（`current_undo_of_a_folder_subtree_child_is_pinned`）。束縛を「delete の `before_json.nodes` に含まれる id」へ緩めるのは replay の authority 契約の変更なので、この lane では触らない（別の確認が要る）。renderer 経由（実 addon）の確認は未実行。したがって、この lane で DB が戻るのは削除の root 自身（scene・note・子の無い folder）。
- 削除で cascade 消去される子の表：label・pin・伏線の setup と回収・scene の年表イベントへの紐付け・map の位置・lint の無視・Scope の制約（作者が決めた制約は既定に戻る）。反証 P2-2 で数え直した追加分：付箋（`editor_stickies`）・スレッドの段階マーカー（`plot_thread_scene_links`）・スレッドの開始／終了（`plot_threads.start_node_id`・`end_node_id`）・`foreshadow_payoffs`・版履歴（`content_versions`）・post-effect の注釈・`scene_lens_data`・`events.reveal_scene_id`（年表の lane の表）。archived の子孫。これらは `restorePersisted` が `createNode` 1 回だけであることによる（読み取りで数えた。実行で全件は確かめていない）。DR-UND-2 の入力。
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

変更なし。新しい送信先・保存範囲の拡大・閾値の変更・新しい authority はない（route は既存の `history-replay`）。新しい欄は同じ project の自分のデータの復元で、renderer→Native の信頼は今の create と同じ。replay の authority 契約は触っていない。

### h. drift guard

`domain_writes.rs` の単体試験 `every_tree_nodes_column_is_classified_for_the_undo_restore`：`pragma table_info(tree_nodes)` の全列が「INSERT の列」「`TREE_NODE_RESTORE_COLUMNS`」「除外（理由つき）」のどれかに入ることを固定する（年表の 7 列は restore に移した。保留の区分は無くした）。別の lane が `tree_nodes` に列を足すと落ちて判断を強制する。key と列の対応は `TREE_NODE_PATCH_COLUMNS` と同じ（`createdAt` だけ undo 専用）であることも固定した。Main の key 集合は `electron/shared/ipcContract.ts` の `TREE_NODE_RESTORE_STATE_KEYS`、browser mock は `BROWSER_TREE_RESTORE_COLUMNS` で、Rust と同じ 19 key。4 か所の一致は `restoreStateKeys.parity.test.ts` が固定する（上の b）。

## DR-UND-2（候補）残りの欠落

上の e の子の表・Scope binding・folder 下の子の undo（replay 束縛の緩和）・Trash 復元・redo of create。年表の 7 列は DR-UND-1 で戻すことにした（上）。

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
