# NIR-1 C: Scene接続とG-01の実装前候補

作成日: 2026-09-22。状態: **design candidate / runtime unmeasured**。
対象: [post-B計画](nir1-post-b-execution-plan.md) §3、§6.3、§7.1。
本書は製品コード、既存24件のGold、評価指標、公開条件を変更しない。
G-01のfixture提案は本書の作成時点で固定し、検索・Graphの出力をまだ観察していない。
設計担当は本書のauthorであり、後続候補の独立受入れ担当とは別にする。

現在の内部実装では、既存pinをboundedに列挙し、対象Sceneの保存本文を同じquery予算・取消制御で
canonical化してSource/digest/UTF-16 anchorへ束縛するreaderと、Scene自身のScopeを独立検証する
helperが追加されている。Scene helperはCの31-case focused suiteで通過したが、これは内部readerの
境界確認であり、C-productのeligible結果、Graph公開、G-01実行可能性または2 MiB/8 msの受入れを示さない。

## 1. 選択と確認範囲

最小候補は、**既存の明示的な `scene_codex_pins` をEntity→Sceneの所在情報として読む**方式とする。
資格を満たしたpathの到達Entityに対するpinだけを使い、seed自身のpinだけではG-01の1-hop寄与にしない。
pinはユーザーが宣言したSceneとの関連であり、RelationがScene本文で成立した証拠ではない。
名前一致、本文の自動mention、review時のScope Sceneから対応を推定しない。

この候補は既存の保存内容・actorを増やさず、Graphの資格authorityも増やさない。
pinはquery時点の直接読取とcurrent再検証に限る。Bのsealed Entity/Relation rosterへpinを混入せず、
新たな永続adjacency、pin Source kind、独立Freshness consumerを追加しない。
既存確認済み契約の具体化として設計・診断を進められるが、以下の未実装条件が成立するまでは
C-product接続完了、G-01 PASS、Graph公開を主張しない。

| 選択肢                        | 正本と既存writer                                                            | seed-local取得                                                                            | current性・Evidence                                                                                    | 判定                     |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| 明示pin                       | `scene_codex_pins`。`upsertScenePin` / `deleteScenePin`、snapshot restore等 | `idx_scene_codex_pins_entry`でexact Entity IDから取得可能                                 | rowにversionなし。read identityとexact再読取が必要。本文位置は持たない                                 | 本候補で選択             |
| PMの `codexSemanticLink` mark | 保存されたScene ProseMirror JSON。通常本文writerが所有                      | 正本本文全体を逆引きするindexがない。`scene_codex_mentions(source='semantic')`は派生cache | 本文Source/storage digestへ束縛可能。ただし既存extractorは文字列を返しcanonical UTF-16 rangeは返さない | 今回の最小接続に含めない |
| 自動mention/cache             | `scene_codex_mentions(source='body'/'semantic'/'relation')`                 | reverse indexはある                                                                       | complete/current markerなし。cache欠落や古い行を正本・Evidenceへ昇格できない                           | Graph接続の正本にしない  |

PM明示mark自体は曖昧なentity resolutionではない。しかし派生cacheの完全性証明なしに
候補発見へ用いると、cacheに存在しない正本markを取り逃がす。毎query全Scene JSONを検査する
代案も512件/2 MiB/8msの契約に合わない。pinは既存の正本を直接indexed読取できるため選ぶ。
PM方式を追加するなら、別の必要性とcurrent/completeness設計を先に記録する。

## 2. 三種類の情報を分ける

| 種類                   | 意味と保持内容                                                                                   | navigation                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Scene association      | `scene_id`と到達Entity IDの明示pin。pathとScene候補を接続する所在情報                            | 同じcurrent pinとScene identityの確認後にSceneへ移動           |
| Relation/path Evidence | current approved typed Revision、Decision、Source、各edge/endpointのEvidence。2hopはedge列のまま | Relation正本および各EntityのCodex名/要約のexact Evidenceへ移動 |
| Scene body excerpt     | 関連候補の本文を読むための独立したRaw抜粋。pin/Relationの真実性を証明しない                      | Scene本文のexact Source/rangeへ移動                            |

