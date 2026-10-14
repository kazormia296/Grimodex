# CP-2a 判断記録（C-query の製品 owner）

作成：2026-10-13（advisor、read-only）。対象 TASK：同じ directory の `cp2a-task.md`。
位置づけ：U3 委任の技術判断（worker／owner／終了処理／lifecycle）。確認済みの契約（K1 = `nir1-l6-l9-contract-proposal/6` の `graph-limited-binding` と `nir1-defensive-resource-limits`）と DSN（`claude-nir1-contracts/docs/plans/nir1-dsn-2026-10.md`、再レビュー待ちの設計案）を入力にする。本書は契約の確認や変更ではない。
読んだ根拠：DSN §1・§3・§8・§9、計画（`~/.claude/plans/610-pr-c-query-nir-valiant-thunder.md`）の Wave 2 CP-2a 行と実行方式（U7 の変更を含む）、worktree `claude-nir1-cp2a`（HEAD `31dfe988`）のコード、PR #634（DT-1）・#642（DT-2）・#641（CP-1）・#636（CR-1）、CP-1 の decisions（`claude-nir1-cp1/.ralph/agent/decisions.md`）、資源契約 proposal/6。
行番号は worktree `claude-nir1-cp2a` の HEAD `31dfe988` のもの（DSN は `a153743b` の行番号なので、ずれている箇所がある）。

## 0. 結論の要約

- DSN §1 の設計で、委任外の6項目に当たるものはない。status は ready。
- DSN と違えた点・足した点は8つ（CP2a-D3、D4、D7、D8、D10、D11、D13、D16。§2 の表）。どれも「より厳しい」か「後のレーンへ回す」方向で、閾値の緩和、公開、送信先の追加、保存の拡大、認可の削除、新しい authority を含まない。integrator は DSN §1 をこれに追随させる（DSN §1.10 の規則）。
- 実装の難所は owner thread の状態機械（CP2a-D2、D6、D19）。実装者は Haiku の予定だが、試験 N11（seam）か N16／N17（quarantine）で2回直しても通らなければ Sonnet に上げることを勧める（memory の subagent 方針の「ダメなら一段上げる」）。

## 1. 判断の一覧

