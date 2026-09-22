# NIR-1 残工程実装計画 — 最終版

更新日：2026-09-22（Asia/Tokyo）
対象：Grimodex / NIR-1 B-close、C、D2b、P、E
状態：実行中の最終計画。全実装・B-close・G-01実行可能性検証・追加契約の批准・製品公開を完了したという記録ではない。
リポジトリ配置：`docs/plans/nir1-post-b-execution-plan.md`

2026-09-22の実装開始基点は `origin/master@6217e0155f53c9f8d267ed3c17e3952bc2f8f986`。B-close第1段階に続き、第2段階の診断実装でも19-path / 114-child-runを完走し、SQLite temp spill累積bytes・PROFILE可視SQL VM steps（下界のみ）・mode固有のfull-set取消/foreground待機を計測した。lifecycle SQLのexact値/上界、Restoreのfile-install/recovery/rebuild全体の取消・総temporary disk high-waterは未計測で、数値capacity/deadline候補は診断用draftに留まる。批准・N/N+1受入れ・B-close完了は未達である。結果と非主張は [B-close capacity observation](nir1-b-close-capacity-observation-2026-09-22.md) を参照する。Graph query、Packing、製品dispatchは未公開である。

## 0. 現在地と基点

確認時点のmasterは `146d8535accef1c9a7621a4910dd2bf820856f87`、Treeは `152c446f2d668b18a118a5324c76358bd4ebea0d`。#601は親#600へ入り、#600も2026-09-21にmasterへマージ済みである。実装時は、このSHAへの固定checkoutではなく、最新 `origin/master` から専用worktreeを作成する。[S1][S2]

#600の最終PR記録はQuick/verify、Full/verify、28/28 Product Journeysの合格を報告している。一方、19-path / 114-child-run容量matrixの完了、数値supported capacity、取消遅延・foreground待機・一部メモリ項目の測定、全T01〜T36 fault組合せの認証は主張していない。本計画はPR記録を参照したもので、保存された全receiptの独立再検証ではない。[S1]

したがってB-closeは「#600/#601のマージ待ち」ではなく、「マージ済み実装に対する残る容量・必須境界の受け入れを閉じる作業」とする。A2の限定レビュー、A3・B・D1の既存基盤と共有lifecycleは再設計しない。Graph query、Packingの製品dispatch、新local送信は未公開として扱う。[S1][S3]

## 1. 目標、範囲、契約の扱い

### 1.1. 到達する製品操作

通常操作によるEntity/Relation準備と明示承認から、明示seedを使ったGraph付きRelated Scenes、exact Evidenceへの復帰、Rawと適格材料を使うlocal生成、本文保存、適格な自会話履歴での次turn、Scope変更後の履歴除外、cold reopenまでを成立させる。

「承認済み」「Fresh」「開示可能」「Packing済み」「送信可能」「生成成功」「次turnで再利用可能」「内容が真」は別の判定であり、相互に代用しない。

### 1.2. 引き継ぐ契約

| confirmedRefの系列 | 引き継ぐcontractId |
|---|---|
| `nir1-l6-l9-contract-proposal/3` | `scope-storage-authority`、`caller-profile-egress`、`native-generation-receipt`、`history-reauthorization` |
| `nir1-l6-l9-contract-proposal/4` | `typed-revision-material`：Option B / `nir1.entity-relation@1` |
| `nir1-l6-l9-contract-proposal/5` | `graph-limited-binding`：三つのresource unit、whole-project lifecycle、測定と受け入れの分離 |

既存の確認済み行を再批准し直さない。各提案節のhistorical baselineにある「未承認」を、現在の確認台帳より優先しない。一方、計画への同意を、新規の保存範囲・authority・consumer・送信先・品質閾値・信頼境界の批准へ拡張しない。[S3]

新しい差分が必要な場合は、変更前後、既存保存先への対応、writer、失効・復旧、受け入れへの影響を、該当する契約の差分として記録する。差分がある箇所だけを確認対象とし、無関係なレーンの設計・診断まで止めない。

### 1.3. 非目標

新しいAgent framework、Agent/tool/sub-agentの製品再有効化、Graph Explorerや新探索パネル、曖昧なentity resolution、Relation自動推論、2hop pathからの新規Assertion生成、他の抽出familyの移行、全文closureの複製、独立したFreshness/承認authority、永続adjacencyの無断追加、外部モデル送信、profile制限の解除・分離profileは含めない。

D2bの永続参照は既存message/artifact/receipt等の保存先とwriterへ対応付ける。既存構造で表現できない変更が判明した場合、schemaや保存範囲の差分を明示する。「新しい汎用基盤は作らない」を、必要なdurable参照を保存しない言い訳にはしない。

## 2. PR分割、開発依存、公開依存

C-query/C-productはNIR-1 Cレーンの分割名であり、#601内部のC0〜C5とは別である。