Option BのEvidenceはCodex名/要約とRelation正本に束縛される。Scope/review Sceneを本文Evidenceに
読み替えない。新Sceneを表示する場合も「本文からこのRelationを抽出した」と表現しない。
既存R+IR Sceneのexcerpt/anchorには手を加えず、Graph pathを別情報として添える。

Graph-only追加SceneのRaw抜粋候補は、Nativeの既存 `gdx-canonical-text/1` 射影における
**最初の非空行のexact範囲**とする。これは関連度推定ではなく決定的な表示位置である。
元本文全体を承認済み資源内で読めない場合は、名前検索や切り詰めたJSONで補修せずunavailable。
空本文も追加候補の成功扱いにしない。本文の全closureや抜粋を新たな永続台帳へ保存しない。
excerpt表示を折り畳むUI処理と、検証された原文/rangeを分ける。

## 3. bindingとSource

Nativeの閉じたquery result bindingに、少なくとも次を保持する。rendererのdigest申告を認可に使わない。

| binding           | 内容                                                                                                              | current確認                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 実行              | workspace実体、lifecycle/caller epoch、project、query Scene、query ticket、期限                                   | 既存lifecycle/profile/query gate。別DB copyや旧callerの流用を拒否                        |
| Graph             | sealed generation/roster/D1、exact Revision/Decision、path edge/endpoint/Evidence                                 | C-queryとA2/A3/Bの既存正本で確認                                                         |
| association       | `scene_id`、`entry_id`、rowの`created_at`、Scene incarnation、Nativeが観測したrow fingerprint                     | fresh transactionでexact rowと両端同project・Scene種別・live状態を再読取                 |
| Scene body Source | 既存`scene-body`、`project:scene:<id>`、`v<version>@<updated_at>`、storage/canonical digest、normalizer、UTF-16長 | bounded内部readerが`read_retrieval_scene_source`と同じ正本から作る。Source tokenだけでpin変更を検出したとは扱わない |
| body anchor       | canonical rangeのstart/end、exact excerpt/digest、上記Source binding                                              | 同一原文/rangeの完全一致。類似文字列探索で補修しない                                     |
| Scene disclosure  | 対象Scene自身のincarnation/Scope token、reading位置、必要な全Scope軸と現在query                                   | pathのA3適格性とは別に対象本文の開示を既存Native readerで判定                            |

association fingerprintはrequest-local整合確認の値であり、永続Source tokenでも認可sealでもない。
`created_at`も単独のincarnation、署名、完全性証明にはしない。
既存readerが対象Scene本文の必要な開示条件を評価できない場合は、pathのreview Sceneの資格で代用せず
接続をunavailableにする。このreader対応はC-product前に確認・検証する。

pin変更の保守的な失効には、既存のfull read identityを利用する候補とする。
`SqliteSourceRevision`のconnection epoch / total changes / data versionと、main/temp schema version、
user version、read-only transaction条件を維持する。対象外tableの変更でも旧query結果を失効させてよい。
必要なmarkerが取得不能、write transaction、connection epoch不一致なら、旧proofを再利用しない。
**connection-localなdata versionを別connection間の共通番号として比較しない。**

queryのsnapshotを閉じた後、返却前とクリック時にはfresh transactionでcurrent性を確認する。
同じWAL read transaction内の再SELECTは、その後の別connectionのcommitを観察した証明にしない。
read identityが変わったらGraph contributionを0にし、新しいqueryで再取得する。
exact row再読取を併用するが、削除→同値再挿入、ID再利用、restoreをrowの同値だけで救済しない。
同じconnection identityが確認できない場合も保守的にunavailableとする。
UIの表示失効通知と、返却/クリック認可を別にテストする。

現行コードのC-product接続gapを次に固定する。bounded内部readerの実装完了を、これらの資格・統合条件の
完了とは扱わない。

- `evaluate_nir1_entity_relation_disclosure`は実在の承認済みRevisionを最初に検証し、
  bundleの`entity.scope.reading`が指すSceneだけを検証する。任意pin先Scene本文への全A3判定を
  独立に呼べるhelperではない。review Sceneが違う場合に、そのSceneのproofを流用しない。
- `read_retrieval_query_context`は既存reading-only profileのquery contextであり、単独で対象Sceneの
  全A3資格を証明しない。既存private判定の必要部分を抽出する場合も、actor/意味を変えず、
  Scene本文に適用すべき条件とreader/writer対応を先に示す。synthetic Entity/Revisionを作って通さない。