| ID | 判断 | 信頼境界 | 代替案と不採用の理由 | 結論（確度、DSN との関係） |
|---|---|---|---|---|
| CP2a-D1 | 製品 owner を grimodex-node の新 module `nir1_graph_product.rs`（試験は `nir1_graph_product_tests.rs`）に置き、AppState の field `nir1_graph` が1つ所有する。lib.rs は mod 行、shutdown、Restore、Open の4か所（10行以内）、state.rs は field と構築の3行。`Disabled` は slot に持たず、begin の検査（公開 gate、D2a、worker、observer 登録）で毎回計算する | owner は Native の中に閉じる。renderer・Main・N-API から到達できない | grimodex-db に owner を置く案：AppState・profile・lifecycle view が Native 側にあり、DSN §1.2 とも違う。`Disabled` を slot に保存する案：gate の状態と二重管理になり、食い違いの余地が出る | 採用（高）。DSN §1.2 のとおり。`Disabled` の計算化は実装上の細部 |
| CP2a-D2 | 需要ごとの session に owner thread を1本使う（名前 `nir1-graph-owner`）。prepare と query は必ず同じ thread で行い（F9）、worker は `GraphWorker` trait の背後で thread の外へ出ない。query 後の作り直しと別 key への rekey は同じ thread が続ける。thread は idle、edge、終了、失敗で抜ける | worker・lease・participant は owner thread の stack の中だけ | tokio の blocking task で行う案：F9 で reader の wake を失う（DSN D-01）。常駐 thread を1本持つ案：idle の間も thread と状態が残り、需要駆動（DSN D-02）と合わない。trait を置かない案：fake で seam・BUSY・quarantine を決定的に試せず、実 worker の fixture（grimodex-db の内部 API で作る Q2）が grimodex-node から作れない | 採用（高）。DSN D-01 に従う |
| CP2a-D3 | 公開 gate は `const PRODUCT_GRAPH_PUBLISHED: bool = false` と `#[cfg(test)]` の override だけ。worker の path を Main から受け取る配線（Backend constructor の引数追加と Main の解決）は CP-2b／PUB-G に回し、CP-2a は検証関数 `ProcessGraphWorkerFactory::from_path` と `configure_worker_path` だけを置く（製品から呼ばない） | renderer や env から path を受け取らない。PUB-G まで、どの入口からも spawn しない（A-1） | DSN §1.2 のとおり AppState 構築時に path を渡す案：Backend constructor（JS から呼ぶ）と Main（electron/main）を変えることになり、worker も同梱されていない（CP-2b）ので、PUB-G の前には使い道がない。変更面が hotspot に広がる | 採用（高）。**DSN からの差：path の配線の時期**（CP-2b／PUB-G へ） |
| CP2a-D4 | 鮮度の stamp は S0（prepare 前）も S1（query の受付時）も wait 0（`try_lock` だけ。foreground の待機者や maintenance の finalization 予約があれば読まない）。両方そろって値が違えば query を投げずに `stale` にして作り直す。**どちらかが取れなければ事前判定を省いて query を投げる**（worker の registration-drift が最終判定で、`stale` に写す） | stamp は「query を投げるか」の判断にだけ使う。認可、資格、採否には使わない（DSN D-03 と同じ） | DSN §1.3／§1.4 の案（S1 が取れなければ `busy` で query を投げない、S0 は 100 ms 待ち、取れなければ `warming` のまま再試行）：Graph の begin は Raw と IR の読取と同時に起きるので、S1 の `try_lock` は構造的に取り合いやすく、`busy` が増えて可用性を落とす。一方、worker 自身の registration-drift 検査があるので、事前判定を省いても誤った結果は返らない（DSN §1.4 自身の論拠）。S0 を 0 にするのは DSN の 100 ms より厳しく、新しい待ちの上限を作らない（K1b 規則 6） | 採用（中）。**DSN からの差：stamp が取れないときの扱いと S0 の待ち**。S2 で `stamp_unavailable`／`drift_at_query` の率を見て再検討する |
| CP2a-D5 | S0 は prepare に渡す snapshot の DB で、S1 は query の時点で `active_database` から取り直した DB（`identity()` が key の `authority_instance` と一致するときだけ）で読む。owner thread は READY の後に authority を持ち続けない | worker の READY owner が authority を手放す既存の設計（`release_authority_after_ready`）を崩さない | READY の間 authority の Arc を持つ案：quarantine の経路（`DetachedCQueryOwner` は authority を持たない設計）と食い違い、W2 への切替で旧 DB を開いたままにしうる | 採用（高） |
| CP2a-D6 | seam observer（`GraphEdgeObserver`）は edge ごとに `edge_epoch` を進め、ReadyPublished なら `ready_generation`、ShutdownRequested なら `closed` を立て、短い slot lock の中で `try_send(Wake)` するだけ。退役は owner thread が行う。lock の順序は Core → slot で、slot を持ったまま Core・DB・子 process・join・sleep・blocking な channel 操作をしない（`try_send` と thread の spawn だけ可） | observer は Core の mutex の中で呼ばれる。Core を呼び返さない、block しない、panic しない（seam の契約） | DSN §1.10 の「atomic と try_send と unpark だけ」を文字どおり守り、slot の lock も取らない案：wake の送り先（session の sender）を見つけるのに別の lock か lock-free の仕組みが要る。slot の lock は O(1) の区間しか持たないので、DT-1 の gate が自分の mutex を取るのと同じ程度の待ちに収まる。adapter 段で通知する案：Core を直接呼ぶ経路を取りこぼす（DSN D-04、DT-1 D1） | 採用（高）。DSN の意図（block しない、退役は owner thread）どおりで、slot の短い lock は実装上の細部として記録する |
| CP2a-D7 | どの edge（TransitionAdmitted、ReadyPublished、Unavailable、ShutdownRequested、将来の未知の edge）でも epoch を進めて READY を退役させる。どの edge でも pre-warm しない。ReadyPublished は Suspended も解く | edge の後に古い binding の worker を使わない | DSN §1.4／§1.10 の案（ReadyPublished は key と stamp の更新と cache の破棄だけ）：Ready の公開は transition の後か、RecoveryRequired などからの復帰で、どちらも binding が変わるので READY の worker は使えない。退役しても失うものがなく、規則が1つで済む | 採用（高）。**DSN からの差：ReadyPublished でも退役**（より保守的） |
| CP2a-D8 | worker の失敗の分類は grimodex-db の `classify_c_query_failure`（閉じた enum `CQueryFailure`）に置き、marker の文字列は cqw.rs の中だけで扱う。製品の理由への写像は prepare と query で分ける（TASK §3.2.6）。startup の registration 拒否は `registration-unavailable` で、失敗として backoff に数える。frame 全体が `FRAME_BYTES` を超えた場合（CP-1 の申し送り 4）は worker が frame なしで終わるので `failed` とし、worker と frame は変えない。連続5回で Suspended にし、次の Ready edge か `resume_after_graph_index_change()`（B-ROUTE／CP-3a が B の publish に結ぶ hook）で解く | 理由は DSN §1.5 の14個の閉じた集合。private な文言を外へ出さない | grimodex-node で文字列を照合する案：marker が二つの crate に分散し、改名で黙って崩れる。frame 超過を `limit` にする案：worker の encode の失敗を frame の reason にする変更が要り、bin と reason の allowlist（C-resource の受入れ範囲）に触れる。Suspended を Ready edge だけで解く案（DSN）：B の build 待ちで5回失敗すると、build が終わっても workspace を開き直すまで Graph が戻らない | 採用（中）。Suspended の解除 hook は DSN への追加（緩和ではない。解除の後も backoff と5回の上限は同じ） |
| CP2a-D9 | cqw.rs に `CQueryRetirement`（Retired／Holding／Quarantined）、`retirement()`、`retire(self)`、`query_projected`（lease を持ったまま frame を所有 DTO に投影し、lease を drop してから DTO を返す）を足す。DTO は新 module `worker_projection.rs` の `Nir1GraphProjection`（中身は in-process reader と同じ `Nir1QualifiedGraph`）。件数は allocation の前に検査する。owner thread は `retire()` の結果を見てから DTO を ticket に渡す | lease と `FrameView` は grimodex-db の関数の中で終わり、N-API・tokio・ticket へ渡らない（F8） | 投影を grimodex-node に置く案：frame の試験 fixture（`sample_response`）が grimodex-db の試験 module にあり、往復の試験（encode → validate → 投影 → encode の一致）を書けない。DTO を新しい型にする案：CP-3a が in-process reader と同じ JSON 形を使えなくなる。DTO を lease drop の前に渡す案：DSN §1.8／§1.9（DTO の時点で reap 済み）に反する | 採用（高）。DSN §1.8 のとおり |
| CP2a-D10 | 次 query 用 cache は単一 entry、TTL 30 s、1回使ったら消す。key は（exact `LiveBinding`、D2a の caller epoch、project、query scene、seed）。Scene の source／scope token、incarnation、B の seal は key に入れず、cache から返す DTO も **CP-3a が DSN §2.3 の再検証を通してから使う**ことを必須にする。edge と caller epoch の不一致、TTL で使えなくなり、quarantine で空にする。process-local で永続化しない | cache は authority ではない。返却時と click 時の再検証が唯一の採否 | DSN §3.3 の key（token と seal を含む）：begin の時点でそれらを知るには DB を読む必要があり、begin の wait 0 と合わない。どのみち再検証で同じ値を照合するので、安全性は同じ。cache を置かない案：遅れて届いた結果を捨てることになり、post-B §7.2「次 query で使う」に反する（S2 で新しい READY の率が十分高ければ省く余地は DSN のとおり残る） | 採用（中）。**DSN からの差：key の構成**（照合は再検証へ移す） |
| CP2a-D11 | ticket は消費しない wait（`poll`／`wait_timeout`／`waiter`）と、1回だけの `finish(Used／Unused／Cancelled)` を持つ。Drop は Cancelled。Unused の後に届いた（か既に届いていた）Available だけを cache に入れ、通知 hook を呼ぶ。通知 hook（`related-scenes:graph-ready` 相当）は Native の関数として置くだけで、EventQueue への発行と D2a の event allowlist の追加は CP-3a／K3 に回す | renderer は ticket の使い方しか申告できない。「Unused」と偽っても、cache は単一 entry で再検証が必須なので害がない。「Used」と偽っても cache に入らないだけ | wait で outcome を消費する案：renderer が締切に間に合わなかった結果を Native はもう持っておらず、cache に入らない。CP-2a で event を発行する案：renderer への新しい通知経路になり、K3 の allowlist（未確認）と CP-3a の配線を先取りする | 採用（高）。**DSN からの差：event の発行を CP-3a へ**（新しい送信先を作らないため） |
| CP2a-D12 | quarantine は slot の `Quarantined{binding}` で process 寿命。以後 spawn しない、begin は `restart-required`、cache を空にする。W1（現在の Ready binding が quarantine の binding と locator・workspace_id・物理 DB のどれかで一致）の Restore は lib.rs の入口で `reasonCode: "nir1-graph-restart-required"` の not-admitted にする。Open は Core がすでに `active-operation` で拒否したときだけ、対象が quarantine と衝突していれば reasonCode を同じ値に付け替える。shutdown は `close_for_shutdown()` を足すだけで、fence や participant を解放しない（終端は Main の既存の `exit(1)`） | Core の規則は変えない。拒否を足すだけで、外さない。reasonCode は既存の文字列 field の値で、新しい型ではない | Core で Restore を拒否する案：Core の規則と grimodex-db の試験（wl.rs）を変えることになる。Open の拒否を CP-2a で自前に判定する案：Core と判定が二重になる。reasonCode を DSN の例 `NIR1_GRAPH_QUARANTINE_RESTART_REQUIRED` にする案：既存の reasonCode が kebab-case（`maintenance-admission-closed` など）なので合わせた | 採用（中）。DSN D-05 のとおり。PUB-G の前の製品では quarantine が起きない（owner が有効にならない）ので、この分岐は試験からしか到達しない |
| CP2a-D13 | 子 process は `env_clear()` の後に、Windows だけ `SystemRoot`（絶対 path のとき）を親から写し、`CREATE_NO_WINDOW` を付ける。cwd は worker 実行体の親 directory。worker と workspace の path は絶対 path だけ受け付ける。`env_clear` は試験用の `command.env(...)` より前に呼ぶ。Linux の `/proc/<pid>/environ` と `/proc/<pid>/cwd` の試験（D5）を lifecycle lane に足す。**Windows／macOS の env 名の数を test-seam で stderr に出す確認は CP-2b の packaged smoke へ回す** | 子へ渡す情報を argv（workspace path と project ID）だけにする。資格情報、proxy、`LD_PRELOAD`／`DYLD_*`、`NODE_OPTIONS` を継承しない | env を継承する案：DSN D-06 のとおり不採用。Windows／macOS の確認を CP-2a で行う案：worker 実行体（C-resource の受入れ対象）の test-seam と新しい opt-in mode が要る。`env_clear` は std の規定どおりの動作で、OS 依存は `SystemRoot` だけ。3-OS の既定 lane で全 OS が READY に届くことは確かめられ、Windows の console window の確認も DSN 自身が CP-2b に置いている | 採用（高）。**DSN からの差：Windows／macOS の env 名数の確認時期**（CP-2b へ） |
| CP2a-D14 | 新しい数値は DSN の初期案のまま：idle 上限 120 s、作り直しの最短間隔 1 s、backoff 2 s から倍々で上限 60 s、連続5回で Suspended、cache の TTL 30 s。stamp の待ちは 0。境界は純関数（U1〜U4）で N と N+1 を試し、thread の試験は短い試験用 config で行う | 資源契約 proposal/6 の `nir1-defensive-resource-limits`（2026-10-12 確認）の規則 1〜8 の下の新しい防御上限。確定値は変えない | 数値を S2 の実測まで決めない案：CP-2a が merge できず、CP-3a が止まる。規則 5 は「merge の前は実測に合わせて調整してよい」としているので、初期案で実装し、D6 の prepare と query→DTO の実測と S2 の結果で integrator が merge の前に選び直して PR に記録する | 採用（中）。**K1b の記録が必要**（値、単位、検査位置、超過時の結果、実測の条件） |
| CP2a-D15 | 試験は二層にする。製品 owner の状態機械は fake worker を使う grimodex-node の通常の試験（hosted の native 試験で走る）。実 worker が要るもの（env／cwd、DTO の時点の reap）は grimodex-db の ignored 試験として既存の Q2 fixture を使い、`scripts/nir1-c-query-worker-ci.sh` の lifecycle mode に足す（dataset の sha を同じ commit で更新）。grimodex-node から実 worker を使う end-to-end は CP-2a では作らない | fake は実 worker の挙動（binding 失効で prepare と query が失敗する、quarantine の fence と participant の2経路）を公開 API で再現する。fence の経路だけは試験専用の関数（CP2a-D17）を使う | grimodex-node の実 worker 試験を lane に足す案：C-query の job には native の build 依存（apt、pnpm、ORT の cache）がなく、ci.yml の変更が要る。Q2 fixture の準備（Scope、Freshness、typed writer、Human Decision、B の publish）は grimodex-db の内部 API なので、grimodex-node からは作れない。製品の packaged worker での確認は CP-2b の smoke が担う | 採用（中）。実 worker と製品 owner の組合せの end-to-end は CP-2b と CP-4 で補う（未解決事項に記録） |
| CP2a-D16 | renderer の合流 helper `awaitNir1RelatedScenesWithGraph` を CP-2a で純関数として作り、配線しない（既存の `awaitNir1RelatedScenes` と seed のない経路は変えない）。IR の outcome は IR の到着時刻で決め、最終公開は「開始した成分がそろった時」か「Raw-ready＋D」の早い方。締切を延ばさない。遅れて届いた Graph はその query に混ぜず、ticket を Unused にして Native の cache へ回す。**Graph を使うのは IR が ir-ready のときだけ**（IR が timeout・失敗・unavailable なら Graph は使わず、Chronicle の停止なら Graph を Cancelled にして exact R） | helper は採否を決めない。Graph の融合（path の付加と追加1枠）は CB-4 の資格判定と再検証を経て CP-3a が行う | 既存 helper を延長する案：IR が窓の内側に届いていても timeout に数えてしまう（DSN D-10）。helper を CP-3a で作る案：CP-2a 行の「同じ deadline で合流させる」を満たせず、CP-3a の変更が大きくなる。IR が timeout でも Graph を使う案：DSN §3.1 の「Chronicle が止まったら exact R」との境界が曖昧になり、R+Graph という評価にない組合せが生まれる | 採用（中）。DSN D-10 のとおり。**DSN への追加：IR が ir-ready でないときは Graph を使わない**（保守側） |
| CP2a-D17 | fence の経路の試験のために、grimodex-db `state.rs` に `leak_c_query_quarantine_fence_for_test(snapshot)` を置く。`#[cfg(any(test, feature = "workspace-maintenance-test-support"))]`、`#[doc(hidden)]`。feature は既存で、grimodex-node の dev-dependency が有効にしている | 製品の build には入らない（feature は試験の build だけ）。Cargo.toml を変えない（dataset に束縛されている） | 新しい feature を作る案：grimodex-db と grimodex-node の Cargo.toml（dataset の source）を変えることになる。fence の経路を試さない案：DSN §1.9 の「fence に移せた経路」の shutdown 試験ができない | 採用（高） |
| CP2a-D18 | query の結果が正しく lease を通った（完全な frame、terminal commit、EOF、binding）後で、lease の drop の cleanup が証明できず quarantine になった場合、その DTO はそのまま ticket に渡し、slot は Quarantined にする | 結果の妥当性は lease の条件で決まり、子 process の reap は退役の問題（post-B §6.2「post-commit の異常は受理済みの結果を自動で失効させない」） | DTO も捨てて `restart-required` にする案：結果の妥当性と無関係な理由で捨てることになる。どちらでも CP-3a の再検証は必須 | 採用（中） |
| CP2a-D19 | panic の安全：thread の本体を `catch_unwind` で包み、`SessionGuard` の Drop が（1）解決していない ticket を `failed` で解決、（2）worker の `quarantined()` を見てから `retire()`、（3）自分の thread_id の session のときだけ slot を Empty／Suspended／Quarantined／Closed にする | 異常時も worker を退役させ、待っている呼出し側を有限時間で解放する（DSN §1.3 error 行） | panic を検出したら一律に Quarantined にする案：退役が証明できた場合まで process 寿命の停止にしてしまう | 採用（高） |
| CP2a-D20 | begin は wait 0：入力の検査（seed が空なら `not-requested`、request が 8,192 B を超えるなら `limit`）、公開 gate、D2a、worker の有無、Core の Ready binding、cache、slot の遷移だけを行い、DB や子 process や join を待たない。終わった owner thread の JoinHandle は `is_finished()` のときだけ join する | request の上限 8,192 B は既存の確定値で変えない | begin で stamp を読む案：DB の mutex を取ることになる。begin で終わった thread を必ず join する案：終わりかけの thread を待つことになる | 採用（高） |
| CP2a-D21 | 診断は AtomicU64 の counter だけ（文字列、path、binding、ID を持たない）。`stamp_fresh`／`stamp_stale`／`stamp_unavailable`／`drift_at_query`（F10 の影響）、`scene_total_over_cap` と `query_scene_associated`（CP-1 の申し送り：8件の打ち切りと query Scene 自身の pin の率）、`retired_idle`／`retired_edge`、`quarantines`、`late_cached`、`panics` など。N-API や event には出さない。ticket は `resolved_after()` を持つ | post-B §4.4（診断は allowlist、本文や private な値を出さない） | 診断を event で出す案：新しい送信経路になる | 採用（高）。D の窓への到達率そのものの実測は S2／CP-4（K6） |
| CP2a-D22 | 製品 owner の試験は時間の厳しい assert をせず、`wait_until(条件, 5 s)` で書く。wait 0 の確認は「待たせる条件（DB mutex の保持、prepare の停止）の下でも 1 s 以内に返る」で示す | — | ms 単位の assert：負荷で不安定になる | 採用（高） |