| 単位 | 成果 | 開発開始条件 | この単位の完了・公開境界 |
|---|---|---|---|
| B-close | 容量診断・数値契約・必須lifecycle境界の残受け入れと文書同期 | 現在のmaster | 後続実装の基点。Graph/送信は未公開 |
| C-query | 完全性と資源境界を持つcanonical seed-local reader | B-close、Cの接続契約確定、既存A3/D2a | Native・内部統合まで。製品Graph未公開 |
| C-product | Related Scenes融合、Evidence navigation、G-case、P統合再確認 | C-query、G-01実行可能性確認 | Graph公開条件成立後にGraphのみ公開 |
| D2b-1 | 最終入力来歴、非認可handle、一回限りdispatch権、receiptと復旧 | B-close、Dの保存・確定契約確定、既存D1/D2a | 試験transportまで。製品送信未公開 |
| D2b-2-history | 毎turnの推移依存再認可、枝ごとの除外、資源制御 | D2b-1と共通参照契約、既存資格reader | 内部実装はC-productを待たない。Graph履歴の実統合受け入れにはC-queryが必要 |
| D2b-2-dispatch | 最終request、local送信、保存、次turnを接続 | C-product、D1、D2a、D2b-1、history全必須統合 | 対応済みlocalのみ公開 |
| E | L9固定比較・実製品journey・最終候補の独立受け入れ | 全機能レーンとP | 必須Holdがない場合だけNIR-1 Complete |

PはC-productでGraph統合再確認を行い、Eで最終候補への適用を確認する独立評価責務とする。測定コード修正が独立の変更にならなければ、P専用機能PRを必須にしない。

B-closeと並行して、Cの候補取得方式・Scene接続・G-01の成立確認、Dの参照保存先・dispatch確定順序・失敗試験設計を進める。これは基盤設計・診断の先行であり、B-close前の製品activationではない。

history PRはまずC-product非依存で作業を開始できる。C-queryが未完了ならGraph接続試験をpendingとして残し、当該PRをhistory全体完了とはしない。既定のmerge条件はC-queryによるGraph接続確認まで含む。限定coreだけの先行mergeが必要なら、限定範囲と未完了graph受け入れを明示した変更として扱い、完了条件を黙って削らない。

### 公開条件

- Graph：A3 + B-closeを含むB受け入れ + C-query/C-productを含むC受け入れ + D2a。
- Packing/local生成：C + D1 + D2a + D2b-1 + D2b-2-history/dispatchの全必須受け入れ。

既存AND条件は変更しない。C-productの公開は送信停止解除を伴わず、D2b-1/historyのmergeも製品送信再開を伴わない。[S3]

## 3. 実装開始前に閉じる接続契約

これらは新たな汎用基盤PRではなく、本計画と該当レーン冒頭の設計・診断成果物に含める。「記載した」だけで完了にせず、保存先・writer・reader・失効境界・試験の対応を確認する。

| 項目 | 固定する内容 | 完了根拠 |
|---|---|---|
| C候補取得 | seed/frontierからexact Revision候補への取得、sealed generationとの対応、欠落検出・失効、SQL計画 | 独立正解経路との比較、無関係データ増量、欠落/世代不一致試験設計と診断 |
| CのScene接続 | Graph Entity/pathをScene候補へ結ぶ正本、Source、失効、Evidence区分 | 製品で使うjoinと同じ方法のfixture。scope Sceneを本文根拠へ読み替えない |
| Dの入力来歴 | Packing後の最終入力参照、親immutable version/receipt、直接材料、必須資格依存の保存 | writer/read契約、payloadとの対応、二段依存・独立枝の試験 |
| Dのdispatch/保存 | 最終認可、dispatch権取得、送信前durable attempt、本文/receipt/来歴確定、復旧 | 競合・クラッシュ状態表とrecorderでの0/1送信試験 |
| C-productのG-01 | 固定baseline、追加枠、追加可能Scene、評価指標・範囲 | 現行融合で改善することの説明と実行可能性確認。未測定をPASSにしない |

未解決なら、必要な契約差分か実装方式の再検討を記録する。新authorityや永続adjacencyを無断で導入しない。G-01を満たすための事後的なGold/指標の変更もしない。

## 4. 全レーン共通の実装境界

### 4.1. 資格と同一性

A2はexact current Revisionの資格、A3は今回のqueryへの開示、Bは完全集合を根拠とするsealed Index、D1は今回の材料・用途・予算での選択、receiptは特定生成の観測と保存整合、history gateは今回の再利用資格を担当する。

材料の同一性（Revision/Source/Decision/Evidence）、用途の同一性（Scene/Scope/purpose）、実行の同一性（workspace binding/caller epoch/attempt）を分離する。既存型とbindingを継承し、万能な `eligible: true` を層間で使い回さない。同一project IDや同じDB内容でも、別workspaceコピーへの旧handle流用は不可とする。

### 4.2. Snapshot整合性とcurrent性

材料構築はcaller-owned transaction内で一貫させ、返却・クリック・dispatchではcurrent性を別に確認する。WALの同じread transaction内で再SELECTしても、その後の別connectionのcommitは見えないため、それを「送信直前の最新確認」の代用にしない。[S6]

異なるtransactionで個別に検証・PackingしたRevisionを、未検証のまま結合しない。複数材料へ拡張する場合は、同じsnapshot、同じquery資源予算、同じPacking総予算で処理する内部helperを使う。短いtransactionを終えた後にbindingを再検証し、rendererの要求番号は表示競合対策に限り、認可の正本にはしない。

### 4.3. 取消と所有権

取消要求、処理結果の破棄、SQL/解析の実終了、cleanup、connection再利用可能化は別の段階とする。Graph unavailableを返せても、旧SQL・buffer・readerが残る間はownerを保持し、そのconnectionを再利用しない。