- `read_retrieval_scene_source`は既存のlegacy経路としてcontentをowned Stringとしてrowから取得した後に
  canonical化する。C-queryが使う`read_retrieval_scene_source_bounded`はscalar byte-length検査、共有
  read/bytes予算、処理中checkpoint、bounded canonical adapterを持つ内部readerだが、まだGraphの
  path結果と結合するcaller/fresh-read bracketは持たない。
- 既存A3もproject Scope authority、phase集合、reveal行をmaterializeする。再利用するときは
  それらを含めてcardinality/bytesをallocation前にaccountし、Rust処理境界で取消を観測する。
  `nir1_capacity::with_capacity_scope`は外側hookを継承するが、Rust allocation量を数える機能ではない。
  Bのwhole-project容量既定値をC-queryへ流用しない。

このため現時点の成果は、pin/Source/anchorの内部readerとScene自身のScope helper、およびそのfocused
coverageまでである。対象Sceneの全A3開示、qualified path evidence、返却/クリック時のcurrent再検証、
Graph結果DTOへの接続、2 MiB同時保持と8 ms成功経路の実測は未完了で、未対応ならunavailableとする。

## 4. writer・lifecycleの対応

下表は現存経路のinventoryであり、全経路のGraph失効試験が実施済みという意味ではない。
pinが新しいauthorityになることを防ぐため、特定UIのhookだけに依存せず、DB mutationのread identityと
workspace lifecycleを使う。Scene/pin削除は不在、rename/body editはSource変更、restoreは旧binding失効へ収束させる。

| writer / lifecycle                           | 正本への影響                                                                | 必要な観測・失効                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `upsertScenePin` / `deleteScenePin`          | pinsを先に変更、その後relation mention cacheを別statementで更新             | pin commitで旧read identityを失効。cache更新の成功は待たず、cacheを参照しない                         |
| pin操作のundo/redo、Matrix操作、sample作成   | 上記APIまたは既存seed writerからpinを作成/削除                              | 同じDB mutation検出。通常操作以外を例外にしない                                                       |
| generic renderer/MCP DB操作                  | pinsは現存protected writer registryの個別登録対象ではない                   | NativeがDBのexact現状態を読む。rendererがclaimしたassociationを信用しない。全commit検出の負例に含める |
| Scene / Codex削除、project削除               | FK cascadeによるpin削除                                                     | 対象row不在とDB identity変更。両端project/Scene incarnationも確認                                     |
| Native project snapshot restore              | body auxのpinを置換。Codex-only restoreでもCodex削除のFK cascadeがpinを消す | body Scope token更新だけに依存しない。DB mutationとrestore lifecycleで旧結果を失効                    |
| import / workspace open・copy                | 新規IDや既存DBの取替え、データ復元                                          | ID同値だけで旧bindingを持ち越さない。workspace実体/epoch/incarnationを再確認                          |
| 通常本文保存、semantic mark編集、rename等    | tree_nodes本文/versionと、必要なら派生mention cacheを変更                   | body Source/storage digestとDB identityを失効。pinが残っていても旧excerptを使わない                   |
| schema変更、connection再生成、read owner取消 | read identityまたは実行ownerが変わる                                        | 旧resultをunavailable。新しいquery/ownerで再開                                                        |

特に現行snapshot実装はpins/mentionsをcanonical Narrative rootに含めない。
既存Scene/Codex Source tokenやsnapshot Feedがpin単位失効を既に保証しているとは主張しない。
全writerに新しい永続pin tokenを配布する代わりに、上記の保守的読取失効をまず実装・診断する。
Scene/Codexの削除undoがpinも復元するとは仮定しない。現存の削除undoはbody/owner復元とpin復元を
同一契約にしていない。bounded inventoryでは独立したpin複製writerは見つからなかったが、
将来のduplicate経路もDB mutation/lifecycleの同じ検証へ含める。

## 5. queryとmaintenanceの所有・資源

pin mappingはBのfull roster要素に追加しない。Bのmaintenance完了は従来のEntity/Relation/Evidence
complete rosterを確立する責務のままにする。Cのquery ownerが、そのcurrent sealed bindingを前提として
現在のpinsとSceneを読む。pin変更を理由に新しいpin adjacencyをbuild/publishしない。

