# NIR-1 Index writer coverage

2026-09-08。統合計画A4の実装照合。policy意味や保存範囲を追加しない。

参照registry: `policies/narrative/change-feed-writers.json`、SHA256 `afa6c84734c09dd39e9f52a43acf1c726732bddfbf980b8405bf802fb1b4e440`。129操作（required85、delegated3、excluded41）。fragment globに追加操作ファイルなし。

## Feedを通る既存writer

`append_narrative_change_transaction_in_tx` が新しいFeed transactionを公開するとき、同一transactionでproject Indexのdirty flagを立てる。generationは旧sealed D1と一致したまま保持し、成功した新Index publishでだけ進める。既存replay/no-opの早期returnでは再停止しない。

以下の85操作はregistryの既存canonical Feed契約を共有する。これは各操作の新規動的testを85本実行したという意味ではない。既存Feed coverage/runtime suiteと新しい共通hookのmutation/rollback testを併用する。

- `src-tauri/crates/grimodex-db/src/domain_writes.rs`: `project.create.renderer`, `project.metadata.patch.renderer`, `scan.import.publish`, `codex.tags.set.renderer`, `codex.rename.undo.renderer`, `codex.rename.apply.renderer`, `tree.ai-plan.apply.renderer`, `tree.ai-plan.undo.renderer`, `tree.node.create.renderer`, `tree.node.delete.renderer`, `tree.node.patch.renderer`
- `src-tauri/crates/grimodex-db/src/integrity.rs`: `integrity.repair.renderer`
- `src-tauri/crates/grimodex-db/src/chronicle.rs`: `chronicle.event.set-participants.renderer`, `chronicle.calendar.upsert.renderer`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/mod.rs`: `temporal.scene.patch.renderer`
- `src-tauri/crates/grimodex-db/src/map_writes.rs`: `map.write.renderer`
- `src-tauri/crates/grimodex-db/src/project_snapshots.rs`: `project.snapshot.restore`
- `src-tauri/crates/grimodex-db/src/revision_restore.rs`: `revision.scene.restore.renderer`
- `src-tauri/crates/grimodex-db/src/trash_bin.rs`: `trash.structure.restore.renderer`
- `src-tauri/crates/grimodex-db/src/scene_body.rs`: `scene.body.save.renderer`
- `src-tauri/crates/grimodex-db/src/plot_threads.rs`: `plot.thread.create.renderer`, `plot.thread.update.renderer`, `plot.thread.delete.renderer`, `plot.marker.create.renderer`, `plot.marker.update.renderer`, `plot.marker.delete.renderer`, `plot.branch.create.renderer`, `plot.branch.update.renderer`, `plot.branch.delete.renderer`, `plot.marker.move.renderer`, `plot.history.restore.renderer`, `plot.history.delete.renderer`
- `src-tauri/crates/grimodex-db/src/foreshadow.rs`: `foreshadow.create.renderer`, `foreshadow.update.renderer`, `foreshadow.delete.renderer`, `foreshadow.setup.update.renderer`, `foreshadow.codex-link.create.renderer`, `foreshadow.codex-link.delete.renderer`, `foreshadow.setup.strength.renderer`, `foreshadow.setup.create-ai.renderer`, `foreshadow.orphan.resolve.renderer`, `foreshadow.anchors.save.renderer`
- `src-tauri/crates/grimodex-db/src/agent_writes.rs`: `agent.codex.create`, `agent.codex.update`, `agent.codex.delete`, `codex.create.renderer`, `codex.update.renderer`, `codex.delete.renderer`, `chronicle.event.create.renderer`, `chronicle.event.update.renderer`, `chronicle.event.delete.renderer`, `chronicle.event.participants.renderer`, `chronicle.event.scene-link.renderer`, `chronicle.event.scene-link-batch.renderer`, `chronicle.event.relation.renderer`, `agent.snippet.create`, `agent.history.apply-undo-journal`, `agent.foreshadow.create`, `agent.foreshadow.update`, `agent.event.create`, `agent.event.update`, `agent.event.delete`, `agent.event.participants`, `agent.event.scene-link`, `agent.event.scene-link-batch`, `agent.event.relation`
- `src-tauri/crates/grimodex-db/src/codex_writes.rs`: `agent.codex.mutate`, `codex.mutate.renderer`
- `src-tauri/crates/grimodex-db/src/chronicle_bulk.rs`: `chronicle.bulk.renderer`, `agent.chronicle.bulk`
- `src-tauri/crates/grimodex-db/src/snippet_writes.rs`: `renderer.snippet.create`, `renderer.snippet.update`, `renderer.snippet.delete`
- `src-tauri/crates/grimodex-db/src/import/commit.rs`: `import.session.apply.internal`
- `src-tauri/crates/grimodex-mcp/src/tools/foreshadow.rs`: `mcp.foreshadow.create`, `mcp.foreshadow.update`
- `src-tauri/crates/grimodex-mcp/src/tools/snippets.rs`: `mcp.snippet.create`
- `src-tauri/crates/grimodex-mcp/src/tools/codex.rs`: `mcp.codex.create`, `mcp.codex.update`
- `src-tauri/crates/grimodex-mcp/src/tools/chronicle.rs`: `mcp.event.create`, `mcp.event.update`, `mcp.event.delete`, `mcp.event.scene-link`, `mcp.event.participants`, `mcp.event.relation`

Apply/undo/redoの3 delegated操作は既存domain writerから同じFeed公開を通る。Apply後の撤回権限や新しいMCP権限は追加しない。

## Feed対象外の41操作

Feed除外をIRの無効化除外と読み替えない。current revisionやDecisionのwriterには専用hookを置く。

| 操作 | NIR-1への影響と処理 |
| --- | --- |
| `renderer.generic-sql.execute` | 公開generic writerは保護テーブルDMLを拒否する。新vector tableも既存の全untrusted origin/DML denial testへ追加。 |
| `renderer.generic-sql.batch` | 公開generic writerは保護テーブルDMLを拒否する。新vector tableも既存の全untrusted origin/DML denial testへ追加。 |
| `mcp.generic-sql.execute` | 公開generic writerは保護テーブルDMLを拒否する。新vector tableも既存の全untrusted origin/DML denial testへ追加。 |
| `mcp.generic-sql.batch` | 公開generic writerは保護テーブルDMLを拒否する。新vector tableも既存の全untrusted origin/DML denial testへ追加。 |
| `workspace.backup.restore` | workspace/database authorityとconnection epochが変わり旧queryを拒否。cold readerは保存vectorだけでproofを復元しない。restore rebuildは新epochから再評価する。 |
| `workspace.recovery.restore` | workspace/database authorityとconnection epochが変わり旧queryを拒否。cold readerは保存vectorだけでproofを復元しない。restore rebuildは新epochから再評価する。 |
| `project.delete` | immutable Applicationがあれば削除自体を拒否。削除可能projectはFKでcacheも削除。queryのproject実在照合とmaintenance hintが終了を検知する。 |
| `workspace.web-editor.import` | 新workspaceのauthority/connection epochに束縛し直す。保存cacheのcold利用は禁止。 |
| `narrative.runtime-policy.set` | 既存runtime policyの操作制限。Revision/Source/Decisionを書き換えず、query資格を授与しない。Native workspace/embedding generationとindex runtime状態は各queryで照合する。 |
| `project.snapshot.capture` | snapshot保存のみ。実project restoreはrequired経路。 |
| `workspace.sample.seed` | 新workspaceのseed。既存IR authorityを流用しない。 |
| `test.runtime-performance.seed` | 隔離fixtureの準備用。製品source writerや検索authorityへ昇格しない。 |
| `schema.migrate` | schema35 upgradeでproducer/vector storageを追加。既存unknown producerへ登録・資格を自動付与しない。 |
| `narrative.workflow.create-run` | 新しいrun/taskのstagingのみ。公開Index rosterには未加入。build中のrun変更は全row CASで検出。 |
| `narrative.workflow.cancel-run` | pending/runningのrunとqueued/running taskだけを変更。complete root/attemptのimmutable証跡は変更しない。 |
| `narrative.workflow.claim-task` | queued taskのattempt作成。既存complete rootには適用不可。 |
| `narrative.workflow.finish-task` | terminal化とinsert_proposal_seedを同一transactionで実行。新current rosterの公開前にproject suspension。 |
| `narrative.workflow.fail-task` | running attemptの失敗状態。complete root/attemptへの書換えは不可。 |
| `narrative.proposal.save-set` | insert_proposal_seedを介し、new current rosterとsuspensionを同一transactionで公開。 |
| `narrative.proposal.append-revision` | append_revision_on_connのcurrent pointer変更とsuspensionを同一transactionで公開。 |
| `narrative.proposal.create-human-derived-revision` | C2B human_materializationのcurrent pointer変更をhook。standalone child保存はcurrentを変更しない。 |
| `narrative.proposal.append-decision` | append_decision_on_connでdecision/状態変更とsuspensionを同一transactionにする。 |
| `narrative.proposal.append-human-decision` | 同じappend_decision_on_conn。Humanのactor/authorityはNativeで確定。 |
| `narrative.proposal.revise-and-decide` | 共通revision/decision writerの両hookを同一transaction内で通す。 |
| `narrative.proposal.revise-and-decide-human` | 共通revision/decision writerの両hookを同一transaction内で通す。 |
| `narrative.field-authority.set-lock` | field lockは将来Applyのauthority制御。current Revision/own Decision/材料/Scope/Freshnessを書き換えない。 |
| `narrative.commit.prepare` | Apply計画の準備のみ。実Apply/undo/redoはdelegated source writerで停止する。 |
| `authorship.sidecar.replace-lane` | 帰属sidecar。本文source token・Revision statement・Scopeは変更しない。 |
| `scan.staging-project.create` | 未公開staging project。publish時はrequired Feed hook。 |
| `trash.envelope.create` | trash envelopeの管理のみ。実tree/source復帰はrequired trash.structure.restore経路。 |
| `trash.envelope.delete` | trash envelopeの管理のみ。実tree/source復帰はrequired trash.structure.restore経路。 |
| `trash.envelope.clear` | trash envelopeの管理のみ。実tree/source復帰はrequired trash.structure.restore経路。 |
| `trash.envelope.prune` | trash envelopeの管理のみ。実tree/source復帰はrequired trash.structure.restore経路。 |
| `test.protected-writer-fixture` | 隔離fixtureの準備用。製品source writerや検索authorityへ昇格しない。 |
| `agent.sql-bundle.mutate` | 公開generic writerは保護テーブルDMLを拒否する。新vector tableも既存の全untrusted origin/DML denial testへ追加。 |
| `agent.prose.propose` | prose stagingのみ。保存本文へ反映するscene.body writerを代替しない。 |
| `agent.prose.accept` | prose stage状態のみ。本文への製品適用は既存canonical body writer。 |
| `agent.prose.discard` | prose staging破棄のみ。現本文/IR材料は変更しない。 |
| `narrative.dependency-declaration.store` | 新しいcurrent proposal-revisionのD1 head公開でsuspension。idempotent replayとIndex自身のD1公開では再停止しない。 |
| `narrative.maintenance-attention.set` | attentionは非逆流の観測状態でありSource/Decision/D1/資格の入力ではない。 |
| `narrative.maintenance-attention.clear` | attentionは非逆流の観測状態でありSource/Decision/D1/資格の入力ではない。 |

## Registry外の内部authority publisher

- `semantic_epoch.rs:create_epoch_in_tx`: epoch作成前に同transactionで停止。
- `dependency_edges.rs`: current Revisionのedge input変更・削除を停止。非意味的更新は再停止しない。
- `publish_runtime.rs`: current Revisionのcanonical Freshness/action/epoch/producer/digest変化、またはedge stateの意味変化を停止。timestampだけの更新は除外。
- `restore_rebuild.rs:rebuild_repair_dependency_edges_in_tx`: repairでcurrent Revisionのedgeを削除するとき停止。
- Index publishは元Revisionを再承認・再Fresh化しない。旧sourceを必要とするRevisionは除外した新rosterを封印する。

## Build中と返却時の照合

Build前はL1/L2を完全検証する。publish transactionではRevision/Decision/lineage/run/task/attempt/artifact/receipt/model binding/audit/D1/V1/canonicalの全row CASと、全live Source observation、current roster、semantic epoch、Index登録、relevant Feedを再照合する。CASはprivateな一時digestで、永続authorityを追加しない。

キャッシュ再利用は同じdocument/envelope/serializerと実loaded modelの5 identityが一致したvectorに限定する。元embedding auditをpublication時に再検証し、cached vectorだけを資格にしない。query返却・Evidence clickは同じworkspace/S2/query/世代、current roster/Source、canonical Freshnessを再確認する。

## 検証範囲

新Index focused testsにはsource/Decision/child変更、rollback、no-op、build中のauthority変更、vector/audit破損、cold/restore/model/runtimeの失効を含む。標準Native APIによるquery ticket解放後の復旧、100-current性能、全操作を通した製品journeyは別証跡。focused passをL5やFull受入れとみなさない。

## Approved Scope projection Source /1

`nir1-scope-dependency-delta/1` adds a computed, Native-owned Source; it creates no mutable Source table. `human_materialization::resolve_live_scope_override_authority` binds the new Source through the existing atomic C2B writer. `scope_dependency_projection::bind_identity_in_tx` verifies both document references against the immutable Run corpus. `source_revision` and `restore_rebuild` resolve its current value; the legacy project authority resolver remains intact.

`incremental_freshness::event_changes_project_scope_authority` conservatively selects new projection edges on relevant tree/Scope Feed changes. `revision_eligibility::pending` independently blocks relevant pending changes, even if the projected value will remain unchanged. The Index's `input_edges` retains the sealed owning Run for both snapshot and Scope projection Sources; publication and current proof revalidate that binding.

Existing tree writer/Feed paths remain the notification authority for scene/folder order, archive and membership, story order, restore and undo. Typed normal-operation tests now cover non-secret reuse, archived anchor denial and secret story ambiguity introduced by another Scene. The remaining actual UI and formal recovery matrix is still required; this inventory is not completion evidence.