## 2. DSN との差分（integrator が DSN §1 を追随させる対象）

| DSN の箇所 | DSN の記述 | CP-2a | 判断 |
|---|---|---|---|
| §1.2 worker の path | AppState 構築時に Main が絶対 path を渡す | 検証関数だけ置き、配線は CP-2b／PUB-G | CP2a-D3 |
| §1.3 bounded wait、§1.4 鮮度 | S1 は wait 0 で取れなければ `busy`、S0 は 100 ms 待ち、取れなければ `warming` で再試行 | S0・S1 とも wait 0。取れなければ query を投げて worker の drift 検査に任せる | CP2a-D4 |
| §1.4、§1.10 edge の使い方 | ReadyPublished は key・stamp の更新と cache の破棄 | ReadyPublished でも退役（Suspended の解除も） | CP2a-D7 |
| §1.4 rate 上限 | 上限回数で次の Ready edge まで停止 | 加えて `resume_after_graph_index_change()` で解ける | CP2a-D8 |
| §1.7 試験 | Windows／macOS は test-seam で env 名の数を stderr に出す | CP-2b の packaged smoke へ | CP2a-D13 |
| §3.3 cache の key | token、incarnation、B の seal を含む | 5項目。残りは必須の再検証で照合 | CP2a-D10 |
| §3.4 graph-ready | Native が event を出す | Native の通知 hook だけ。発行は CP-3a（allowlist は K3） | CP2a-D11 |
| §3.2 合流 helper | （IR が timeout のときの Graph の扱いは書いていない） | IR が ir-ready のときだけ Graph を使う | CP2a-D16 |