| 段階                          | owner / transaction                                                   | 取得・終端                                                                                                |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| admission                     | C-queryの既存lifecycle participant、専用read-only reader、busy wait 0 | registration/marker未成立ならqueryはunavailable。full-set maintenanceを同期実行しない                     |
| path→pin discovery            | 同じquery owner / consistent snapshot                                 | 到達Entity IDをexact keyにして既存entry indexを利用。小さいkeyset pagesで全対象を列挙し、重複Sceneを統合  |
| Scope / Source / excerpt      | 同じowner / 同じquery総予算                                           | row bytesをallocation前に検査。本文JSON/canonical射影中も取消・期限を確認。候補ごとに予算をリセットしない |
| return current check          | snapshot終了後のfresh read、同じworkspace participant                 | identity/current binding不一致はGraph全体unavailable。結果期限後のGraphを既に返したqueryへ混ぜない        |
| click                         | Nativeの新しい短いread operationとlifecycle確認                       | 期限・marker・exact bindingが有効な間だけ移動。新connectionで旧identityを比較不能ならunavailable          |
| cancel / timeout / preemption | C-query ownerをactual cleanupまで保持                                 | SQL terminal、transaction終了、hook復元、buffer/reader解放を確認する。Raw connectionをinterruptしない     |

固定資源は引き継ぐ: read/admission 512、batch 16×32、SQL 100,000 VM steps、1,000 steps刻みの確認、
2 MiB、Graph 8ms、reader/busy wait 0。pin/Scene/Source読取、dedup、sort、JSONと抜粋保持も同じ予算へ
accountし、追加の「Scene接続予算」を外付けしない。全候補が資源内で列挙できない場合はpartial Graphを返さない。
8msをR+IRの追加待機Dへ加算しない。PのB/D/65.04ms/Tを保持する。

query ownerをUIクリックまで存続させてreaderやread transactionを占有しない。
結果は既存registryの期限付きbindingだけを保持し、query cleanup後のcurrent確認ができなければ失効させる。
別connectionの変更・自connection変更・schema変更を含むidentity parityと、同じ専用readerを再借用できるかは
**未診断**である。これが可用性を満たさない場合は接続方式を再検討し、旧identityの流用で救済しない。

SQL計画は実装前診断で、`entry_id = ?`によるpin index lookupとkeyset継続を確認する。
対象pin件数を固定し無関係Scene/pinを増量して、全Scene scanや本文全件parseへ退行しないことを測る。
ORDER BYのための全件sortをquery前に行わず、資源内に収まる候補を列挙した後だけRustで決定的順序を作る。

## 6. 候補選択・融合の事前規則

R+IRのmembership、順位、excerpt、Raw anchorを保持する。IRが共通追加枠を使っていれば、
R+IRが8件未満でも新しいGraph-only Sceneは追加しない。Raw満杯時も追加しない。
既存Sceneへのpath付加と新Scene追加の成否・件数を別に記録する。

追加可能な場合の候補順序を、次のtupleの昇順に固定する候補とする。

1. path hop数。
2. traversal順のexact edge ID列の辞書順。
3. 到達Entity ID。
4. Scene ID。

IDの比較は固定UTF-8 byte順で、locale/name/Gold/embedding score/観察後の都合を使わない。
同じSceneへの複数pathはこのtupleの最小pathを代表とし、そのpathの全edge/endpoint Evidenceを保持する。
既存Graphのpath方向・最大2hop・qualificationを変更しない。返却候補に必要なpathを途中で省略しない。
資源内で完全列挙できた対象に対してのみ、同tupleの先頭8 Sceneまでを返却する。これは既存の
返却Scene上限であり、read/admission上限に達した不完全な列挙を先頭8件として成功させる意味ではない。
同じSceneを1件にdedupし、既存R+IRにない最初の候補を末尾へ1件だけ追加する。
tie規則はG-01の出力を見てから変更しない。複数path/Sceneでの独立期待値テストは別途必要である。

## 7. G-01 fixture提案: 出力観察前の固定v1

