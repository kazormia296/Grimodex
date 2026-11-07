# Fable（effort high、read-only）の最終確認：design-rev1.md（2026-11-04）

判定：(b) 直してから示す。設計のやり直しは不要。保存先（新表）・β・material も exact・復元は unknown・U1〜U4 の切り方は妥当。確認は origin/master = a8c5fa65 で、引いた行番号はすべて一致した。

## P1
なし。

## P2
1. 「継承するかは Native が決め、renderer の値で継承を起こさない」（§0、§2.2 の 2、§2.3 Mandatory defenses）が 3 経路で成り立たない。mount の作成は origin human・lineage なし・writeContext なし（`src/features/external-mount/mountManager.ts:1320-1335`、`src/features/native-writes/writeContext.ts:90`）で、`sceneScopeInit` を省略すると継承する。取り込み（`importApi.ts:603/633`、`scanImportOperations.ts:89/106/338`）も §2.2 (a) で import を許すので同じ。R3 は renderer 試験でしか守れず、ユーザーが SHA-256 付きで確認する文面に、Native が保証しない保証が書かれる。直し方：(i) `TreeNodeCreatePayload` の `source_uri`／`source_mtime`（`domain_writes.rs:2447-2469`）を Some で渡すのは mount だけ（取り込みは `markdownParser.ts:9` で parse に使うだけで payload に渡さない）なので、Native の規則に「外部 source を持つ作成は継承しない」を足す。(ii) import を (a) から外し、取り込みのチェック ON は完了後に §5.1 の既存 writer（`narrative_scene_scope_update`）のループで当てる。Native は import で一切継承せず、U1 の取り込みの選択肢と `sceneScopeInit` の必要箇所が減り、「作者が押すので明示」の意味も保たれる。(iii) 未配線の renderer restorer（`trash-bin/restorers/scene.ts:54`）は配線時に origin restore（route restore-or-migration。`ipcContract.ts:4257-4263`、`ipc.ts:1906-1908`）を要求する規則にし、"unset" に頼らない。あわせて §8.3 の「origin を偽れば継承する」は、origin が renderer の申告で main は origin→route の対応しか縛らない（`ipc.ts:1896-1912`）事実に合わせ、§2.3 の文言を「作成の種類の申告（origin／lineage／route）は既存契約の human-direct と同じ扱いで、Scope の値の申告は受けない」と正確に書く。
2. T8（PUB-G の開示文）は技術判断の表にあるが、開示の文言はユーザー確認の対象。「文案は書く、確定は PUB-G の確認で聞く」と U 側の注記に移す。
3. T3（β）の帰結がユーザーに伝わらない。β では新規 workspace の `default-project`（`migrate.rs:1525-1527` は `project_create` を通らない）と generic import の project は既定なしで、B の目的「何もしなくても本筋どうしで出る」が最初の project で成立しない。U2 か U3 の注記に 1 行で明示する。γ の L0 影響が理由で v1 は β、は技術判断として妥当。

## P3
4. §4.1 の列挙の抜け：`grid/applyStructureTemplate.ts:88/108`（テンプレートの一括作成）、`tree/PhoneEmptySceneBootstrap.tsx:19`（`interaction: "implicit"` の自動作成）、`matrix/MatrixPanel.tsx:288`、`treeStore.ts:1174`（`createScene`）。どれも origin human で継承する。U1 の「作者が新しく作った場面」にテンプレート一括と自動作成を含むことを明示する。
5. `sceneScopeInit` は `canonical_write_payload_fingerprint`（`idempotency.rs:121-130`）に入る。再送で field が変わると `TREE_NODE_CREATE_REQUEST_CONFLICT`。§4.2 に書く。`canonicalPayload`（`tree/api.ts:430-434`）に入れるかも決める。
6. §7.1 の hint「元に戻した場面（取り消し・ゴミ箱・スナップショット）」に redo（`treeStore.ts:1382-1396`）と history-replay を含める。「取り消し・やり直し」にする。
7. T9「canonical の change event は実装で決める」：既定の変更履歴が無いと「いつから本筋で作られたか」を後から追えない。監査の記録は保存範囲の判断なので decisions に明記する（残す方向を推奨）。
8. U4 の判断材料として、材料 §6 の B-lite（renderer が作成直後に既存 writer で既定を書く。契約文「新規は unknown」を動かさない）を 1 行比較し、採らない理由（原子性なし、Native の全経路に効かない、保存先は同じく要る）を書く。

## 確かめられなかったこと
設計 §10.4 のまま。加えて：backup restore（`backup_restore.rs`）が復元する表の allowlist を持つか、`requireTreeNodeCreatePayload`（`ipcContract.ts:4255-4286`）が未知 key を拒否するか（読んだ範囲では拒否せず、`sceneScopeInit` の値域検査は main に足す必要）。