## 3. 委任外の6項目の点検

| 項目 | 点検の結果 |
|---|---|
| 新しい送信先 | なし。event・IPC・N-API・ネットワークを足さない。worker の子 process への入力は既存の argv だけで、env は減る |
| 保存範囲の拡大 | なし。DB と file に書かない。cache は process-local の memory で、TTL 30 s の単一 entry |
| 閾値の緩和 | なし。Revision 512 records／6,291,456 B、per-Revision preflight 2,097,152 B、read／admission 512、16x32、100,000 steps、100 ms lease、wait 0、2hop／12／144／8、request 8,192 B、`FRAME_BYTES`、`MAX_SCENE_SECTION_BYTES`、startup 30 s、cleanup 500 ms は不変。新しい数値は K1b の規則の下の新しい防御上限で、stamp の待ちは DSN の初期案より厳しい 0 |
| 製品の公開 | なし。`PRODUCT_GRAPH_PUBLISHED = false`、`#[napi]`・ipcContract・preload・Main・Backend constructor・electron-builder.yml を変えない。合流 helper は配線しない |
| 認可の削除 | なし。Core の quarantine 規則、D2a の検査、binding の再確認は変えない。Restore と Open に拒否を足すだけ |
| 新しい契約や authority | なし。stamp と cache は採否に使わず、cache hit も CP-3a の再検証が必須。reasonCode の新しい値は既存の文字列 field の値 |

