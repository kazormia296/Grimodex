# 独立レビュー（Opus、read-only）の指摘：design-draft.md（2026-11-04）

判定：(b) 直してから示す。継承の判定の単位を見直せば足り、設計のやり直しは要らない。保存先を registry から分ける判断、β、material も exact で受け継ぐこと、復元は unknown のままにすることは妥当。

## P1
1. undo と redo が `tree_node_create` を通って既定を受け継ぎ、§4.3 の防御と食い違う。削除の undo（`src/features/tree/treeStore.ts:1544-1559` の `restorePersisted` が同じ id と本文で `api.createNode`。origin は undo）、作成の redo（`treeStore.ts:1381-1396` の `recreatePersisted`）はどちらも `tree_node_create` → `domain_writes.rs:3325` を通り、草稿の §4.1 はこの関数を丸ごと「継承」に分類している。回想に設定した場面（または章ごと。`deleteTreeSubtree`）を消して Ctrl+Z すると本筋として戻る。§4.3 と l6-l9:870（削除後の ID の再利用）・:873 に反する。直し方：`tree_node_create_with_authority` は `origin`、`original_transaction_id`、`undo_journal_id` を受け取り文脈と照合している（`domain_writes.rs:3198` 以降。history-replay の分岐あり）。継承の条件を「origin が forward で lineage が無い」と Native が決め、undo／redo／history-replay は unknown にする規則を §2.2 の 2・3 と §4.2 に書く。MANIFEST の class 分けではこの分岐を固定できないので、§10.2 に実行時の受入れ試験（undo で戻した場面が unknown）を足す。

## P2
2. 既存の project への取り込みと外部 mount も受け継ぐ。取り込み（`import/importApi.ts:234/603/633`、`import/scan/scanImportOperations.ts:89/106/338`）、外部 mount（`external-mount/mountManager.ts:1005/1225/1320`）はすべて `createNode` を通る。`importTarget.ts:5-15` の `"currentProject"`（markdown の single）で、既定を持つ既存の project に取り込むと回想の章も全部本筋になり、Q13 のチェックは効かない。外部 mount の同期は実質的に復元に近い。直し方：`tree_node_create` に閉じた field（例 `sceneScopeInit: "inherit"|"unset"`）を足し、renderer には安全な向き（unset）にだけ下げることを許す。または確認点に足す。
3. §3.5.1「既存の project には効かない」は公開版の利用者に当たらない。`ensure_scope_registry_in_tx` は A1 の backfill（`scene_scope.rs:538`）からも呼ばれ、backfill は `migrate.rs` で `current < 36` のとき走る。`LAST_PUBLIC_RELEASE_SCHEMA_VERSION = 2`（`grimodex-core/src/lib.rs:8`）なので、公開版から更新する利用者の既存の project には全部に本筋の語彙が入る。挙動は変わらない（unknown は ref を参照しない）が、§5.2・§5.3・§7.1 の「既存の project は registry が空」の前提、Q3 の説明（既存利用者の migration で入るデータの変更だと明記）、Gate A2 の upgrade fixture の期待値への影響を確認点に。
4. 確認点に無い意味の変更が 2 つ。(i) 作成ダイアログのチェックを既定オンにすると、作者が触っていない場面に explicit を書く（l6-l9:861/870 の「明示」の意味）。オンかオフかを Q にする。(ii) ユーザーの記録の読みは「作成の全経路で継承」だが、草稿は 8 経路のうち 3 経路に絞っている。この差を明示の確認点にする。§3.1 の「既定を変えても既存の場面は変わらない」はユーザーの決定ではなく integrator の説明。表現を正確に。

## P3
5. `import/commit.rs:164`（generic import。opt-in）は `project_create` を通らずに project を作り、registry は `scene_scope.rs:445` で後から作られる。§3.5.1 の「効く範囲」に無い。
6. `src/features/trash-bin/restorers/scene.ts:54` は `createNode` で復元する。今は type の import だけのようだが、配線されれば受け継ぐ。消すか試験で固定する。
7. §4.2 の MANIFEST：snapshot の restore は `ProjectRestore`、本文保存は別の class で、`SceneCreate` を分けるだけでは足りない。「Inherit の定数は許可した関数の中の origin で守られた分岐にだけ現れる」という grep の試験にする。
8. §3.2：tombstone の `{"kind":"none"}` は `NarrativeSceneQueryIdentityV1` の `deny_unknown_fields` と合わない。`state` の列を別に持つ。`source_token` の列の用途を書く。
9. §8.4 の 4：query だけを変えた時点で、その場面に anchor する Revision は X1/1 で失効する。混ざり続けるのは変えた後に承認した IR だけ、と正確に書く。

## 確かめたこと（レビュー）
草稿の file:line は確かめた範囲で実物と合う。`ensure_scene_scope_binding_in_tx` の製品の呼出しは 8 つで表と合う（ほかは cfg(test)）。MCP と grimodex-ai は場面を作らない。in-app agent は `apply_ai_tree_plan` で場面を作れる（`electron/main/ipc.ts:258-261`）が INSERT に Scope の列は無い。β なら凍結 harness と DP-H は止まらない（α では止まる）。

## 確かめられなかったこと（レビュー）
凍結 run の受領書が置き換え前の registry を記録しているか。L0 の workspace の作り方。サンプルの中身。`promote_sticky` と `apply_ai_tree_plan` の undo／redo の writer。snapshot の restore で binding を残す分岐（`project_snapshots.rs:2952`）。既定の writer が canonical event を出すべきか。