outer ownerがconnection-level progress hookを所有し、A2/A3等のnested helperは借りる。SQLiteのprogress handlerはconnectionにつき一つで、新規設定が以前のhandlerを置換するため、内側でinstall/reset/解除しない。[S7]

cleanupは#600/#601の既存終端・quarantine手順を再利用する。hookを解除する具体順序も既存の確定済み手順に従い、本計画で独立した順序へ置換しない。エラー、autocommit、rollback/close、reader/buffer解放、設定復元と再利用可否を確認する。

generation ownerはtransport待機とterminal保存まで所有するが、DB transaction slotやmaintenance laneを応答待ち中ずっと保持しない。新規受付を閉じた後も、その既存ownerの終端保存・cleanupを完了できる限定経路を設ける。長時間readによるWAL checkpoint阻害を避ける。[S8]

### 4.4. 未公開経路と診断

UI非表示だけでは非公開としない。製品IPC/Native/transport入口への直接要求を既存gateで拒否する。rendererから試験transport、fixture proof、test-only bypassを選択できない。試験/製品で低層実装を共有しても、許可を与える入口は隔離する。

診断は、candidate/read/qualified counts、完全性状態、失効理由、fallback先、予算、取消/cleanup、参照digestなど必要な項目をallowlistで扱う。内部Decision注記、credential、raw URL、本文/thinkingを未分類log/イベントへ流さない。

## 5. B-close：残る容量・lifecycle受け入れ

### 5.1. マージ済み証跡と未完了を分離

#600/#601のmerge受け入れをやり直す計画にはしない。既存の受け入れ台帳とT01〜T36を対応付け、証拠のある範囲、追加境界試験が必要な範囲、未測定を区別する。全ケースをE2E化し直す必要はないが、実配線を必要とする失敗は単体試験で代用しない。[S1][S2]

必須の未証明事項はB-closeで閉じ、Eへ先送りしない。範囲外やdeferredという扱いが必要なら既存契約に根拠を持たせ、計画作成者の判断だけで免除しない。同期推論/OS stall中の絶対的30秒終了など、未証明の上限を機能試験から推定しない。

主な確認対象は、取消から実解放まで、workspace切替/Open/Restore、recoveryとdelivery ACK、accepted/preempted/hasMoreの再探索継続、成功済みworkの非再実行、foreground進行、dirty draft保全と明示Open/hydrationである。

### 5.2. 二段階の容量確定

第1段階で現行manifestの19-path / 114-child-runを、同じpreseed済みfile-backed DB copyとfresh subprocessで測定する。各Revisionは有効のまま全体512超の材料、Revision多数/少数、payload/envelope/live Source bytes、Evidence共有/非共有、依存edge、不適格候補、report-heavy、失敗経路を含める。

buildのprepare/A2からpublish/cleanupまでと、初回build以外のSource再解決、complete registration、coverage、restore、cold reopen各attemptを個別にend-to-end測定する。roster/Revision-ID bytesだけを総peakと呼ばない。二つのroster、dependency collections、JSON/parsed材料、Evidenceコピー、D1準備/検証、serialization、DB/statement/cache、container capacity、temporary copies、報告生成を含む同時peakか保守的上界を示す。

wall/CPU、SQL、read/write、temp、lock/publish/connection occupation、foreground wait、取消遅延、cleanupも測定する。VM stepsのexact/上界/下界をmethod・coverageで区別する。過去の累積PROFILE上界も未trace接続やSQLite内部VMまで覆うものではなく、現行の`exactVmSteps=false` / `profiled-subset-lower-bound`を上界やcapacity受入れへ読み替えない。RSS不明を瞬間RSSで代用せず、method/coverage/uncertaintyと未計測項目を残す。主要構造に未accountがあればcapacity判定をしない。[S1][S3]

第2段階で、測定からsupported work size、memory、SQL、deadlineを選び、必要な確認を経て実装する。測定前の仮値は診断専用とする。境界内成功、N/N+1の安全な拒否、取消/競合/失敗時のpartial generation非公開、冷再開を受け入れる。

### 5.3. B-close完了

完全roster、atomic publish、writer失効、所有者付きfull-set validation、必須lifecycle境界、容量matrixと数値契約が揃い、Graph/送信未公開回帰が通ること。常にunavailableを返すだけでは正常容量の受け入れにならない。

## 6. C-query：canonical seed-local reader

### 6.1. 候補列挙と完全性

現行の仮catalog readerをそのまま製品有効化しない。seedは明示選択した実在Entity IDを1件だけ受け付ける。名前・本文・renderer申告からID/Relationを推測しない。

既存Codex/Relationの索引を候補発見へ使うことは可能だが、所在地の発見と資格を分ける。seed/frontierから必要なexact Revision候補をindexed keysetで読み、A2、Human Decision、Freshness、A3、sealed Graph bindingへ照合する。

列挙元とcanonical承認済み材料の対応は、構築/登録で検証し、対応を壊すwriterで失効させ、query admissionでcurrent性を確認する。同じgeneration IDというだけでは欠落なしの証明にしない。対応が保証できない場合は `unavailable` とし、「関係なし」の空結果にしない。full-set検証が必要ならqueryで開始せず、既存maintenanceへ所有者付き要求を送る。