DSN のとおりに作ると委任外に当たる点：なし。ただし DSN §1.2 の path 配線（Backend constructor と Main の変更）と §3.4 の event の発行は、CP-2a で行うと「製品入口は閉じたまま」「新しい送信先を作らない」の境界に近づくので、後のレーンへ回した（CP2a-D3、D11）。

## 4. integrator への申し送り

1. DSN §1 を §2 の差分に追随させる（DSN §1.10 の規則）。DSN は再レビュー待ちなので、差分も同じレビューに含める。
2. K1b（規則 5）の記録：CP2a-D14 の数値、単位、検査位置、超過時の結果と、D6 の `eprintln!`（prepare と query→DTO の時間）を PR 本文と作業記録に残す。S2 の結果で merge の前に選び直してよい。merge の後に緩める変更は再確認が要る。
3. lane：cqw.rs（worker owner）を変えるので、最終 head で opt-in の5 lane と lifecycle lane を dispatch する（G5）。lifecycle は 14 → 16 件。`scripts/nir1-c-query-worker-ci.sh` を変えるので dataset の sha の更新を rebase 後の最終 commit で確かめる。
4. CP-3a への条件（TASK §1.2 と §3.2.7）：`GraphTicket` は1回だけ `finish` する（Drop は Cancelled）。`GraphBegin::Cached` と `Available` の DTO は DSN §2.3 の再検証を通してから使う。通知 hook を EventQueue に結ぶときは K3 の allowlist を待つ。合流 helper の `onGraphSettled` を ticket の `finish` に結ぶ。
5. CP-2b／PUB-G への条件：`configure_worker_path` を Main からの絶対 path で呼ぶ配線、`PRODUCT_GRAPH_PUBLISHED` の切替、Windows／macOS の env 名数と console window の確認。
6. B-ROUTE への条件：B の publish が完了したら `resume_after_graph_index_change()` を呼ぶと、registration の拒否で Suspended になった slot が戻る（呼ばなくても次の Ready edge で戻る）。

## 5. 未解決事項

- 実 worker と製品 owner を組み合わせた end-to-end（pre-warm から D の窓への到達まで）は CP-2a の試験にない。S2 の計測、CP-2b の packaged smoke、CP-4 で補う。
- 編集中は commit が続くため READY が古くなりやすい（F10）。`stamp_stale`／`drift_at_query`／`stamp_unavailable` の率を S2 で測る。率が高い場合の選択肢（DSN §3.5 の分岐、U2 の任意の高速化）は CP-2a の外。
- registration の拒否（B の seal が未完了か、registration 中の commit）が5回続くと Suspended になる。編集中にどのくらい起きるかは S2 の (d)（write 負荷の下での prepare 失敗率）で測る。
- quarantine 中の未保存の編集の扱いと、restart-required の UI は K3／CP-3b で決める（DSN §1.6 の 5）。
- D-final と Related Scenes が slot を取り合う場合の優先度は DI-1a で決める（DSN §9）。
- DSN の判断 D-01〜D-18 の advisor の結論は DSN の再レビューで取得する（本書は CP-2a の範囲の判断だけを扱う）。

---

## 実装時の追記（CP-2a 実装者）

TASK と食い違った点、または TASK が決めていなかった細部の判断。どれも閾値の緩和、公開、送信先・保存範囲の拡大、認可の削除、新しい authority を含まない。

| ID | 判断 | 理由 |
|---|---|---|
| CP2a-D23 | `Phase::Ready` から `ready_at` を外した（単なる Ready）。slot の動作は phase の種類だけで決まる | 読む箇所がなく dead-code 警告（`-D warnings`）になるため。TASK §3.2.2 の「同じ ready_at に戻す」は phase の復帰で足りる |
| CP2a-D24 | 製品 owner の試験は `nir1_graph_product.rs` 内の `#[cfg(test)] #[path = "nir1_graph_product_tests.rs"] mod tests;` で宣言した | TASK §2.3 の lib.rs の追加を 4 か所（mod 行、shutdown、Restore、Open）に保つため。lib.rs に試験用の mod 行を足さない |
| CP2a-D25 | 合流 helper：IR が ir-ready でないとき（timeout）に Graph が unavailable で届いていたら `graph-unavailable:ir-not-ready`、use は `unused`。TASK は available の場合だけを規定していた | Graph は IR が ir-ready のときだけ使う（CP2a-D16）。unavailable の結果は cache に入らないので use の差は害がない |
| CP2a-D26 | `relabel_open_refusal` は serde_json で再直列化する。status と snapshot は保つが、JSON の空白とキー順は変わりうる | reasonCode の付け替えに必要。wire の消費側は JSON として読む |
| CP2a-D27 | `GraphTicketUse::Cancelled` の finish は outcome を `Unavailable(Cancelled)` で上書きする（TASK の「outcome を捨てる」の解釈）。以後の deliver は効かない | N13(a) の「waiter で見た outcome が Cancelled」を満たすため。Available を捨てても cache には入らない |
| CP2a-D28 | 試験の fake worker、fence（`leak_c_query_quarantine_fence_for_test`）、N16–N18 の lib.rs 統合試験は `workspace-maintenance-test-support`／cfg(test) の下だけ。製品の経路に入らない | A-1 の確認（PUB-G の前は spawn しない）。`#[napi` の不在は N2 で確認 |
| CP2a-D29 | 観測スクリプト（`scripts/local-ci-setup-observation.mjs installed`）は Node 22 を要求する（`/^v22\./`）。この作業環境の既定 Node は v24 のため、`node --test` は Node 22.23.3（fnm）で実行した | 環境差。スクリプトと試験は変えていない |
| CP2a-D30 | 実 worker の lane（scripts/nir1-c-query-worker-ci.sh）は、fixture を mktemp に毎回生成する。Q2 の preseed を別途用意する必要はない | スクリプトの仕様どおり。lane の結果は各 mode のログ（lane_*.log）に残す |