識別子: `nir1-g01-explicit-pin-design/1`。**提案fixture / 未実行 / 受入れGold未変更**。
既存24件のmanifest/corpusは変更しない。以下は後続のG-case評価asset化に先立つ具体的期待値である。
全armは同一のquery、実Entity manual seed、Scope、corpus、sealed setupを使う。
runtimeのProposal/Revision/Decision/Source/Entity IDは通常writerが発行したものをlogical IDに対応付けて
setup receiptへ保存する。Goldに架空runtime receiptや人工vectorを埋め込まない。

言語はen。モデル・tokenizer・prefix・Raw/IR policyは既存固定manifestと承認済みcandidate policyのまま。
query `g01-query` の本文は次のASCII文字列に固定する。

```text
Which earlier scene contains the key recipient identified by the selected courier's handover?
```

| logical Scene ID | reading order | title               | canonical body（単一paragraph）                                                                                                                                       | Gold |
| ---------------- | ------------: | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| `g01-review`     |             0 | Ledger              | `The ledger lay shut on the shelf.`                                                                                                                                   |    0 |
| `g01-weather`    |            10 | Rain                | `Rain rattled against the shutters. A loose gutter tapped the brick wall until dawn.`                                                                                 |    0 |
| `g01-mira`       |            20 | Blue cloth          | `Mira folded the blue cloth into a square and placed it beneath the brass bowl.`                                                                                      |    3 |
| `g01-question`   |            30 | Unanswered question | `The clerk copied a question: Which earlier scene contains the key recipient identified by the selected courier's handover? No recipient was identified on the page.` |    0 |

current Sceneは`g01-query`、reading order 100。全Sceneは同project、明示Scopeを通常writerで設定し、
同じTimeline/Worldline/layer、reader holder/audience、非secret、resolved reading-before-S2とする。
query/materialの対応済みScopeを設定し、unknown軸やlegacy昇格に依存しない。

Entityと関係、対応は次に固定する。

- `g01-orin`: character、label `Orin`、summary `Orin is a courier.`。manual seedはこの実ID1件。
- `g01-mira-entity`: character、label `Mira`、summary `Mira keeps the brass bowl.`。
- `g01-handover`: `g01-orin → g01-mira-entity`、type `delivered-key-to`、direction `directed`。
  既存Relation writerで作者が宣言したRelationであり、新たに本文から推論しない。
- Option Bの通常prepareで上記Entity/Relationを`g01-review`の明示Scopeに束縛し、
  typed Revisionを保存・そのexact childを明示承認・FreshnessとB sealed bindingを確立する。
- 唯一のpinは `g01-mira → g01-mira-entity`。通常pin writerで作る。
  review Sceneはpinではなく、本文Evidenceでもない。他Scene/seedへのpinは作らない。
- Chronicleのqualified IRは`g01-question`の1件だけ。通常fixture provider/Proposal/child/Decision経路で
  `The clerk copied a question about a key recipient but identified nobody.` というactual/narrator/story-worldの
  解釈を作る。その他SceneはRaw-only。IRを無効化してGraphを試す代用にしない。

Goldの意味は「選択されたOrinの保存済みhandoverの到達人物が登場する以前のScene」である。
`g01-mira`だけが該当し、質問を書き写したSceneは回答ではない。
このfixtureは本文内でhandover自体が描かれたこと、作者効用、一般検索品質を測定しない。
Scene association・保存Relation・Scene本文の異なる証拠をUIで区別できることも期待値とする。

固定する**設計期待値**は次のとおり。これはruntime結果の断定ではない。

| arm / 項目    | 事前期待値                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| R             | `g01-question`だけ。queryを引用したcontrolが取得され、recipient本文は未取得    |
| R+IR          | 同じ1件。IRは同じcontrol Sceneへの付加だけで、共通追加枠は未使用               |
| Graph path    | 実seed OrinからMiraへの1-hop `g01-handover`1件                                 |
| Graph→Scene   | 唯一のexplicit pinから`g01-mira`1件                                            |
| R+IR+Graph    | `g01-question`, `g01-mira`。baseline row/Raw excerpt/anchorは完全保持          |
| Scene excerpt | `g01-mira`本文全体、canonical UTF-16 range `[0, canonicalUtf16Length)`         |
| Evidence      | Relation正本/Entity名・要約のpath Evidenceと、Mira Scene body anchorを別に保持 |