queryごとに完全Graphをscanして完全性を証明しない。既存構造で完全性とbounded取得を両立できない場合、Cの取得方式を未成立として差分を検討する。新しい永続adjacency/authorityを黙って作らない。

### 6.2. 資源契約

| 単位 | 契約 |
|---|---|
| 単一Revision validation | 現行512 records / 2 MiB。query/build全体の容量と混同しない |
| seed-local query | read/admission 512、batch 16×32、SQL 100,000 VM steps、1,000 steps刻みの取消・期限確認、2 MiB、Graph 8ms、reader/busy wait 0 |
| 意味上の探索 | 最大2hop、発見Entity 12、適格edge展開144、返却Scene 8 |
| whole-project build | B-closeで測定・確定する独立資源契約 |

以上は既存固定契約値であり、今回測定した結果ではない。[S3]

query予算は候補SQL、A2/A3、JSON解析、Evidence解決、path構築、必要なserializationを通じて共有する。helper/Revision/pageごとにリセットしない。不適格行もread/admissionを消費するが、frontier・適格edge展開・順位には寄与しない。非開示edgeを橋にして先の適格Entityへ到達することは禁止する。

一度に必要なものだけを読み、巨大行はallocation前に検査する。同一query/snapshot/Scopeの同じRevisionはrequest-localで重複検証を抑えるが、保持メモリも予算へ含める。Revision全体の開示確認が必要な契約を、使うedgeだけの検証に縮めない。

専用read-only connectionと既存lifecycle participantを使い、Rawのconnectionを占有/interruptしない。取得待ち、SQL最初のrow以前、Rust/JSON処理、queued workまで取消を伝える。資源超過/取消/競合ではpartial Graphを返さない。Graphの結果期限とcleanup完了時間は別測定とし、期限超過後も実解放までownerを残す。

### 6.3. SceneとEvidence

Relation Evidence、Scope上のScene、関連Scene候補への対応、Scene本文excerptを区別する。Option Bが持つのはCodex Entity/Relationと名前/要約Evidenceであり、review時のScene IDを本文上の関係の証拠にはしない。[S3]

Graph→Sceneのjoinには既存の正本上の対応情報、Source token、失効条件を固定する。Relation根拠はRelationの正本へ、本文抜粋は本文のexact anchorへ移動する。参照先不存在/改変はunavailableとし、類似文字列で補修しない。

2hop pathは既存edge列と各Evidenceとして返す。`A —兄弟→ B —勤務先→ C` を `AはCに勤務` に変換しない。複数Revisionの同一実IDを結合する際も、各edge/endpointのexact bindingを保持し、矛盾する版を名前一致で統合しない。

### 6.4. 受け入れ

独立したcanonical読取による正解経路と比較する。seed近傍を固定して無関係Revisionを増量し、全件scan/JSON展開へ退行しないことをSQL計画と実測で確認する。

欠落候補、世代不一致、keyset飛ばし、ページ境界の重複、不適格bridge、方向違い、巨大行、上限、取消、失効を試験する。実行時不整合をどの登録/admission境界で検出するかと、列挙アルゴリズムの欠陥を独立比較で防ぐことを区別する。任意の物理DB破損を毎queryで全面検出する保証には広げない。

製品Graph入口への直接呼び出しは拒否されたままにする。

## 7. C-productとP：Related Scenes統合

### 7.1. G-01の事前実行可能性確認

固定query/seed/corpus/Gold、R+IRの件数/順位、共通追加枠の使用状況、正本から追加できるGraph由来Scene、改善指標と評価範囲を対応付ける。空き枠があっても、追加位置が評価範囲外、候補が既存結果と同一、改善指標が固定順位のみを測る場合には改善しない。

既存24検索caseの合格はG-01の代用ではない。Graph fixtureが未具体化なら、実装結果を見て選ぶ前に独立期待値を固定する。両立不能なら融合契約か評価契約の差分を提示し、事後的にEvidence追加を検索改善へ読み替えない。現在の計画段階ではG-01成立は未検証とする。[S3][S5]

### 7.2. 融合・UI

R+IRの既存membership、順位、excerpt、Raw anchorを保持する。Graphは既存Sceneへのpath Evidence付加と、IRが使っていない共通追加1件枠のみを利用する。Raw満杯/IR補完済みは既存結果を押し出さない。

既存Related Scenesへ明示seed、path、根拠ナビゲーション、利用不能理由を追加する。新しい探索パネルは作らない。返却/クリック時にquery、generation、Revision、Decision、Scope、Sourceを再検証する。Graph停止はR+IRへ、Chronicle停止はGraphも止めてexact Rへ戻す。既に完了したqueryへ遅いGraph結果を混入させず、次queryで使う。

### 7.3. 品質・性能

既存24検索case、G-01〜G-08を、共通query/manual seed/contextで R / R+IR / R+IR+Graph 比較する。Graph改善の比較相手はR+IR。seed-onlyは診断専用。macro非回帰、G-01の事前指定改善、Evidence妥当性100%、禁止寄与0を要求し、path Evidence追加とScene検索改善を別計測する。

Pは固定B=54.2ms、D=10.84ms、上限65.04ms、T=2144.7msの既存契約、Gold、model hash、warmup/run数、測定起点を維持する。Graph8msを追加待機予算として足さない。既存standalone性能合格は過去証跡であり、Graph統合後のPASSではない。build/回復測定のどの区間へ固定Tが適用されるかも既存P契約へ対応付け、B容量診断と都合よく混ぜない。[S3]

