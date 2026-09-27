# NIR-1 C-query 2 MiB 同時メモリ強制案（提案 / HOLD）

状態: **未批准・数値baseline未決のためexact-ref確認にも未準備・Graph 非公開**（2026-09-25）。`draftRef`: `nir1-c-query-memory-enforcement-proposal/1`、提案 `contractId`: `graph-query-memory-accounting/1`。既存の [C capacity gap](nir1-c-memory-capacity-delta-draft.md) と [post-B §6.2](nir1-post-b-execution-plan.md#62-資源契約) の固定値 **2,097,152 bytes / Graph結果期限8 ms** を変えない。ユーザーは「クエリ起因の同時量」を設計方向に選んだが、下記の allocator/process/IPC/lifecycle 方式や信頼境界を批准したわけではない。独立した [C-query 観測precheck](nir1-c-query-memory-diagnostic-precheck.md) と opt-in harness の結果は受入れ証拠ではなく、製品 reader を変更しない。

## 資源単位と境界（承認対象）

1. 一回の seed-local Graph query に**起因して同時に live**な Rust + SQLite allocation の合計と、同じ結果の準備・serialization・IPC・製品UI保持側の全 response copy を、request/admission から**最後の結果leaseの実解放**まで一つの **2 MiB** 予算へ課す。Nativeが結果を受理した時点では返却側の予約を戻さない。候補 SQL/JSON1 scratch、A2/A3、serde/envelope/canonical JSON、中間container capacity、Evidence、path、返却 buffer、失敗時の保持分を含む。request ID/SQL bindings の準備と query 用キャッシュの増分も課す。ヒープ requested bytesだけの観測値、inputサイズ倍率、`OutputCounter` のbyte count は強制証明にならない。悪意あるrendererが私的に無制限コピーする行為は2 MiBの製品所有範囲外だが、通常のtyped IPC・Related Scenes・click保留中の全製品所有bufferは範囲内。
2. **worker 基礎量**（Rust runtime/SQLite 初期化、読み込み済みDB page cache、登録時の構造等）は query 2 MiB に足さない代わりに、OS別の**数値付き強制上限**と開閉時実測を持つ。現時点では上限値も各OSでの強制手段も**未決**なので、exact-ref批准を求めない。Linuxだけの未保証な観測: disposable Q513/R3/D0診断processのpeak RSSは17,064 KiB、SQLite query前baselineは3,263,480 bytes、当該queryは8.248209 msでUnavailableだった（`resource.RUSAGE_CHILDREN`。Electron parentや全OSのworker baseline上界ではない）。Native側のGraph専用の既存result/cacheはbaseline扱いせず、過去のquery leaseとして計上する。起動時baselineは0 result buffer、一般Electron/Main heapはGraph query帰属外。queryで増えたchild cache/scratchをbaselineへ付け替えず、一回ごとにchildが実exitして解放する。baseline bufferのreallocやretained responseへの所有移転は増分を明示計上する。
3. 予算authorityはNativeに一つ。保守的な静的上限で**child 1,572,864 bytes（Rust+SQLite+child送信frame）＋parent/UI 524,288 bytes（Native入出力frame、serialization再コピー、typed IPC、Related Scenes保持・clickの証拠）＝2,097,152 bytes**。Nativeはquery leaseごとに二枠を排他的に予約し、準備前に枠が足りなければUnavailable。child allocator二系統が同一child枠のchecked counterを使い、parentは全process所有copyを長さ確認**前に確保枠からreserve**、freeを確証してからその枠へcreditを戻す。cross-processで未使用枠の借用・転送はしない。IPC transit中はchild frameとparent frameを二重計上し、正規のUI leaseが続く限りparent枠を保留、unmount/別query/明示releaseでは実buffer破棄と保留click結果失効を確認してから解放。rendererのrelease申告だけではcreditを戻さない。新queryは前result leaseが残り親枠に足りなければUnavailable。同時Graph query/workerは全workspaceで一件のみ。kernel所有の不可視pipe buffer、OS/RSS/allocator metadataはuser-space query帰属の2MiBには足さず、別OS上界とprocess強制baselineの受入れ対象にする。
4. 8 ms は既存契約どおり**結果期限**であり、cleanupを8 ms以内に完遂する絶対的な保証ではない。期限後の response は捨て、Native owner は実 SQL/reader/worker cleanup 完了まで責任を持つ。worker 起動や登録の待ち時間を 8 ms の外へ隠して Graph を成功扱いしない。実製品 path の入口から Graph 返却までを測定し、間に合わなければR+IRへ fallback。

## 強制の候補方式（実装方式も未承認）

一つの Native-owned read-only **隔離 worker process** を Ready/Index generation で事前登録し、**一query専用**とする。受付後のworker起動/再登録を結果期限の外へ隠さず、未準備ならUnavailable。子ではprocess初期化前にRustのrequest-aware allocatorとSQLite allocation callbackを設定し、必要なallocation owner/epoch、baseline/provenanceとlive query bytesを**同じchild枠**へ充電する。既存のprocess-global SQLite/Rust allocatorをElectron本体へ無断設定しない。SQLite JSON1/serde内部も計測・強制し、fallibleな失敗が可能なAPIはUnavailableへ、Rustのinfallible OOMは**隔離childの非成功終端**へ倒す。実allocation前のadmissionができない場合はchildを失敗/終了させ、部分Graphを親へ送らない。query-caused SQLite page cacheはworker実exitまでchild枠を消費し、次workerのbaselineには移さない。allocator metadataや二allocatorが実際にshared child枠を使う証拠、fallible OOMの可観測性、baseline capが実OSで強制できない場合はhard-boundを主張しない。

Native parent は IPC の request/response frame を独立に長さ検査し、受信前にparent枠を予約し、childに残るframeはchild枠が実free/exitするまで保持する。超過frameは読取・結果採用せずchildを閉じる。childが完了したと名乗っても parent は current workspace/epoch/Index/Source/Decision/Freshness、actual query、deadline、全frameとbound/cleanupを再検証する。返却後もNativeが結果leaseを所有し、Related Scenesの描画・click保留分はIPC/rendererと連動するleaseの対象。強制できないElectron内部のhidden copyがあればそのplatformはGraphをUnavailableのままにする。子へのDBは対象workspaceのread-only connectionだけ。Bのsealed generationとCのA2/A3/query-pathの既存権限を保持し、新しい承認DB、公開入口、persistent adjacencyは作らない。

## GDX-PRECHECK-001: actors / attacks / defenses / acceptance

| 区分 | 承認対象 |
| --- | --- |
| Trusted | Native lifecycle/Index/Graph owner、隔離 worker supervisor、既存 A2/A3/SQLite Source/Decision/Freshness reader、byte-budget/IPC validator。診断用 binary や renderer 申告は authority ではない。 |
| Untrusted | renderer の seed/query ID、改変・破損した保存JSON/Graph候補、遅延/重複/stale child response、別workspaceの同値ID、worker内部の結果status申告のみ。OS/SQLite allocator metadataを renderer 認可として使わない。 |
| In-scope | JSON1/serde/duplicate bufferの予算逸脱、malloc/realloc失敗、baselineへの query allocation 隠し、responseの二重保持、worker start/close race、同時workspace/query、取消/8ms超過でpartial Graph、panic/crash後の stale frame、Restore時の DB/Index差替え。 |
| Out-of-scope | OS管理者/ホストkernel侵害、製品全processの絶対 2 MiB RSS 制限、SQLite/C allocator自体の侵害、8 ms内の scheduler/単一opcode/ファイル I/O/kill/wait 完了保証、Graphの意味的正しさやAI送信権。 |
| Mandatory defenses | 一つの worker / 一つの活性 query、二 allocator の同一 checked budget と host IPC copy計上、有限baseline上限、length admission、exact workspace/index/current再検証、over-limit時全部拒否、cancel/deadline/stale出力破棄、実close/exitでowner退役、R+IR fallback。結果はすべての budget/authority/latency が揃うまで非公開。 |
| Positive acceptance | 最大境界内の実登録Graph query（SQLite JSON1、A2/A3、Evidence、path、実IPC response含む）が同じ request budget と期限で成功。複数fixture/次workspaceで契約値を超えず、fixed 24件/G-01評価の品質を保つ。baseline と query peakを別測定し、計上対象のcoverageを完全に示す。 |
| Negative acceptance | 2 MiBのN/N+1、JSON1/serde/SQLite/Rust/response/IPCごとの超過、realloc、worker busy、取消/期限/rollback、A→B/Restore/shutdown、親子の crash/kill/partial frame、衝突ID/expired generation を全部fail closed。戻り先のR+IRは別認可のまま。 |

## Finite owner / lifecycle（実装前に lock-order を立証）

| Entry / phase | Owner / 終端と有限性 |
| --- | --- |
| Ready/Index後の start・reopen | Native supervisor だけが exact binding/revision/Index の worker を一件確保。起動/handshakeには有限 deadline。失敗は Graph Closed; sender/renderer は workerを起動できない。cold restart は権限キャッシュを使わず新 registration。 |
| Pending request・再入 | Native は query deadline を受付時から保持。worker未準備・使用中・複数workspaceなら待機を肥大させず Graph Unavailable。別の新 owner の result と混ざらない nonce / binding を付ける。 |
| Active query | 同じ participant / read-only connection / memory budget が実 SQL・parse・serialize・IPCの終端まで所有。IO, SQLite progress, Rust 段階で cancel/deadlineを点検。workerが失敗でも部分結果を出さない。 |
| Cancel・deadline・error・window/workspace close | Native は受付停止→stop request→bounded join/kill→実process exitとpipe closeを観測。kill要求やrejected promise単独は終端証明ではない。OS unkillable/hungなら Graphを閉じてowner/予算を保持、呼出しだけ有限でR+IRへ戻す。workspace close/reopenは旧ownerの実退役まで新workerを起動しない。 |
| Return・restart・parent死亡 | Parentはfresh currentness/全frame/budgetを検証した後だけ受理し、late/stale/duplicateを捨てる。result leaseの実freeと旧child exitまではcredit再貸与なし。parentの正常終了/異常死でもchild側のpipe EOF・OS親死亡監視・有限heartbeatでself-terminateし、OSごとのjob/process group supervisorが実exitを観測。workspaceごとのOS-held worker leaseは**childがexitするまで**残し、restart後の新親は旧lease/生存を確認し、不明ならGraphをClosedにして安全な孤児workerの実exit/OS回収まで再登録しない。exit未確認でleaseファイルだけ削除・期限切れ扱いはしない。OS管理者/カーネルによる強制障害では有限UI応答のみ保証し、絶対kill時間は主張しない。 |

**観測のみ（合格ではない）:** Q513/R3/D0 の登録済みrelease readerは 8.332354 ms／別回8.248209 msで両方Unavailable。小fixtureのpublic 8 ms ignored testも最初8.028619 ms、materialized A3後8.022543 ms、relation Arc再利用後8.03993 msでUnavailableだった。長い期限では同fixtureがAvailable（8.25198／8.008784／10.447237 ms）となるため、少なくとも測定時の期限は原因の一つだが、実製品の8 ms成功や2 MiB強制の根拠ではない。閾値やGoldは変更しない。

**後続のLinux限定診断（合格ではない）:** 現C-query差分でQ513/R3/D0の全A3 SQLを終えたrelease queryは4.988316 msでUnavailable、deadline観測なし・A3評価未開始。最初のRevisionについて、合成fixtureから読んだA2は171 rows / 254,195 bytes、A3のmaterial部分だけでも85 rows / 21,397 bytes。したがってglobal A3 rowsを含めない**下界**でも既存の`8 × raw bytes + 4 KiB × rows`事前予約は3,253,312 bytesとなり、固定2,097,152 bytesを超える。これは実際の同時heap peakではなく保守的な事前見積りで、上限を緩める理由にもhard上限の証明にもならない。別の小fixtureの現候補public release 8 ms probeは1回と追加6回の計7回すべてUnavailable（8.021991–8.038124 ms）；失敗後のgenerous-deadline試行はAvailable（7.767479–10.989518 ms、別回8.45588 ms）だったが、正例の8 ms合格や安定成功率ではない。ユーザーは当面Linuxのみの検証を選択した。他OSの証拠がない限り、Graph公開とC-query mergeは停止する。SQLの速度だけをさらに直す前に、事前予約・実使用量・強制方式を別々に立証する。

**2026-09-26 Linux benign lifecycle 観測（受入れではない）:** 個別批准された [診断契約 /2](nir1-c-query-linux-resource-probe-draft.md) の data-free host smoke だけを実行した。最初の `b0ee50b1a` は、systemd の cgroup 名に含まれるリテラル backslash を拒否して unit 起動前に `BLOCK self-cgroup-invalid` で停止した。失敗は保持し、literal を unescape せず扱う修正と境界テスト、独立 Luna Max fast の再レビュー後の別候補 `b14dcd7e5` で normal/dead-owner の検査を通った。

- 実行 log: `.pi/tasks/01a0d679-b857-71da-8c7e-aebe403d5438-1687145/b14dcd7e5.output`。実行時の script SHA-256 は `c80731c154457f4d4995487a63740b706c53eb507291699b8b2cef973d8134c0`、診断契約 /2 は `f73e4cc280dc05a376abc1af4127d519de5933a31dd8b2284ec9c15a66ab2f4c`。製品候補の Quick/Full receipt ではない。
- 同一の有限 owner 実装を別 process で起動し、その実 owner を停止した後、manager の timeout/SIGKILL、実 process 回収、保持した pipe の EOF、cgroup の退役を確認した。child の 64 MiB/swap 0 と 5+115+5 秒は診断安全用で、query 2 MiB や 8 ms の代替ではない。終了後の独立 read-only 確認も owner 記録は空、該当 cgroup は 0 だった。
- 結果は **exit 2 / `incomplete`**、`benignLifecycleObserved=true`、`parentBufferBoundProved=false`、`claimsProductAcceptance=false`。親側の全同時 buffer 上限は未証明。Q513/Q2、Rust/SQLite query allocation、登録済み query の ready/continue、製品の終了・copy・OOM、他OSはこの試験で検証していない。enforcing allocator/worker 設計の批准・Graph 公開・merge の根拠にはしない。

**Linux diagnostic /3 storage observation (not acceptance):** `b86b6899b` exercised normal termination and actual benign owner death with a manager-owned `0700` runtime directory and an empty `0600` marker. Its reviewed source required applied `RuntimeDirectory`/mode/preserve/umask properties, marker existence, real service/client reaping, pipe EOF, cgroup retirement and exact directory disappearance. The run returned exit 2 / `incomplete`, `benignLifecycleObserved=true`, `parentBufferBoundProved=false`, `claimsProductAcceptance=false`; independent post-run inspection found no owner record, matching cgroup or probe runtime directory. Exact source and contract at execution are preserved under `.pi/tasks/01a0d679-b857-71da-8c7e-aebe403d5438-1687145/b86b6899b-candidate/`, bound to the sibling `b86b6899b.output` receipt. No DB, Q2/Q513 query or product worker was used. This establishes only that benign storage/lifecycle observation on this host, not the later fixed-case integration or any product resource gate.

## /3 固定ケースの実観測（受入れではない）

現候補の data-free normal/dead-owner 試験 `b9bc81c9d` は実終了・EOF・cgroup/runtime directory 回収を観測したが、親側全同時 buffer が未証明なので exit 2 / `incomplete` のまま。最初の Q2 `b45d53a7b` は STARTED 後・登録 READY 前に停止し、query 未測定だった。数値 checkpoint を追加した `b4ffa63d0` は同じ区間の `78`（copy / Graph 準備 / registration）を返した。どちらも回収済みで、原因不明の失敗を OOM や 8 ms 違反と判定しなかった。

その後、診断が `query.db` を作るのに canonical `Nir1GraphReader::open` は authority root の `grimodex.db` を開く不整合をソースで確認し、**診断側の basename だけ**を合わせた。製品 reader、fixture、512 / 100,000 / 8 ms / 2 MiB は変更していない。Luna Max Fast の限定独立レビュー `16025ded-1e31-4345-af4d-7a81af9e3023` は指摘なし、`b380d67e4` の feature-on lib/new/legacy CLI check と release build は成功。先行の checkpoint 部分も `be73321f7` で mock 試験・pure Rust 1/1・check/build が成功している。

同一の固定 source/binary で、一回ずつ次を観測した（bytes は baseline / peak / after。elapsed は f64 から変換した概数）：

| ケース / 実行 | query | elapsed | Rust requested bytes | process-global SQLite bytes | query-window cgroup bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| Q2/R1/D0-local / `b3b5493e8` | available | 4.637208 ms | 5,546 / 87,998 / 10,639 | 2,669,200 / 2,699,272 / 2,669,248 | 17,100,800 / 17,100,800 / 17,100,800 |
| Q513/R3/D0 / `bfeb2f555` | unavailable | 5.040748 ms | 5,534 / 45,586 / 5,551 | 3,272,256 / 3,730,304 / 3,272,304 | 37,433,344 / 37,433,344 / 37,433,344 |

- 両方とも registered READY、CONTINUE、完全な固定 frame、reader close、participant release、source unchanged、同一 fd の cgroup peak reset、実 service/client 回収、pipe EOF、cgroup/runtime directory 消失を確認。終了後の独立確認でも owner 記録・該当 runtime leaf・該当 cgroup は各 0。結果は依然 **exit 2 / incomplete**、`parentBufferBoundProved=false`、`claimsProductAcceptance=false`。
- Q2 の reached/failure mask は 255/0。Q513 は 191/9：A3 evaluation 未到達、work-result-error と unattributed が立ち、deadline flag は立っていない。compact frame が持つのは A3 の最初の SQL 到達だけで、今回の全 23 slot 完了や単独の拒否原因までは証明しない。Q513 の未完了 query の peak を、完成する query の容量とみなさない。
- peak − baseline は Rust 82,452 / 40,052 bytes、SQLite 30,072 / 458,048 bytes、cgroup 0 / 0 bytes。**cgroup 差分 0 は query のメモリ使用量 0 を意味しない**。各 domain の別時点の peak や差分を、帰属つき同時総量・allocation coverage・強制された 2 MiB と同一視しない。SQLite baseline が既に 2 MiB を超えることも、baseline の無断除外や新 allowance の批准には使わない。
- 64 MiB/swap 0 は引き続き診断安全用の子 process ceiling。製品 worker baseline cap の選定・他 OS の強制・query の OOM/cancel/fault・parent の 65,536 bytes・全製品 copy の解放は未証明。Q2 の一回の available は全 fixture / 全 OS / 製品入口からの 8 ms 成功を証明しない。独立 canonical oracle も別 gate のまま。
- 実行対象・build・review・各数値 receipt は `.pi/tasks/01a0d679-b857-71da-8c7e-aebe403d5438-1711320/c-query-canonical-v3-frozen-bdfoqo2f/` に保存。`snapshot.json` SHA-256 は `20db0ff13ed7e7cfd93a6b01bc1797b6a8763786064f3b2e72596926950277d4`。先行失敗は `c-query-managed-v3-frozen-jo8bfo8c/` と `c-query-checkpoints-v3-frozen-e7o4igdv/` に保存。いずれも dirty な診断候補の局所証跡で、clean PR / Quick / Full / merge の証跡ではない。

**未解決の proof obligation:** worker baselineの**数値・OSごとの強制法**（今は未決、現状exact-ref確認を求めない）、Rust/SQLite共通allocatorの全allocation coverageと安全なOOM、query-attributable lifetime tagging、全製品保持copyの実測とcredit解放、host/worker分離後も実 G-01 と統合 8 ms を満たす性能、異常時の終了証跡。どれか未立証なら Graphを閉じたままにする。修正や計測を理由に 2 MiBを増やさない。

本案はまだ**確認用の確定版ではない**。baselineの数値と実強制が確定し、脅威モデルの再レビューを通した後にだけ `graph-query-memory-accounting/1` の exact ref 確認を求める。設計方向の選択や診断の成功は批准ではなく、enforcing allocator/worker processを実装しない。

## 2026-09-27 共有割当診断と親側の限定修正（受入れではない）

個別批准済みの [共有割当診断 /1](nir1-c-query-shared-allocator-probe-draft.md) の閉じたケース集合を、同じ固定候補 `ef7b4d6ca6209f0878bf50bb3405a302ded1ebd8dbf1ee2e8bc22f16f3fef1fb` で各一回実行した。全結果は **exit 2 / incomplete**、`parentBufferBoundProved=false`、`claimsProductAcceptance=false` である。

- 先行 benign 試験と全6ケースで、実終了・保持pipe EOF・cgroup退役・runtime directory消失・owner記録の回収を確認。割当ケース100/101/102の内部検査maskは63/31/127、worker exit 0。101では共有計上要求がちょうど2,097,152 bytesとなり、追加SQLite要求を拒否。102は旧新領域の重複と失敗時保全を検査。103は実exit 90・最終frameなしであり、未観測counterを補完していない。
- Q2はavailable / 約4.767810 ms / 共有計上high-water 137,616 bytes。Q513はunavailable / 約5.653989 ms / 同502,233 bytes。Q513のreached/failure maskは191/9で、A3評価前のwork error + unattributed。記録から単独原因を新たに推定しない。
- 計上対象はepoch後にhookを通るraw Layout要求と制御領域である。物理メモリ、pre-epoch SQLite領域の再利用、全結果copy、他OSの上限証明ではない。Graph後の224 bytesはframe生成前の名前付きsnapshotであり、最終zeroや全lifetime peakではない。
- 最終receipt境界の候補照合と個別report整合確認、および独立Luna Max Fast監査 `a3783139` は記録の過大主張なしを確認した。これはdirtyな診断候補の証拠であり、clean PR / Quick / Fullのreceiptではない。

続くsource調査で、CPython 3.14.7の`Popen`既定bufferが1本131,072 bytes（純粋なin-memory BufferedReader/Writerのobject sizeは各131,240 bytes）であり、`pipesize=4096`ではそのPython側bufferを制限できないことを確認した。controllerの2か所を`bufsize=0`へ変更した。既存I/Oは`os.read`/`os.write`なので、不要なwrapper bufferだけを除く。2つのmock回帰assertionは修正前に失敗、修正後はoffline self-test・AST・diff checkが成功し、独立Luna Max Fast `4daf4f85` は限定差分に指摘なしだった。**この修正で候補は再開され、旧runtime receiptは新controllerの受入れ証拠ではない。この限定修正単体ではhost試験を実施せず、後述のschema 5候補で改めてbenign回収を確認した。**

全体の65,536-byte同時上界は、parser/dict、bytearray capacity、例外traceback、JSON/stdout等まで未証明のまま。canonical経路のsource mapではSQLite lookaside slot、page-cache hit/recycle、file-backed WALの`osMmap`というhookを通らない経路も具体化した。どの分岐を今回のfixtureが何bytes使用したかの実測ではなく、`mmap_size=0`をWAL全mappingの禁止とみなさない。`OutputCounter`もGraphのencoded bufferを作らずbyteを数えて捨てるので、数値telemetryを実Graph IPC copyの証明にしない。

詳細はローカルtask evidenceの`c-query-allocator-draft-vFlDqG/shared-probe-observations-r1.md`、`coverage-map-and-parent-bound-r2.md`、個別log、候補binding、回帰red/green、reviewに保存。限定診断の問いは閉じたが、C-query全体の必須資源契約は未完了。製品用の全allocation/lifetime強制方式・baseline/splitの批准、他の出荷OS、最終候補のQuick/Full・Astra Max最終レビュー・mergeは未了であり、GraphとmergeのHOLDを維持する。

## 2026-09-27 SQLite登録時の内訳（schema 5、受入れではない）

既存のMEMSTATUS baseline 2,669,200 bytes（約2.55 MiB）の内訳を調べるため、承認済み診断のmanaged経路だけに、authorityと専用readerの`SQLITE_DBSTATUS_CACHE_USED`／`SCHEMA_USED`／`STMT_USED`を追加した。登録後・READY/epoch前に`reset=0`で読む6個の概数であり、queryの計時区間、旧observerのJSON、canonical algorithm、cache設定、allocator、固定閾値は変更していない。schema 5のencoder/parserは各値を非負signed-int範囲、frameを4,096 bytes以内に制限する。

- `bf1b5c2b0`で接続別DBSTATUSテスト1/1、既存helper/encoder 18/18、新旧CLIと通常libraryのcheck、release buildが成功。未使用コード警告あり。parserの範囲guardは追加前の負例失敗と追加後のoffline self-test成功を確認した。独立Luna Max Fast `1456cdf0`は指摘なし（requested/effective modelとFast拡張を確認、請求tierの証明ではない）。
- 固定した診断候補`cc5488ead4a244501a51d5ad30f5af97161b063161e7552a374c3d60c3321047`で、benign normal／実owner死亡・回収`bf3c31e35`の後に、Q2/R1/D0-local `b97e8f0fc`だけを一回実行した。Q2は**available／約4.923010 ms**、共有raw要求計上high-water **137,616 bytes**。これは全allocation・全copy・物理2 MiBや正式な8 ms受入れを証明しない。

| 登録後・READY前の接続 | cache bytes概数 | schema bytes概数 | statement bytes概数 |
| --- | ---: | ---: | ---: |
| authority | 201,488 | 985,616 | 0 |
| 専用reader | 514,832 | 826,176 | 0 |

両接続とも、この観測のschema概数はcache概数より大きく、単にpage cacheだけがbaselineを支配すると仮定できない。**これらの値は加算可能な完全内訳ではない**。process-global MEMSTATUS baselineは2,669,200 bytes、別の共有raw baselineは3,997,563 bytesであり、差分や和をquery帰属量・未計上量・新しいbaseline allowanceとして採用しない。`memsys5`単体もRust接続、非arena領域、全lifetimeを解決せず、独立調査`8e99912c`の結果を製品設計の批准に置き換えない。

両実行は**exit 2／incomplete**。Q2の実worker exitは0で、完全frame、実終了、EOF、cgroup退役、runtime directory消失、owner記録回収を確認した。終了後のowner/runtime残留は0、parent reportは改行込み2,838 bytes。最終receipt境界で25個のsource/binary/contractとreviewが固定時から不変、reportのschemaが整合することを確認した。これは65,536-byte親側同時量の証明ではなく、`parentBufferBoundProved=false`／`claimsProductAcceptance=false`を維持する。今回Q513や割当ケースの再試験は行っていない。

証跡は同じローカルtask evidenceの`sqlite-breakdown-candidate-r1.json`、`sqlite-breakdown-receipt-check-r1.json`、`sqlite-breakdown-r1.patch`、`sqlite-breakdown-review-1456cdf0.md`と各実行logに保存。dirty診断候補の観測であり、他OS・Graph公開・Quick/Full・mergeの証拠ではない。

## 親側bufferの追加修正と終端確認（受入れではない）

CPython 3.14.7の標準入力・出力・エラーにも各131,240-byteのbuffer objectが残っていた。`-u`だけでは標準入力が残るため、診断の`main`開始時に既存fdを閉じずにbuffer wrapperをdetachし、text設定を保持したwrite-throughの`FileIO`へ接続し直す。両方の`sys` aliasを更新し、不正wrapper／fdはowner起動前に拒否する。修正前の回帰失敗、通常／`-u`のoffline成功、各raw object 64 bytesを確認した。これは起動時peakやPython全体のmemory証明ではない。

また、空／marker 1件の検査前に`os.listdir`が全ファイル名を確保していたため、既存の`scandir`パターンで最大1／2件だけを調べる共通helperへ置き換えた。error code、権限・inode等の既存検査、marker open flags、fd解放、manager policyは維持した。bulk listingを拒む修正前の失敗、7個のmock shapeケースを含むoffline成功、AST／diff check、現CPythonでiterator早期close後にfd cursorが0へ戻るread-only確認を実施した。libcのDIR scratch容量まで証明したものではない。

Luna Max Fastの候補未編集レビュー`74fafb44`／`d3181986`は両差分に指摘なし。requested/effective modelとFast拡張を確認済み（請求tierの証明ではない）。後者は調べたframe／parse／report経路に入力件数で無制限に増えるcollectionを見つけなかったが、**retained frame、parser dict、`report.update`、長さ検査前の`json.dumps`が重なる同時量は未証明**とした。個別上限や別々のpeakを合計して合格にしない。

累積修正を固定した`eba8a9bdb8c8a32040400f281b17ed377a1697ea92e3c12ded2cdce09f23751d`で、data-free benign normal／実owner死亡だけを`bdd65263c`により一回確認した。実終了・EOF・cgroup退役・runtime directory消失を観測し、終了後のowner／runtime残留は0。最終receipt境界で25個のsource／binary／contract、review、branch／HEADの不変を確認した。Q2／Q513／allocatorケースは再実行していない。結果は**exit 2／incomplete**、`parentBufferBoundProved=false`、`claimsProductAcceptance=false`のままである。証跡は`parent-buffer-candidate-r1.json`、`parent-buffer-receipt-check-r1.json`、`parent-stdio-r1.*`、`parent-directory-r1.*`と各review／logに保存した。

別のsource調査`876d5d3b`では、Graph reader自身がauthorityのArcとleaseを保持するため、局所cloneをdropしてもauthority DBは解放されず、既存APIに安全なconnection単独解放経路がないことを確認した。`shrink_memory`はpagerを対象としschemaを解放しない。ここからauthority寿命の変更やcache実験へ進めず、全allocation／copyの強制方式、親側同時量、他OS、Graph／mergeのHOLDを維持する。