## CP-2a レビュー指摘の修正（実装者 追記2）

レビュー（P2 4件、P3 数件）への対応で決めたこと。どれも閾値の緩和、公開、送信先・保存範囲の拡大、認可の削除、新しい authority を含まない。

| ID | 判断 | 理由 |
|---|---|---|
| CP2a-D31 | stale 判定で退役した結果が Quarantined なら `ServeNext::Exit`（従来は Rebuild）。`run_session` の先頭でも `guard.quarantined` なら再 prepare しない | TASK §3.2.4 の 5.4、§3.2.2 の Quarantined 行、DSN §1.6-1（quarantine 後は spawn しない）。Rebuild すると Preparing に戻り、Restore の入口判定をすり抜ける窓が生じる |
| CP2a-D32 | idle 退役は slot lock の中で Ready を Retiring にしてから worker を退役する。edge の退役も `begin_retiring` で Ready→Retiring にする。Retiring の間 begin は Query を積まず busy | Query を積んだあとに owner が読まずに抜けると ticket が解決しない（P2）。判定を lock の中で行えば、退役と Query の送信が競合しない |
| CP2a-D33 | session の終わり（SessionGuard の drop で slot から session と sender を外した後）に receiver を空になるまで読み、残った Query の ticket を Invalidated で解決する（`settle_queued`） | 送信者が無くなった後は Query が積まれないので、この drain で取り残しが無くなる。D32 の防御層 |
| CP2a-D34 | Retire は pending rekey がある間だけ意味を持つ。pending が無い Retire は古いものとして無視する（`serve_until_retired`、`wait_rebuild_window`） | 古い Retire が rekey 後の READY worker を退役させ、K2 の需要が満たされない（P2）のを防ぐ |
| CP2a-D35 | pending rekey は需要の時刻（`demand_at`）を持ち、rekey のとき `session.last_demand` を K2 の需要時刻にする | K2 の idle 窓は K2 の需要から始まる（DSN §1.4）。K1 の最後の需要から数えると、prepare 直後に退役しうる（P2） |
| CP2a-D36 | Preparing 中の別 key の需要は busy（warming ではない）で、準備を予約しない | TASK §3.2.2 の表、DSN §1.4（別 key は busy） |
| CP2a-D37 | quarantine の flag（`Shared.quarantined`）を cache の lock の中で立て、cache を空にする。以後の cache 読出しと遅れた結果の格納（と通知）を行わない。flag は process 寿命で解けない | TASK §3.2.7、DSN §3.3（quarantine で空にする）。遅れた `finish(Unused)` が cache を再充填しないようにする（P3） |
| CP2a-D38 | `Nir1GraphRequest` は各 String を `as_str().to_owned()` で作り直す（capacity を長さに合わせる） | TASK §3.2.3。cqw の request_len は capacity の合計 8,192 以下を要求する（P3） |
| CP2a-D39 | serve_ready は、同じ key でも global の edge epoch が session の epoch と違えば busy を返す | edge の後に Query を積まない。D32 と合わせて二重に守る |
| CP2a-D40 | TS（合流 helper）：`onIr` は `!isActive()` を invalidated として扱う。購読の callback は cancelled の理由を保つ。`publish` は `onGraphSettled` を try/finally で囲み、必ず resolve する | TASK §3.3-2、CP2a-D16（P3）。試験 T11（締切の境界で遅れた Graph を混ぜない）、T12（終了後の IR）、T13（cancel の理由）を追加 |

試験の追加（grimodex-node）：`stale_retirement_that_quarantines_never_rebuilds`、`idle_retirement_refuses_queries_while_the_worker_retires`、`edge_retirement_refuses_queries_while_the_worker_retires`、`queued_query_is_settled_when_its_session_ends`、`rekeyed_session_keeps_the_new_key_for_its_own_idle_window`、`preparing_refuses_another_key_as_busy_without_reserving_it`、`quarantined_late_unused_result_never_refills_the_cache`、`request_is_rebuilt_to_its_length_before_the_worker_sees_it`、`shutdown_during_prepare_discards_the_worker_and_closes`、`shutdown_during_query_invalidates_the_ticket_and_retires`、`dto_is_delivered_only_after_the_worker_retires`、`new_ready_publication_never_prewarms`。N8 は 2 回目の需要の結果を assert しない（負荷で結果が変わるため）。
fake には `retire_started`、`retire_hold`、`retire_release`、`retire_quarantines`、`OkThenQuarantine` を足した。HEAD の owner に対して新規試験 8 件が失敗することを確認した（一時的に HEAD を戻して実行し、修正版をチェックサムで復元した）。

## CP-2a レビュー指摘の修正（実装者 追記3、2026-10-14）

レビュー（P2 2件、P3 6件）への対応で決めたこと。どれも閾値の緩和、公開、送信先・保存範囲の拡大、認可の削除、新しい authority を含まない。入口に足すのは拒否だけで、Core の規則は変えない。TASK §2.3 の lib.rs の追加（4 か所・15 行以内）には Open の入口 1 か所（7 行）が加わった（CP2a-D43）。state.rs の変更はない。