Graphの常時unavailableで速さと禁止寄与0だけを満たしても合格にしない。品質・可用性・性能を同時に満たすこと。C-productでGraphを公開してもAI送信の停止は維持する。

## 8. D1の製品統合：共通snapshot・予算・投影

D1基盤は作り直さず、D2b-1の入力adapterとD2b-2-dispatchで必要な接続を担当する。共通helper抽出はD2b-1側を所有者とし、C側は同じ箇所を独立改変しない。

単一Revisionの既存wrapperを残し、複数Revision/Graph材料を扱う内部helperへcaller-owned transaction・共通read資源制御を渡す。同一snapshotで資格を揃え、共通候補集合を一度だけPackingする。別々にPackingした出力を後から単純結合しない。[S4]

raw / accepted-ir / graph-evidence / author-declared / unreviewed-for-reviewの区分と、statement/negation/attribution/Evidence/qualificationのatomic groupを保持する。ただし区分型があること自体は新material familyの認可ではない。各材料の既存readerと対応済み範囲だけを使用する。

Raw本文はSource参照から取得し、現在のuser入力・保存履歴・IRからの投影と区別する。rendererが `kind: raw` や任意token数を申告したことだけで資格/予算検証を迂回できない。人手入力の意味を完全追跡する保証にはしない。

最終予算はsystem、history、user、context、形式上の付加分、応答予約を含める。toolは本版では無効だが予算計算上の存在を無視して別経路から投入しない。共通estimator/versionを使い、provider固有の付加費用も扱う。既存推定器上の予算順守と各local model tokenizerの厳密上限保証を混同しない。

必須Rawを優先し、必須Raw自体が収まらない場合は入力縮小が必要な結果として返す。黙った切詰めは行わない。非Rawはgroup全体を採用/除外し、statementだけ残してEvidence/資格を落とさない。レビュー由来履歴/要約/tool結果を執筆会話へ移さない。

内部bindingを丸ごとprompt化しない。資格textはallowlist投影とし、任意Decision注記は変更検出用に保持してもモデルへ送らない。内部metadataへの検出用文字列が最終requestへ現れない試験を置く。

## 9. D2b-1：来歴保存、dispatch権、receipt

### 9.1. 最終入力来歴の所有

D2b-1が、Packingと最終request組み立て後の入力来歴writerを所有する。実際に採用されたmessage/artifactのimmutable version、生成物の親receipt、Raw/IR/Graph材料のexact参照、入力位置/役割、必須資格bindingを保存し、最終payload digestへ対応付ける。

payload digestは内容同一性を照合するもので、依存辺を復元する代わりにはならない。必要な参照は別に保存する。本文/thinking/full closureは新台帳へ複製せず、既存正本へ参照する。人手入力には実際の入力由来・versionを使い、架空receiptを作らない。

依存は次の二層を維持する。

| 層 | 内容 |
|---|---|
| 直接入力依存 | 最終requestへ実際に採用したmessage/artifact/材料だけ |
| 資格・推移依存 | 採用した履歴の祖先、採用Revision全体の承認/Source/Scope等の必須依存 |

不採用候補は直接入力依存へ追加しない。ただし、採用履歴の祖先にある場合や、採用した承認済みRevision全体の資格を左右する場合は依存が残る。Revisionの承認単位を独自に細分化してはならない。

入力参照とpayloadはimmutableに確定する。確定後の追加/順序変更/再Packingは同じhandleへ付け替えず、新しいrequestとして扱う。

### 9.2. handleとdispatch一意性

handleはそれ自体で認可しないopaque参照である。mainの実IPC sender由来callerを使い、Nativeがprofile/caller epoch、workspace実体binding、project/session、message version、purpose/Scope、material/D1 binding、route設定版、provider/model/API/endpoint、payload、期限を確認する。

同じhandleでアプリケーション上のdispatch開始は最大1回。成功した同時二重要求はrecorderで1回、cancel/失効が先行すれば0回。terminal receipt件数だけでは判定しない。

最終認可と一回限りdispatch権取得に確定点を置き、同一handle競合、cancel、profile停止、workspace/Scope変更との順序を既存lifecycleと整合させる。DB条件付き更新だけでDB外のprofile/caller状態まで原子化したとみなさない。権利取得ownerだけがtransportを呼ぶ。

### 9.3. 送信・確定・復旧の順序

1. 最終payloadと入力参照を確定し、送信前に復旧可能なattempt識別を永続化する。
2. current性、route、期限、公開gateを再検証し、一回限りdispatch権を取得する。
3. そのownerが確定済みpayloadを確定済みlocal transportへ渡す。
4. trusted transport解析点で出力・provider終端・parse結果を観測する。
5. 本文immutable version、来歴、terminal receiptの保存整合を確定する。
6. 整合した成功だけを履歴候補として公開する。次turnの再認可は別途必須。

権利取得後に送信できなかった場合も同じhandleを未使用へ戻さない。送信前後のクラッシュで外部実行の有無が不明でも、旧handleを自動再送しない。retry/429/再生成は新handle・新receiptで再認可し、HTTP層の隠れた自動再送・redirect・proxy経由の迂回を禁止する。