実Rawが別のmembershipを返す、IRが独立Sceneを追加する、setupが正規経路で資格を作れない、
budget内でcurrent Graph/Sceneを返せない場合は、その結果を保持して**v1期待値未達 / Hold**とする。
観察後にquery、本文、Gold、seed、追加順序、指標を調整して同じv1をPASSにしない。
fixture改版が必要なら失敗を残した別提案と独立期待値レビューを先に行い、元の固定24件を変更しない。

## 8. 数学上の成立と未測定項目

現行`scoreQuery`はunique Scene IDのRecall@8と固定eligible Goldに対するnDCG@8を計算し、
既存paired evaluatorの改善判定はnDCG@8の増加である。既存Sceneの順位上昇だけを要求する指標ではない。
baseline `H = R+IR`の長さを`n`、未取得追加Sceneのgradeを`g>0`、全eligible positive数を`P`とすると、
`n<8`かつ共通追加枠未使用のとき、末尾追加による期待差は次になる。

```text
Delta Recall@8 = 1 / P
Delta nDCG@8 = (2^g - 1) / (log2(n + 2) * IDCG@8)
```

v1の事前期待値では`n=1, g=3, P=1, IDCG@8=7`なので、Recallは`0 → 1`、
nDCGは`0 → 1/log2(3)`（約0.630929754）となる。top1はcontrolのままである。
baselineが正例を既に返す場合、その既存順位は改善できない。
Raw満杯・IR補完済み・既存Sceneへのpath付加だけ・grade 0の追加では、この検索改善は0である。

上記は算術的期待値であり、**G-01実行可能性PASSではない**。
次はすべて未測定・未受入れとして残す。

- 正規writer/providerでのfixture setup、実Raw/IR順位と共通追加枠の状態。
- exact sealed Graph path→pin→Scene Sourceの統合、対象Scene本文の開示、qualified path Evidence navigation。
- bounded readerのfocused coverageはC 31-case suiteで確認済みだが、2 MiB同時保持・8 ms成功経路の独立証明ではない。
- pin indexのEXPLAIN QUERY PLAN、無関係データ増量、512/2 MiB/SQL/8msの実測。
- 全writerの旧result失効、pin削除/同値再挿入、Scene/Codex削除、body-only/Codex-only restore、cold reopen。
- fresh transaction current確認、変更競合、取消後のSQL/reader実解放、Raw非占有。
- G-02〜G-08、既存24件比較、固定P統合、製品journey、独立受入れ。

## 9. 参照した現行実装

- `src/db/schema.ts`: `sceneCodexPins` / `sceneCodexMentions`。前者は明示link、後者はcache。
- `src-tauri/crates/grimodex-db/src/migrate.rs`: pinsの既存DDLとentry reverse index。
- `src/features/codex/sceneCodexPinsApi.ts`: pin正本とrelation cacheを別statementで変更。
- `src/features/codex/sceneCodexPinsStore.ts:73-160`、`src/features/matrix/MatrixPanel.tsx:267-296`: 通常pin操作とundo/redo、Matrix Scene作成。
- `src-tauri/crates/grimodex-db/src/protected_writers.rs:143`、`src/db/client.ts:9`: generic SQLも考慮すべきwriter surface。
- `src/features/codex/semanticLinks.ts`: exact entry IDのPM mark extraction。canonical rangeは未生成。
- `src/features/editor/beat/bodyMentionApi.ts`: semantic cacheの正本がProseMirrorであること、insert/prune方式。
- `src-tauri/crates/grimodex-db/src/narrative_extraction/source_revision.rs`: 既存Source kindとScene token。
- `src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/scene_source.rs`: bounded/legacy Scene Source/storage/canonical binding。
- `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/scenes.rs`: internal pin, Scene Scope, Source/anchor helper。
- `src-tauri/crates/grimodex-db/src/lib.rs`: connection-local `SqliteSourceRevision`。
- `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_chronicle_index/read_identity.rs`: committed read identity、schema guard、write transaction拒否。
- `src-tauri/crates/grimodex-db/src/project_snapshots.rs`: pin/mention aux、canonical root除外、restoreとFK cascade。
- 同上`:329`、`:793-808`、`:852-864`、`:2791-2837`、`:2919-2962`、`:3117`: aux所属、root非包含、owner削除、Scope更新、epoch境界。
- `src-tauri/crates/grimodex-db/src/sample_seed.rs:418`、`resources/sample_project/v2.sql:190-200`、`v2_en.sql:176-186`: seedのpin INSERT。
- `src-tauri/crates/grimodex-db/src/web_editor_handoff.rs:480-510`、`backup_restore.rs:553-594`: whole-DB import/restoreとworkspace/epoch境界。
- `src-tauri/crates/grimodex-db/src/scene_body.rs:401`、`:799-815`、`domain_writes.rs:815-958`、`revision_restore.rs:246-295`: 本文保存、rename、本文revision復旧の既存Source/Scope更新。
- `src/features/tree/treeStore.ts:1544-1559`、`src-tauri/crates/grimodex-db/src/agent_writes.rs:2553-2558`: owner削除undoをpin復元保証へ読み替えない根拠。
- `src/features/related-scenes/nir1RelatedScenesFusion.ts`: Raw保持と共通追加枠の既存実装。
- `scripts/quality/nir1-retrieval/contract.mjs` / `paired.mjs`: 固定評価式とnDCG改善判定。