| ID | 判断 | 信頼境界 | 代替案と不採用の理由 |
|---|---|---|---|
| CP2a-D41 | graph-ready の未充足の需要は project ごとの集合（重複なし、最大 8 件、超えたら最も古いものを忘れる）で持つ。begin が warming か busy を返したときに加えて、**ticket が stale か busy で解決したとき**（stamp の S0≠S1、worker の registration-drift、CapacityBusy、作り直しの待ちの間に届いた Query）も `TicketShared::deliver` の中で記録する。READY のとき、その project が記録にあれば通知を 1 回出して消す。別 project の記録は消さない（P2、P3） | 通知の payload は projectId だけ（変更なし）。集合は Native の memory の中で永続化しない。通知 hook は CP-3a が EventQueue に結ぶまで未設定のまま（新しい送信先を作らない）。mutex は leaf で、slot か ticket の lock の下で取り、ほかの lock を囲まない | 全体で 1 つの flag のまま `serve_query` の 2 か所で立てる案（レビューの案）：再構築待ちの間に届いた Query の busy を取りこぼしやすく、別 project の需要が今の project の READY で消費され、通知も今の project 名で出る（P3）が残る。ticket の解決は `deliver` に集まるので、そこで記録すれば経路を取りこぼさない |
| CP2a-D42 | quarantine が fence に移せず participant を process 寿命で保持する経路（または資源をすべて forget する経路）では、Core に fence が残らず、physical exclusion が process の寿命の間成立しない。この状態で slot が Quarantined のとき、**Open は対象を問わず（W1 も W2 も）、Restore は現在の workspace を問わず**、入口で `nir1-graph-restart-required` の not-admitted にする。Open の入口は Core の admission の前（`preflight_workspace_open_target` の直後）に置き、wire は Core の not-admitted と同じ形（status、reasonCode、snapshot）。fence 経路は従来どおり（W1 の Restore は入口で拒否、W1 の Open は Core の `active-operation` の付け替え、W2 は開ける）。経路は Core の read-only 照会 `WorkspaceLifecycleCore::c_query_quarantine_binding()` で見分ける（観測だけで、admit も release もしない）（P2） | 拒否を足すだけで、認可の削除ではない。reasonCode は Restore で CP2a-D12 が定めた既存の値で、新しい値や型を作らない。Core の規則は変えない。Core の照会は何も許可も解放もしない | (1) Core の admission で Open／Restore を拒否する案：Core の規則の変更（CP2a-D12）なので委任外の確認が要る。(2) worker の退役結果（`CQueryRetirement`）に経路を持たせる案：lease の drop、`retire()`、Drop の 3 つの退役経路すべてに状態を持たせる必要があり、fake worker も同じ区別を再現しなければならない。fence の記録は physical exclusion が成立するかという事実そのもの。(3) 参加者数（`workspace_participant_count`）から推測する案：ほかの participant と区別できない。(4) §1.9 の受入れを fence 経路に限り、Open が止まる制約を PUB-G の前提条件に記録する案（レビューの第二案）：拒否の追加で閉じられるので採らない |
| CP2a-D43 | lib.rs の追加は `open_workspace_supervised` の入口 1 か所（7 行）。TASK §2.3 の「4 か所・15 行以内」を超えるが、レビュー（P2）が「Core の admission より前に拒否を足す」ことを指定した。判定は `Nir1GraphProductOwner::refuse_open_while_participant_quarantined` に置き、lib.rs には呼出しと early return だけ | 入口の拒否だけ。Backend constructor、N-API の署名、ipcContract、preload は変えない | 判定を lib.rs に書く案：hotspot の行数が増える |
| CP2a-D44 | Restore の入口（`blocks_restore_of_current_workspace`）は、slot が Quarantined になるのを待たず、Core の fence の記録を先に読む。fence は worker の退役の途中で立ち、slot が Quarantined になるのはその後の SessionGuard の drop なので、この間に来た Restore は入口を通り、physical exclusion で待ち続けていた（P3） | 同上。拒否を足すだけ | Core の Restore admission で quarantine を検査する案：Core の規則の変更（CP2a-D12）。判定を Core の lock の下で行う案：Core に callback を渡す API が要る |
| CP2a-D45 | 試験の安定化と覆い。N4：prepare と query の thread id を集合で比べる（query の後の作り直しの prepare が先に入っても同じ thread）。N5：Stale を受けた直後の `retires == 1` を `wait_until` に（Stale の deliver は退役より前）。N16：`restore_backup` と `open_workspace` を 2 s の timeout で包む（`within_two_seconds`）。覆いの追加：ticket 経由の stale／drift／busy の後の READY の通知（通知を最初の READY から確かめる）、通知の project 別の消費、finish(Unused) を Available の後に行う枝、未 finish の ticket の Drop、作り直しの最短間隔（create の時刻で比べる。create は prepare の記録より前、次の create は間隔の後なので、差が間隔より短くなることはない）、participant 経路の Open／Restore の拒否（query の中で起きる経路と、Unavailable edge の中で起きる経路。後者がレビューの再現手順）、Core の fence の記録が slot より先に立つ窓。grimodex-db：Core の照会の試験、D3 の件数 assert を `#[cfg(unix)]` にして Windows は SystemRoot の 1 件（絶対 path）を assert | — | — |

### owner／lifecycle matrix の差分（GDX-PRECHECK-001）

| 区分 | 変更 |
|---|---|
| entry | Open の入口に拒否を 1 つ追加（owner への入口ではなく、transition の入口側の拒否）。Restore の入口の判定を Core の fence の記録に変更 |
| start、retry、reentrant、cancellation、active handle、pending start | 変更なし |
| admission closure | participant 経路の quarantine の後は、Open と Restore を Core の admission の前に拒否する（待機に入らない） |
| bounded wait | 拒否は wait 0。Core の mutex と slot の mutex を入れ子にせず順に短く取るだけ |
| 終了の証拠 | 変更なし（participant と fence は process 寿命。終端は Main の 30 s の観測と `exit(1)`） |
| error、timeout、onClosed | Core の読取が失敗したとき（poisoned）は拒否せず Core に任せる（Core も同じ lock で失敗する） |
| restart の状態 | 変更なし（未充足の project の集合は process-local） |

### 変異による確認（試験が退行を検出すること）

製品コードを 1 か所ずつ壊して、新しい試験が落ちることを確かめた（確認後に元へ戻し、sha256 で復元を確認）。