送信確定前の失効は拒否する。確定後の失効は取消と結果資格の失効を行い、既送信bytesを取り戻せるとは主張しない。モデル待機中にDB transactionや全writerをロックし続けない。

本文だけ/receiptだけの保存では履歴利用資格を与えない。同一DBなら既存transaction、別artifact storeなら既存の確定手順で整合を担保する。途中本文の保存/UI表示と資格を分ける。terminal競合は永続状態と既存matrixの遷移で一つに確定し、「最初のcallback勝ち」にしない。

新規受付停止後も、既存attempt ownerによるterminal保存とcleanupを完了できるようにする。dirty draft、RecoveryShell、明示Open/hydrationの既存境界を迂回しない。

### 9.4. 既存terminal matrixとdigest

| terminal | parseStatus | responseDigest | 主な扱い |
|---|---|---|---|
| succeeded | parsed | 必須 | 正常provider終端、本文/version/来歴の保存整合あり |
| failed | invalid | 必須 | provider終端不適格、EOFのみ、length truncation、parse失敗等 |
| failed | not-attempted | null | dispatch failure等 |
| cancelled | not-attempted | null | cancel |
| skipped | not-attempted | null | skip |

外部matrixは追加しない。内部状態・未知の送信結果・復旧を既存matrixへ対応付け、未観測provider terminalを創作しない。`not-attempted` はprovider実行がなかったという証明には使わない。[S3]

各受け入れ済みattemptのterminal記録は正常終了または復旧で一つへ収束させる。DB書込み失敗時に即時永続化を保証したことにはせず、資格を閉じたままdurable attemptから復旧する。

text/thinkingをtransport解析点で分離し、versioned/domain-separated digestを取る。chunk境界には不変、順序には敏感、trim/Unicode normalizationなし。renderer連結本文、UI done、EOFだけを成功証明にしない。UTF-8途中分割、複数イベント、終端重複/終端後データ、text/thinking交互到着を試験する。

### 9.5. D2b-1完了

保存先/writer/readerが対応し、二段以上の来歴、dispatch0/1、競合、クラッシュ、失敗matrix、本文/receipt整合、試験transport隔離が受け入れ済みであること。通常の製品送信は未公開のままとする。実history gateは次PRの責務。

## 10. D2b-2-history：全推移依存の毎turn再認可

### 10.1. 再認可

D2b-1が保存した最終入力参照をたどり、Source、Revision、Decision、Freshness、Index、現在のpurpose/input-use/send分類、Scene、reading/story/auto、phase/reveal、viewpoint、holder、audience、Timeline、Worldline、layerを既存資格readerで検証する。

Source/Decision未変更でもScene/holder/Worldlineの変更で不適格なら除外する。過去の許可、UI表示、rendererのsafe申告、来歴なし旧履歴、import/restoreしたIDだけでは再利用しない。編集/再生成/削除/undo/restoreで旧receiptを別本文へ付け替えない。適格assistant履歴をNarrative Assertionとして自動承認しない。

`X → M1 → M2` で今回M1を予算から落としても、M2のX依存は残る。予算削減で祖先参照を消さない。モデルの「使っていない」という説明も依存除去の根拠にしない。UI本文は残せるが、不適格入力と子孫は送信候補から外す。

### 10.2. 1 turn全体の資源契約

依存node/edge訪問、SQL/read量、参照解決bytes、保持メモリ、wall time、取消/cleanupを一つのturn予算で管理する。候補ごとにリセットしない。同一snapshot/purpose/Scopeの検証結果を共有し、長いchain、共有祖先が多いdiamond/fan-out、欠損、循環を測定する。数値は実測後に固定し、Graphの512/8msを流用しない。

子の検証完了前に親を適格と確定しない。循環/欠損/未知version/上限到達は検証未完了として扱い、残りを安全と仮定しない。全closure本文を各messageに複製せず、immutable参照をたどる。

### 10.3. 除外と全体停止

候補固有の不適格/検証未完了は、その候補と影響する子孫を除外する。同じ有効な共通認可条件下で独立して検証完了した候補は残せる。必須入力が不足した場合は送信しない。

workspace/profile/query Scopeの失効、request全体の取消、最終payloadとの不一致はturn全体を止める。「安全そうな枝」だけで続行しない。

### 10.4. 完了条件

二段以上の連鎖失効、独立枝継続、独立不採用候補の無影響、同一Revisionの必要失効、予算から祖先を落とした後の子孫除外、長い正常会話、共有祖先、欠損/循環/取消が合格すること。Graph由来の実来歴はC-queryと接続して検証する。全部履歴拒否で合格としない。

## 11. D2b-2-dispatch：最終requestから次turnまで

今回のScopeと材料の読取条件を確定し、履歴を再認可し、Raw/IR/Graphを共通snapshot/予算で選択する。system/user/history/contextと形式費用・応答予約を含む最終requestを組み立て、最終入力来歴を確定してhandleへ束縛する。dispatch直前にcurrent性とrouteを確認し、D2b-1の一回限り権利で送信する。

対応済みlocal HTTPの本文/reviewだけを公開する。provider名や `localhost` という文字列だけでlocal認定せず、確定したendpoint identityとrouteを照合する。対応外transport、proxy、redirect、外部切替、A/B、CLI、Codex App Server、タイトル生成、要約、tool、Agent/sub-agent、旧messages fallbackは停止を維持する。[S3]