## 10. material deltaの境界

本候補には、新しい永続保存・Source authority・consumer・data category・外部送信先の追加はない。
AssociationをNativeが現在の正本から読むことと、新しい保存authorityを作ることを区別する。
既存read identity/helperの共通化やwriter失効testは、確認済み契約を変更しない接続作業として扱う。

一方、pinをRelation成立の本文Evidenceへ昇格、cacheを完全性authorityへ昇格、
永続adjacency/独立pin Freshnessの導入、PM/name fallbackによる未宣言候補追加、
Graph8ms/512件等の緩和、結果を見たGold/指標変更が必要なら、当該差分を分離して確認対象にする。
現時点でその差分が不可避だとする証拠はない。成立をまだ測っていないことを、承認済み範囲の
再批准要求やG-01合格のどちらにも読み替えない。

## 11. 内部reader着手前precheck（2026-09-22）

confirmedRefはproposal/3のscope-storage-authorityとcaller-profile-egress、proposal/4のtyped-revision-material、
proposal/5のgraph-limited-bindingを継承する。新保存表、Assertion family、consumer、送信先、公開入口は作らない。
実装担当は本書author、統合担当はC-query担当、独立受入れ担当は別とする。
編集前に既存差分とRust規約を確認した。他laneの変更には触れない。

| 内部変更 | authority / owner / 失敗時 |
|---|---|
| exact pin候補と本文Sourceのbounded読取 | 既存pins/tree_nodes正本。C-queryのconn/snapshot/controlと累積admissionを借用。byte上限・取消・missingは失敗、部分資格を作らない |
| canonical本文射影 | 既存`gdx-canonical-text/1`と同じ原文規則。active progress ownerを借用してparse/各nodeで確認。新hookをinstall/resetしない |
| 一時body binding | 同snapshotのtoken/digest/rangeのみ。永続化しない。返却/クリックはC-queryのfresh read identity bracketが所有 |
| 開示条件の接続 | actual pathのA3 proofと、pin先Scene自身のScope/Sourceを別々に保持。EntityのScopeをScene本文へコピーしない |

本文読取・正規化のadapter自体は資格を与えないため先に実装可能であり、bounded内部adapterは実装済みである。
開示の残る設計論点は、Sceneに保存されないstory/auto/phase/reveal/POV材料条件を捏造せず、
実Entity/Relationに適用済みのA3と、Scene自身に実在するmaterial constraints/reading条件をどの型境界で
ANDするかである。missing fieldを`Any`にする方式やsynthetic Revisionは採用しない。
この点はC-query担当と独立調査を照合してからeligibleなScene結果の統合へ進める。

検証はexact saved本文、Scope一致/不一致、pin欠落・削除、Source変更、巨大row、処理途中取消のfocused tests。
同じ8ms/SQL/no-wait/cleanup ownerを保ち、新しいbackground/retry/lifecycleは作らない。
製品renderer・送信は未公開のまま。G-01 fixtureの出力観察やGold変更は本内部reader作業に含めない。