| 変異 | 落ちた試験 |
|---|---|
| `deliver` で stale／busy を記録しない（P2-1） | ticket 経由の stale、drift、busy の 3 件（再構築後の READY の通知が来ない） |
| READY の通知の block を無効にする | 同じ 3 件（最初の READY の通知が来ない） |
| 未充足を project ごとでなく全体 1 つに戻す（P3-1） | 別 project の需要を消費しない試験（通知が 2 回出る） |
| Open の入口の拒否を無効にする／lib.rs の呼出しを消す（P2-2） | participant 経路の試験 2 件。`Open of W1 did not return within 2 s`（Unavailable edge の再現手順でも同じ） |
| Restore の判定を slot 先にする（P3-5） | Core の fence が先に立つ窓の試験 |
| 作り直しの最短間隔の待ちを消す（P3-4 c） | 最短間隔の試験（`the rebuild started 1.0ms after the previous worker`） |
| 未 finish の ticket の Drop を Cancelled にしない（P3-4 b） | Drop の試験 |
| Available の後の `finish(Unused)` の cache を消す（P3-4 a） | その試験 |

### 検証（追記3、最終 head の内容に対して）

| コマンド | 結果 |
|---|---|
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::nir1_graph` | 106 passed／35 ignored（D3 を含む。件数は変わらない） |
| 同 `-p grimodex-db --lib workspace_lifecycle` | 63 passed（Core の照会の試験 1 件を含む） |
| `cargo check --locked ... -p grimodex-db --lib --features workspace-maintenance-test-support` | OK |
| `cargo clippy --locked ... -p grimodex-db --all-targets -- -D warnings` | OK |
| 同 `--features nir1-c-query-test-seam,workspace-maintenance-test-support`（-D なし） | 警告 2 件。前回と同じで、変更していない行の既存の警告（open.rs の `matches!`、c_query_worker.rs の古い試験の `vec!`） |
| `cargo test --locked --manifest-path electron/native/grimodex-node/Cargo.toml --lib nir1_graph_product` | 65 passed（52 → 65） |
| `RUST_TEST_THREADS=2 cargo test --locked ... --features licensing,legacy-keyring-migration` | 380 passed（367 → 380） |
| `cargo clippy --locked ... grimodex-node --all-targets -- -D warnings`（既定と `--features licensing,legacy-keyring-migration`） | どちらも OK |
| `bash scripts/nir1-c-query-worker-ci.sh lifecycle` | 16 passed |
| `bash scripts/nir1-c-query-worker-ci.sh`（既定） | 11 passed |
| 負荷下：N4／N5（1 core に固定し busy loop 10 本と競合、15 回） | 15/15 pass（レビューは同じ条件で N4 が 15 回中 5 回失敗） |
| 負荷下：製品 owner の全 65 件（2 core＋busy loop 6 本、3 回） | 3/3 pass |
| 負荷下：製品 owner の全 65 件（1 core＋busy loop 10 本、3 回） | 3/3 pass |

未実行：TS（tsc、lint、vitest）と `node --test scripts/ci-pause.test.mjs scripts/local-ci.test.mjs`（TS と scripts は変更していない）。caller-cancellation、startup-registration-refusal、frame-lifecycle の lane（worker 実行体と owner の挙動は変更していない。integrator が最終 head で hosted dispatch する）。実行環境では別の lane の build と試験が並走していた。

### 未解決事項の追加

- participant 経路へ移る**前に** admission 済みの Open／Restore は、入口では止められない。Core が transition を veto するのは fence を取れた handoff だけである。fence を取れないのは、file identity がない、すでに別の fence がある、物理 I/O 中の transition がある、participant が共有されている、などの場合。移行の途中（worker が participant を保持してから slot が Quarantined になるまで）に来る Open も同じ。DSN §1.6 が認めている「transition と shutdown の drain が終わらない」経路そのもので、終端は Main の観測と `exit(1)`。防ぐには Core 側の veto が要り、Core の規則の変更なので委任外の確認が要る。
- Restore の判定と Core の admission は一つの lock の下ではない。判定の後、admission の前に、Ready のまま（handoff でなく）fence が立つと、その Restore は physical exclusion で待つ（CP2a-D44）。窓は、cleanup を証明できない退役と利用者の Restore が重なる瞬間だけ。
- participant 経路では、Open と Restore 以外で physical exclusion を待つ入口（`restore_recovery_candidate` の Safe Mode 復元、descriptor recovery の pump）も待ち続ける。CP-2a はレビューの範囲の Open と Restore だけを入口で拒否した。残りは PUB-G の前提条件にするか、Core の admission 側で一括して拒否するか（委任外の確認が要る）を advisor が決める。
- fence 経路の Open の付け替え（`relabel_open_refusal`）は slot が Quarantined になった後だけ働く。その前の窓では Core の `active-operation` のまま返る（拒否は Core が行うので待たない）。
- 未充足の project の集合は 8 件まで。超えた分の通知は落ち、その window は自分の次の query を待つ。
- コミットメッセージの試験件数（grimodex-db 106、grimodex-node 全体 355 など）は最初のコミット時点の値のまま（`--amend --no-edit`）。最終の件数はこの記録の下の「検証」と報告に書く。

### DSN への追随（integrator）

- §1.6-3、§1.9：quarantine には 2 つの経路がある。fence 経路は従来どおり（W1 の Restore と同じ file の Open を拒否、W2 は開ける）。participant 経路では、process の再起動まで Open（W1、W2 とも）と Restore をすべて入口で `restart-required` の not-admitted にする（開ける W2 はない）。
- §3.4 (a)：需要の記録は project 単位。ticket が stale か busy で解決した需要も未充足として数える。
- §1.2、§1.6：Core に read-only の照会 `c_query_quarantine_binding` を足した（経路の判定に使う）。
- TASK（`cp2a-task.md`）：§3.2.1 の `demand_unserved: AtomicBool` は project ごとの集合に置き換わった。§3.2.2 の「warming、stale、busy を返したら true」は、ticket の解決も対象になった。§3.2.8（Restore、Open）は participant 経路の拒否を含む。§2.3 の lib.rs は 4 か所から 5 か所（22 行）になった。