このPRでP-01〜P-12をD1 fixtureとは別に最終requestで受け入れる。P-12は固定ContextPlan/Raw-priority baselineと同一総token budgetで事前指定slotを少なくとも1件改善する。送信成功や材料増加だけでは改善PASSにしない。

loopback recorderで実payload、対象endpoint、送信回数、禁止検出文字列、履歴の採否を観測する。正常生成→保存→次turn、取消、retry、route変更、Source/Scope失効を実経路で試験する。拒否原因と履歴除外を利用者へ示し、UI表示可能な本文まで消す必要はない。

## 12. 必須試験の追跡表

以下のIDは本計画の試験追跡用であり、新しいpolicy/authorityの識別子ではない。既存G/P/T台帳とrequirementへ対応付ける。

| ID | owner | 主要な正例・負例 | 合格時の観測 |
|---|---|---|---|
| BC-1 | B-close | 多Revision/byte/Evidence/report/full-set各path | 完全roster、atomic publish、全体peak/SQL/待機/取消の測定 |
| BC-2 | B-close | cancel→close、preempted/hasMore、ACK、restore | 実解放/限定復旧/成功work非再実行、必要work継続 |
| CQ-1 | C-query | 候補欠落/世代不一致/keyset飛ばし | 独立正解一致、または登録/admission失効からunavailable。誤った空結果なし |
| CQ-2 | C-query | seed近傍固定＋無関係Revision増量 | 全件scan/JSON展開に退行せずquery資源内 |
| CQ-3 | C-query | 非開示bridge/方向違い/巨大行/上限/取消 | 禁止寄与0、部分Graphなし、Raw非占有、実cleanup |
| CP-1 | C-product | G-01〜G-08、Raw満杯、IR補完済み | 事前指定改善と固定結果保持、Evidence100%、安全fallback |
| DI-1 | D1統合 | 複数Revision間のSource更新 | 混合snapshotなし、共通予算、返却/dispatch再認可 |
| DG-1 | D2b-1 | `X→M1→M2`、独立枝/不採用候補 | exact最終入力来歴と必要な資格依存を保存 |
| DG-2 | D2b-1 | 同一handle並行、cancel/失効競合 | recorder1回または0回。receipt件数のみで判定しない |
| DG-3 | D2b-1 | 送信前後/本文保存/receipt保存/通知の間でcrash | 旧handle非再送、重複終端なし、未確定履歴資格なし |
| DG-4 | D2b-1 | UTF-8/chunk/terminal/text-thinking変形 | digest契約、正常終端限定の成功、失敗receipt確定 |
| H-1 | history | Scopeだけ変更、祖先を予算除外、長chain/diamond | 子孫除外、独立枝/正常会話継続、重複検証抑制 |
| H-2 | history | 欠損/循環/turn上限/共通認可失効 | 未完了を適格化せず、枝除外と全体停止を区別 |
| DP-1 | dispatch | P-01〜P-12、任意Decision注記canary | 必須Raw/Evidence/label保持、同一総予算、禁止情報0、P-12改善 |
| A-1 | 各中間PR | direct IPC/Native/試験入口/旧route | 未公開機能拒否。Graph公開のみでは送信0のまま |
| E-1 | E | 通常操作→Graph→Evidence→生成→次turn→失効→reopen | 実Electron/IPC/N-API/SQLite/transport一貫性 |

競合試験は固定sleep増加ではなく、検証後、dispatch権取得前後、publish、terminal保存等の同期点で再現する。性能は実時間で別測定する。期待値生成に実装と同じ誤りを共有させず、mockのみ/正例のみ/単体のみを製品受け入れにしない。

## 13. E：統合受け入れと完了判定

Eは未実装をまとめて埋める工程にしない。各レーンの合格を最終候補へ接続し、通常操作から実Electron、IPC、N-API、SQLite、local transport、loopback recorderまでを通す。

最低限、Entity/Relation準備・Evidence確認・明示Decision→Index build→seed検索→path/Evidence復帰→local生成→本文/receipt保存→自会話次turn→Scene/holder/Worldline変更による旧履歴除外→cold reopenの一連を確認する。

取消、保存前後クラッシュ、workspace切替、restore、Graph unavailable、巨大frontier、旧送信route拒否、legacy互換/ID再利用を負例として含める。既存正常な保存・編集・Raw検索・承認・復旧も回帰させない。

NIR-1 Completeは、B容量と必須lifecycle、C品質/性能/Evidence、D1/D2b最終入力/来歴/生成/履歴、全中間公開境界、固定24/G8/P12、必須実journey、独立受け入れ、最終候補Full/verifyが揃った場合だけとする。必須Hold、blocked、未測定、未実装をPASSへ読み替えない。

意図的に停止した補助AI機能の再有効化は完了条件にしないが、停止の拒否試験は必須。`author-value: not-measured` は技術受け入れと分離し、作者価値を実測したとは主張しない。Windows installerは既存release-only条件であり、Linux Fullから合格を推定しない。[S1][S3]

## 14. 変更箇所、共同作業、検証運用

### 14.1. 主な変更領域

| owner | 主な既存接続点 |
|---|---|
| B-close | `nir1_entity_relation_index.rs`、capacity diagnostics/fixtures/probe/manifest、既存lifecycle受け入れ台帳 |
| C | `nir1_graph.rs`、Graph Indexの限定reader、`electron/native/grimodex-node/src/related_scenes/`、既存Related Scenes UI/API |
| D1接続 | `nir1_packing.rs`、`src/features/ai-context/nir1Packing.ts`、ContextPlan/budget/cache planner |
| D2b | 既存main IPC/profileEgress、Native generation/保存入口、message/artifact保存先、対応local transport |
| E/品質 | `evals/quality-manifest.yaml`、`evals/impact-map.yaml`、既存retrieval/packing評価、Product Journey catalog |

新規ファイル名やschema番号を先に大量予約しない。接続契約で必要性が判明した最小単位を追加する。code comment/UIでいうD1 Packingと、既存契約のD1 dependency/sealed headを同一の成果物と誤読しない。

### 14.2. 並行作業

C系とD2b系の二レーンを基本とする。共有IPC型、Native入口、profile gate、schemaが必要な場合のmigration、共通transaction helperは統合担当が所有・調整する。各レーンが別々の認可/取消基盤を作らない。

実装者と候補を編集しない独立受け入れ担当を分け、最終レビューでP2以上の未解決指摘を残さない。requested model/effortとeffective metadataを別記し、取得不能はunavailableとする。名称から実効モデルや別担当実行を推測しない。

### 14.3. merge gate

focused境界試験、型/契約/必要なRust・Native・Electron検証、品質台帳とimpact traceを更新してから候補をcommitする。clean candidateでQuick→直後verify、独立受け入れ、merge前Fullをstage 1から→直後verifyを実行する。すべてのPRに既存merge gate Mを適用する。[S3]

```sh
candidate_base="$(git rev-parse 'origin/master^{commit}')"
candidate_head="$(git rev-parse 'HEAD^{commit}')"
pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"
pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"

# merge用の最終候補をfreezeし、base/headを一度解決する
full_base="$(git rev-parse 'origin/master^{commit}')"
full_head="$(git rev-parse 'HEAD^{commit}')"
pnpm ci:local:full -- --base "$full_base" --head "$full_head"
pnpm ci:local:verify -- full --base "$full_base" --head "$full_head"
```

base/head/tree/clean state/receipt directory、契約ref、評価manifest/model hash、reviewerを境界時点で記録する。各操作で同じSHAを過剰照合しない。候補変更後は旧receiptを流用しない。Full失敗を単体再実行成功でPASSへ変えず、原因を確認し、必要修正後の新候補で再実行する。

CI明示除外やcommit-onlyではその範囲を守り、merge readinessを主張しない。計画作成だけの現在の依頼では、commit/PR/CIを開始しない。

### 14.4. 文書更新

本最終計画を `docs/plans/nir1-post-b-execution-plan.md` として追加する想定とし、B-closeの文書変更で次の三正本の現在地と参照を同期する。

- `docs/plans/nir1-l6-l9-execution-plan.md`
- `docs/plans/narrative-ir-nir1-implementation-plan.md`
- `docs/plans/narrative-semantic-core-roadmap.md`

既存実行契約が契約本文と公開条件を所有し、本書は残工程の具体的な実行順序・接続・試験を所有する。重複する表は片方を参照へ寄せ、異なるAND条件を残さない。ADR/policy/確認台帳が優先される。R0、旧候補の測定、失敗run、限定受け入れの歴史は保持し、現在のCompleteとは分ける。

## 15. 最初の着手

現時点で始めるのは、(a) B-closeの残測定/必須境界の証跡整理、(b) Cの候補完全性・Scene接続・G-01成立確認、(c) Dの来歴保存先・dispatch確定順序の設計である。

B-closeと該当接続契約の完了後、C-queryとD2b-1を並行実装する。続いてC-productとhistoryを並行させ、Graph由来履歴の実接続まで受け入れた後にD2b-2-dispatchへ合流し、Eで全体完了を判定する。

## 参照資料

本書の実装指示は将来の作業計画であり、以下の資料の記録を超えて完了を主張しない。GitHub確認基点は冒頭のmaster SHA。

- [S1] `kazormia296/Grimodex` PR #600：最終body、merge状態、remaining evidence。merge `146d8535accef1c9a7621a4910dd2bf820856f87`。
- [S2] 同PR #601：shared lifecycle replacement、限定/Full受け入れと未証明範囲。parent merge `8052edc9cf256f31113f9f89a34470c7a7a194c8`。
- [S3] `docs/plans/nir1-l6-l9-execution-plan.md`：契約確認台帳、proposal/4・/5、Graph/receipt/history、G/P評価、merge gate M、PR-P履歴。確認blob `942be88a2a463e5fc24c553360ed5839bd03f7b0`。
- [S4] `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_packing.rs`：前回照合した単一Revision wrapper、authority binding、atomic group、限定資格投影。最新基点へ接続する際は再照合する。
- [S5] `evals/nir1-retrieval/manifest.json`：既存24caseの対象範囲、比較・Evidence・性能契約。G-01実行可能性の合格証拠には使用しない。
- [S6] SQLite公式 “Isolation In SQLite”：`https://www.sqlite.org/isolation.html`。
- [S7] SQLite公式 “Query Progress Callbacks”：`https://www.sqlite.org/c3ref/progress_handler.html`。
- [S8] SQLite公式 “Write-Ahead Logging”：`https://www.sqlite.org/wal.html`。
