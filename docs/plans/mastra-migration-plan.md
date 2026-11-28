# Mastra 移行の実装計画（2026-11-19）

- 状態：**計画**。MP-0 として master に入れる文書。コードは変えていない。
  決定済みの項目（U-2、U-3、U-5、U-6）と、各 MP の前に伺う項目（第 7 節）を分けて書く。
- 基点：origin/master `357e6383`。file:line は、特記がなければこの基点の行（MP の着手時に引き直す）。
- 脅威モデルと owner／lifecycle の表は別 file：[`mastra-migration-threat-model.md`](mastra-migration-threat-model.md)。
  **確定（U-1、2026-11-19）**。
- この文書は、決定を変えない。決定済みの前提を、依存の順の PR に割り当てるだけ。
- 見積りの行数・日数は書かない。

## 0. 読み方

- 区別：**事実**（実行または読解。根拠つき）、**推測**、**未確認**。
- 略記：
  - **local の spike 枝**：`claude/mastra-spike`。master には無く、push しない。実行の記録と調査の草稿は、すべてそこにある。
    この文書は、必要な事実だけを根拠の ID 付きで要約する。根拠の本体は local の spike 枝にある。
  - `S-Mn`：spike 枝の memory 実験の記録の節（`spike/mastra/memory/RESULTS.md`）。
  - `S2`〜`S5`：spike 枝の最小実験（load、telemetry、adapter、tool）の記録。
  - `S6`：spike 枝の、現行 loop と Mastra 経由で Rust に渡る request の比較（`spike/mastra/s6/RESULTS.md`）。
  - `設計 §n`／`M`／`Q`：spike 枝の memory 設計草稿の節・事実表・問い。
  - `X`／`T`／`W`：[脅威モデル](mastra-migration-threat-model.md)の、棚卸し（X）、脅威（T）、owner／lifecycle の表（W）。
  - `P`：第 12.1 節の表（GDX-PRECHECK-001 の質問票 P1〜P18。ユーザーの回答 2026-11-19）。
  - `survey`：[`mastra-migration-survey.md`](mastra-migration-survey.md)（master にある調査）。
- **MP-n**：この計画の n 番目の PR。GitHub の PR 番号ではない。
- **B′**：「loop と tool は main、LLM 送信は Rust」の呼称。
  - main の TS が `LanguageModelV4` を実装した adapter を持つ。
  - adapter は既存の N-API `send_agent_message`（`electron/native/grimodex-node/src/lib.rs:17110`）を呼ぶ。
  - docs/plans に定義が無かったので、ここで 1 行にした。

## 1. 前提（決定済み。変えない）

出典：spike 枝の設計草稿の §12・§13（ユーザーの決定 2026-11-18）、第 1.1 節の決定（2026-11-19）、第 12.1 節の回答。

- **loop と tool**：main。送信は Rust（B′）。telemetry は `MASTRA_TELEMETRY_DISABLED=1`（厳密に `"1"`。S3 訂正 5）。
- **ee**：`@mastra/core` の ee 由来のコードは、stub と build の検査で配布物に入れない。version を上げるたびに検査する（P10。第 11 節）。
- **memory**：全機能（WM、OM、題名、semantic recall）。対象は agent chat の通常の会話だけ（Q2）。
  - storage：C-1（Rust 所有の adapter。`chat_*` を物理の正本に残し、additive 列と新表 3 本）。
  - 背景の LLM：利用者が選んだ provider を Rust 経由。embedding はローカル ONNX。
  - tool の保存：名前・引数・成否・digest だけ（Q5）。
- **message の扱い**：差し込む message（要約・関連する過去の会話・pin）は保存せず、system 側から渡す。
  削除では、OM・WM・索引から、削除した message に由来する内容を消すか作り直す（設計 §13）。
- **P9 の条件**：`ON CONFLICT DO UPDATE`、signal の除外、差し込みを user で INSERT しない、`REPLACE` 禁止、`parts_json` だけ更新。
  全 schema の試験は済んだが、adapter は**模型**（S-M14）。
- **P1〜P18**：第 12.1 節の表のとおり（ユーザーの回答 2026-11-19）。PR を割り当てた。
- **画像 URL**：memory の message に画像 URL を通さない（直接の GET と asset download を起こさない）。
  asset download は memory でなく core の系統なので、agent への入力全体に URL 画像を通さない（X11、X12。決定 2026-11-18）。
- **閉じた後に残る仕事**：AbortSignal が届かない仕事は、ambiguous の audit 行で閉じる（X21、X22。決定 2026-11-18）。
- **vector の metadata**：message の本文（chunk）が入ることを許し、削除・export・backup の範囲に含める（P3、X7。決定 2026-11-18）。

### 1.1 2026-11-19 のユーザーの決定

- **U-2（docs の着地）**：master に入れるのは計画書だけ。移行の計画、脅威モデル、lifecycle に限る。
  ee の license の条文の引用と法的な読解、spike の実行の記録は入れない。
  必要な事実は、根拠の ID（S-Mn など）付きで要約する。根拠の本体は local の spike 枝にある。
- **U-3（PR の分け方と旗）**：MP-0〜13 の分け方と順序。旗が closed gate 2 本（L と M）であること。開けるのは journey の seam だけであること（第 4.2 節）。
- **U-5（依存）**：`@mastra/core` と `@mastra/memory` の追加、`pnpm install`、`THIRD_PARTY_LICENSES.md` の更新。
  env の固定は、Mastra を load するときだけ適用し、子 process には元の env の写しを渡す。
- **U-6（provider）**：最初から主要な provider すべて（Anthropic、OpenAI、OpenRouter）に対応する。
  Ollama などは対象外で、今の経路のまま残す。

## 2. 基点のずれと並行 lane（事実）

- spike の結果は、spike の基点 `5d09b3c4`（その時点の origin/master）の上で取った。master は、その後 38 commit 進んだ（`357e6383`）。
- `git diff --stat 5d09b3c4 357e6383 -- src/application/chat src/features/chat`：60 file、+12,544／−225 行。
  題名から読める範囲（内容は未読）：
  - chat IR S1（A2、A2b、B1、B2）：`toolExecutors.ts` の変更、`chatTurnToolScope.ts` の新設、`chatTurnStoreActions.ts` の tool 文脈の抽出。
  - モデル能力（#941、#947、#948、#952）：`modelLimits.ts`、`dynamicModelCaps.ts` など。
  - #940「agent の書き込み tool の出典に使う assistant 行を先に作る」と #946（#940 の follow-up）。
    S-M11（turn 途中の保存と `chatMessageId` の整合）の別 lane の修正と**見られる**（`chatAssistantRowReservation.ts`）。
  - #950「英語 project の cascade 削除で `_en` FTS に孤児が残り、以後の保存が失敗する」を直した。
    S-M14 が見つけた「既存の問題」と同じ症状の修正と**見られる**。`workspace_schema.rs`、`migrate.rs`、`schema-contract.json` を変えた。
- 帰結：
  - S-M14 の「schema・migration・write clock・typed writer の主要 6 file に差分なし」は spike の基点での記述で、**今は成り立たない**。全 schema 試験は MP-7 でやり直す。
  - S6 の bytes 比較は spike 基点の結果。MP-2・MP-4 で最新 master に対してやり直す。
  - 本文の file:line は、この文書の基点（`357e6383`）で確かめ直した。MP の着手時に引き直す。
  - chat IR S1 と model-caps の lane が、同じ agent 経路を触っている。MP-3〜MP-6 は、その lane の merge に順序の依存を持つ。
- 手順：各 MP は最新の master から作業ブランチを切る（`create-branch`）。spike の枝は参照だけで、push しない。
  spike のコードは、必要な file をコピーして整える。

## 3. 進め方

- **長期・高リスクの作業**（GDX-PRECHECK-001）：integrator 1 人、実装者、候補に触れない独立の acceptance reviewer を分ける。
  P2 以上の指摘は freeze と merge の前に解消する。候補台帳に脅威モデルの確認済み版を記録する。
- **NIR-1 の事前委任は、この移行に及ばない**。技術判断のうち、委任外（新しい送信先、保存範囲、新しい契約・authority、
  閾値の緩和、製品公開）は、各 MP の前に確認する（第 7 節）。必要な確認が未了なら `[precheck]` で止まる。
- **各 MP の共通の merge 条件**（`iron-laws.md` の「Agent validation scope」、GDX-TRACE-001）：
  - rebase した clean な候補で Quick と verify、同じ head の PR checks。canonical Full は merge 後の master で走る。
  - docs だけの PR は Quick と `verify:quality`（Node 22）。
  - Full を待たない。赤なら後で修正の PR。
  - 以下の各 MP の「条件」は、この共通条件に**足す**もの。
- 使う skill：
  - 2 層以上の再編（MP-3〜MP-6、MP-9）：`refactor-cross-boundaries`。実装の前に影響マトリクス。
  - 新しい IPC command（MP-3、MP-5、MP-12）：`add-electron-command`。IPC の正本は `electron/shared/ipcContract.ts`。main で引数を再検証する。
  - AI 指示・prompt を変える場合（MP-10 で Mastra 同梱の prompt を上書きするとき）：`grimodex-author` と `grimodex-impact-gate`。
  - journey を足す・変える場合：`electron/scripts/product-journey-catalog.mjs` と
    `scripts/local-ci-full-workload-allocation.json` の digest を揃え、push 前に `verify:quality`（Node 22）。**推測**（過去の PR の変更の組から）。

## 4. 旗の設計と、「off で不変」の限界

### 4.1 現状（事実）

- 汎用の feature flag は repo に無い（`featureFlag`／`FEATURE_FLAG` の grep が 0 件）。
- 既存の型は **closed gate**：
  - Native の `PrePublicationEntry`（`electron/native/grimodex-node/src/main_grant.rs:166`）。
  - Main の gate（`electron/main/chatAgentIr.ts`、`electron/main/nir1LocalGeneration.ts:1-25`）。
  - journey 専用の seam。packaged では開かない（同 `:91`、`:162-170`）。
- 設計 §12 Q1 は「戻すのは設定の切替」。

### 4.2 旗の設計（決定済み。U-3）

- **旗 L（loop）と旗 M（memory）**。closed gate 2 本。製品の launch では常に閉。開けるのは journey の seam だけ（U-3 で承認済み）。
- 既定 on にする時点で、利用者設定 `engine`（legacy／mastra）を足す案。これが戻しの入口（第 10 節）。
  製品公開に当たるので、既定 on か opt-in かは U-16 で伺う。
- **M は L を要する**。M だけ開く組合せは gate で拒否する。
- 出荷できる組合せ：

| L   | M   | 意味                                                                            | parity と journey      |
| --- | --- | ------------------------------------------------------------------------------- | ---------------------- |
| 閉  | 閉  | 現状                                                                            | 既存の journey         |
| 開  | 閉  | loop と tool が main。履歴は renderer が組み、保存は既存経路。schema の変更なし | MP-3〜MP-6 の journey  |
| 開  | 開  | 全部                                                                            | MP-9〜MP-11 の journey |

- engine は **turn の開始時に 1 回**決め、途中で変えない。
  次の turn は legacy に落とす：対象外の provider（Ollama など。U-6）、添付つき（MP-3）、restricted、非 agent chat、CLI／codex-app-server、`nir1-local-*`。

### 4.3 旗では守れないもの

- **bundle・起動**
  - `@mastra/*` を main の bundle に入れると、閉でも読込・parse の費用が出る。
  - **事実**：core の bundle で 13.8〜14.0 MB（S2）。memory 入りの大きさは**未測定**。
  - 手当て：gate が開くまで `require` しない遅延 load。
    別 output にできるかを MP-1 で測る（**未確認**。`electron/scripts/build.mjs` は単一の main bundle）。
  - `perf:budget` を merge 条件にする。
- **配布物の中身**
  - bundle に入れなくても、electron-builder が production 依存の `node_modules` を asar に足すなら、ee の実体が載る。
  - `electron-builder.yml:14-21` の `files` は `dist/**` 等だけ。依存の自動追加の有無は**未確認**。
  - 手当て：MP-1 で、build した asar の列挙に ee の file が無いことを検査する。
  - `dependencies` と `devDependencies` の別も MP-1 で決める（spike は `dependencies` に入れた）。
- **env の固定**
  - spike 枝の設計（§4.3）は、main の `process.env` から API key を消す。
  - **事実**：`electron/main/cliAi.ts:388` と `electron/main/codexAppServer/process.ts:389`（`buildCliEnvironment("codex")`。定義は `cliAi.ts:405`）は、
    子 process の env を `process.env[key]` から組む。
    opencode は、設定が参照する任意名の env を引く（`openCodeReferencedEnvKeys`）。
  - したがって、消すと旗 off でも子の挙動が変わる。
  - 手当て：適用は Mastra を load するとき（gate が開いたとき）だけ。子 process 用には元の env の写しを保持する（決定済み。U-5）。
- **schema**
  - MP-7 の migration は旗で戻せない。
  - `src-tauri/crates/grimodex-db/src/migrate.rs:469-472` は、DB の version が新しいと旧版を拒否する。
  - 手当て：できるだけ後ろに置く。個別に確認する（U-10）。第 10 節に明記。
- **検査と台帳**
  - `impact-map`、`aiPathRegistry`、`rendererIsolation.static.test.ts`、`packagingConfig.test.ts`、`validate:architecture`、lint は、旗に関係なく走る。
  - 手当て：各 MP の条件に含める。未配線の module（MP-1 の env 固定、MP-2 の adapter）が未使用の検査に当たらないことも含める。

## 5. PR の索引（依存の順）

| MP  | 内容                                                                          | 層                    | 旗   | 戻せるか                |
| --- | ----------------------------------------------------------------------------- | --------------------- | ---- | ----------------------- |
| 0   | 段 0：計画書と、脅威モデル・lifecycle 表（draft）の着地                       | 文書                  | -    | docs の revert          |
| 1   | 依存・ee の stub と検査・env 固定・licenses                                   | build、CI             | -    | revert                  |
| 2   | `LanguageModelV4` adapter（B′。3 provider）と parity 試験                     | main                  | -    | revert                  |
| 3   | loop の骨格（tool 0・memory 0）、gate L、lifecycle、audit owner、typed IPC    | renderer、IPC、main   | L 閉 | revert                  |
| 4   | tool 基盤、loop 規則の同値移植、read tool の main 化                          | main、（N-API）       | L 閉 | revert                  |
| 5   | main→renderer の RPC と UI tool（7 本。help 2 本を含む）— 完了（#1157・#1160・#1161・#1164・#1168） | renderer、IPC、main   | L 閉 | revert                  |
| 6   | write tool、capability、write 後処理 — 実装中（PR①〜③：#1170・#1189・#1190。残り 2 tool と renderer の完了処理） | main、renderer        | L 閉 | revert                  |
| 7   | **schema の migration**、Rust の memory 書込み、N-API `memory_*`、D2a 台帳 — 完了（schema 47、#1173・#1175・#1178） | Rust、N-API、main     | M 閉 | **schema は戻らない**   |
| 8   | TS の storage／vector adapter、`MemoryRuntimeOwner`、実 Mastra の呼び順の観測 — 完了（#1184・#1194） | main                  | M 閉 | revert（schema は残る） |
| 9   | 履歴の持ち主と保存の main への移動 — 着手（判断 #1182、実装中）              | renderer、main        | M 閉 | revert                  |
| 10  | 背景 LLM の route 4 本、embedding、OM 構成 — 実装中（route #1180・#1183、N-API #1187。OM 構成） | main、N-API、registry | M 閉 | revert                  |
| 11  | lifecycle（closure、quit、削除時の purge）、`T_quit`                          | main、Rust            | M 閉 | revert                  |
| 12  | 設定・WM の UI・開示・consent                                                 | renderer、IPC、main   | M 閉 | revert                  |
| 13  | **旗を開ける**（13a：L、13b：M）、P11 の確定、公開前の検査                    | 全層                  | 開   | engine 設定             |
| 14  | legacy 経路の撤去                                                             | -                     | -    | この計画の外            |

依存の骨格：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13。
状態・順序の更新（master、2026-11-27）：2026-11-26 の決定で MP-7〜MP-10 は MP-5 と並行し、U-10・U-11・U-12 は回答済み。目的欄は取り下げ済み（MP-9 範囲参照）。Gate A（A1・A2）は Mastra lane が MP-6 の後に持ち、A3 は別 lane（2026-11-27 決定）。MP-5 は #1157・#1160・#1161・#1164・#1168 で完了。MP-6 は PR①〜③（#1170・#1189・#1190）まで実装中で、`propose_scene_body`・`apply_ai_tree_plan` と renderer の完了処理が残る。4c-2 は #1185 で準備、PR①は実装中。

ただし 13a（旗 L）は、MP-6 の後に前倒しできる（schema の変更を伴わない）。2026-11-28 の条件（MP-13 の節、問 42）を満たした後に限る。

- MP-7 を MP-6 の後に置く理由：
  - L だけで出荷できる地点（MP-6 の後）が持てる。schema の変更を伴わない。
  - 一方向の変更の前に、移行をやめる判断が安く下せる（第 10 節）。
- MP-7 以降は、2026-11-26 の決定により MP-5 と並行して着手する（状態更新。下記の設計条件は維持）。

## 6. 各 PR

各 MP の「確認」は第 7 節の U-n への参照。「検証」の測定は第 8 節に手順をまとめた。

### MP-0 段 0（文書。この PR）

- 範囲：
  - この計画書と、脅威モデル・owner／lifecycle の表（別 file）を master に入れる。
  - 入れるのは、移行の計画、脅威モデル、lifecycle に限る（U-2）。ee の license の条文と読解、spike の実行の記録は入れない。
    根拠の本体は local の spike 枝にあり、必要な事実だけを ID 付きで要約した。
  - 脅威モデルの確認と凍結（U-1）、役割（integrator、実装者、独立 acceptance）の割当ては、この PR の後、MP-1 の前に伺う。
- 層：なし（文書だけ）。
- 条件：docs だけの PR の条件（Quick と `verify:quality`。Node 22）。
- 旗：該当なし。
- 確認：U-1（2026-11-19 に確定）、U-4（一覧の提示）。U-2、U-3 は決定済み（第 1.1 節）。
- **事実**：spike 枝の設計草稿の脅威モデルは draft のまま。第 12.1 節の回答（P1〜P18）に、脅威モデル自体の確認は**見当たらない**。
  U-1 は 2026-11-19 に確定した（脅威モデル文書の冒頭）。

### MP-1 依存・ee・env・build の土台

- 範囲：
  - 依存の追加（U-5 で承認済み）。exact pin：`@mastra/core` 1.83.0、`@mastra/memory` 1.41.2。推移依存は 8 本ほか（spike 枝の設計 Q18）。
  - ee の stub plugin を製品の build 設定に入れる。spike で直した版（実名で分類。S2 追補）を使う。
  - **ee の検査 script**（CI 必須）：
    - 素の bundle で ee の chunk を検出できること（陰性対照）。
    - stub ありで、metafile の ee 系 input が stub だけであること。
    - core だけと core＋memory の 2 entry で行う。
    - **製品の main bundle に `@mastra/*` が初めて入る MP（MP-3）では、同じ検査を製品の bundle に適用する**。
  - build した asar の列挙で、ee の file が無いことの検査（第 4.3 節）。
  - env 固定の module（未配線）：`MASTRA_TELEMETRY_DISABLED="1"`、`MASTRA_OFFLINE=true`、除去する env の一覧（設計 §4.3）。
    一覧に `OM_DEBUG`（cwd の `om-debug.log` への書込み）、`OM_REPRO_CAPTURE`、`OM_REPRO_CAPTURE_DIR` を含める（X18、M14）。
  - `THIRD_PARTY_LICENSES.md` の更新（`update-licenses`）。
- 層：build（`electron/scripts/build.mjs`）、`package.json`、lockfile、CI。renderer、IPC、N-API、Rust は無い。
- 製品の bundle には `@mastra/*` を入れない（検査用の CI 専用 bundle だけ）。
- 条件：
  - 検査が陰性対照で落ち、stub で通る。
  - `perf:budget` と bundle の大きさが変わらない。
  - 既存の `cliAi`／`codexAppServer` の試験が通る（env 固定は配線しない）。
  - 未配線の module が、`validate:architecture`、lint、未使用の検査に当たらない（当たるなら、試験からの参照で通す）。
  - ダミー key を env に置いた対照走行（M13(a)）：固定なしで POST を試み、固定ありで 0（第 8 節）。
- 旗：該当なし（製品の経路に載らない）。
- 確認：U-5（決定済み。2026-11-19）。
- 検証：第 8 節の「通信」「bundle・起動」。

### MP-2 `LanguageModelV4` adapter（Anthropic・OpenAI・OpenRouter）

- 範囲：spike の `spike/mastra/adapter.ts` と S6 の「戻し」を製品の module にする。
  - **対応する provider は Anthropic、OpenAI、OpenRouter の 3 つ**（U-6。決定済み）。最初から全部を対象にする。
    Ollama などは対象外で、今の経路のまま残す。
  - tool 定義を、main が持つ turn 開始時の snapshot の元の定義に差し替える（S6 #1、#2）。
  - cache の区切り（`systemCacheSegments`／`systemVolatileTail`）と route（thinking、effort、provider、model、`requestMaxOutputTokens`、`resolvedToolProtocol`、`endpointId`）を `providerOptions.grimodex.*` で運ぶ（S6 #5、#6）。
  - tool_use の `input` の key 順を `toolCallId` で保持して戻す（S6 #9）。
  - tool_result を renderer と同じ整形の文字列に。`isError` を常に付ける。失敗に `Error: ` を前置（S6 #10〜#12）。
  - 複数 text を `"\n"` で連結。署名の無い thinking を戻さない（S6 #13、#14）。
  - `toolCallConcurrency: 1` を固定（S6 #15）。`providerOptions.mastra.createdAt` を Rust へ漏らさない（S6 #16）。
  - `stopReason` の全値の写像（今は 3 値だけ。S4 訂正 8）。provider ごとの値も含める。
  - Mastra に渡す model id と provider 名は中立にする（schema が model id と provider 名で変わる。S5、S6 #2）。
    route の provider・model は `providerOptions.grimodex.*` で渡す。
  - **provider ごとの差を、MP-2 の最初の小さな試験で確かめて adapter に写す**。spike は Anthropic 形の fake だけで、OpenAI 系と OpenRouter は**未確認**（S4、S6）：
    - **usage の会計**：Anthropic 形は input が cache を含まない。OpenAI 系は cached が input の subset（S4 の注記。写像は未実装）。
      adapter が provider 別に `inputTokens`・`cacheReadTokens`・`cacheWriteTokens` を写し、`recordAiUsage` の台帳と費用の記録が現行と同じになること。
    - **OpenAI の Responses API の thinking と署名**：reasoning の往復（署名に当たるもの）が adapter を通って欠けないこと。`apiVariant` の運搬（S4。未検証）も含めて確かめる。
    - **OpenRouter の差**：model id と provider の指定、`endpointId`、tool schema と cache の扱いの差。現行の経路との差を列挙する。
    - **tool schema の provider 依存の書換え**（S5：`openai.chat` では optional が nullable 化される）が、adapter の provider 名を中立にして避けられること。
    - `webSearch`／`apiVariant`、citations、`doStream` の写像を、provider ごとに。
  - **`agentAuthorityCapabilities` を tool の実行まで運ぶ継ぎ目**（S6「loop との挙動差」：今の adapter は落とす）。
  - doGenerate 1 回ごとの audit の begin／dispatched／complete を、adapter と owner のどちらが持つかを決める。
  - **自動の再試行を無効に固定する**：`maxRetries` を 0、model の fallback は設定しない（GDX-POLICY-001。副作用を盲目的に再試行しない）。
    **未確認**：Mastra と AI SDK の既定の再試行。spike 枝での読解では、型に `maxRetries` と `ModelWithRetries` がある。
- 層：main（TS）。N-API は既存の contract のまま。Rust は、wire bytes の試験のための test 専用の seam が要るなら足す（製品の公開面は増やさない）。
- 条件：
  - S6 の場面 A〜F と同等の特性試験が、**最新の master で、3 provider のそれぞれについて**現行の args と bytes 一致（S6 `restored`。S6 は Anthropic だけ）。
  - wire bytes（第 8.1 節）が、provider ごとに一致。
  - `satisfies LanguageModelV4` の型検査。
  - **再試行が無い**：失敗する fake の backend で、`doGenerate` が 1 回だけ呼ばれ、audit の complete（failed）が 1 回だけ書かれる。
  - 未配線の adapter が、`validate:architecture`、lint、未使用の検査に当たらない（試験からの参照で通す）。
  - 対象外の provider（Ollama など）は明示的なエラーで、turn 単位で legacy に落ちる。
  - capability の継ぎ目：adapter が応答の capability を tool の `execute` の文脈へ届ける試験。届け方（`providerMetadata` か別経路）は**未確認**なので、最初に小さな試験で確かめる。
  - 3 provider のそれぞれで、adapter の provider 名が中立であること（X13：provider 名が `openai`／`google`／`anthropic` だと attachment の token 数の POST が起動しうる）。
- 旗：製品から参照されない（旗なし）。
- 確認：U-6（決定済み。2026-11-19）。
- 検証：第 8 節の「wire bytes」。

#### MP-2 の結果と判断（2026-11-19）

- 置き場：`electron/main/mastra/`（`agentLanguageModel.ts`、`agentModelPolicy.ts`、`agentWire.ts`）。製品の経路からは参照しない。
- **判断（audit と送信の持ち主）**：adapter は `send` と audit の 4 つ（begin／dispatched／complete／fail）を**注入で受けるだけ**にした。
  N-API の直接呼出し、`callerIdentity`、audit の書き手、capability の発行は MP-3 の owner が持つ（U-4 の (a)〜(c)）。
  注入された audit は doGenerate 1 回ごとに begin → dispatched → send → complete（失敗なら fail を 1 回）の順に呼ばれる。
- **判断（capability の運搬）**：tool-call の `providerMetadata` に載せると Mastra が step の `toolCalls` に残す（**事実**、試験で確認）。
  そのため turn 内の map（`toolCallId` で引く）にし、tool の `execute` が `context.agent.toolCallId` で引く。
  audit の complete に渡す応答からは `agentAuthorityCapabilities` を除いた（現行の `chatApi` は応答全体を渡す。合わせるかは MP-3 で決める）。
- **事実（再試行）**：Mastra 1.83.0 は、`isRetryable:true` の error に対して、既定で model を 3 回呼ぶ。
  `maxRetries: 0`（Agent と call の両方）だけでは 3 回のまま。既定の error processors を `errorProcessorDefaults: false` で外すと 1 回になる。
  固定は `AGENT_NO_RETRY_CONFIG`（`maxRetries: 0`、`maxProcessorRetries: 0`、`errorProcessorDefaults: false`）と `AGENT_CALL_OPTIONS`（`toolCallConcurrency: 1`、`maxProcessorRetries: 0`）。
  call 時の `maxProcessorRetries` は agent の値を上書きするので、call 側にも固定を置く。
  既定の processors は、`isRetryable` が false でも、error の message が ECONNRESET／socket hang up に当たれば再送する（**事実**）。
  また、Mastra は error の `cause` の連鎖から `isRetryable` を読む。そこで adapter の error は、message を kind だけの固定の文にし、元の error を `cause` に載せない（別名の field に持つ）。
  再送を止める正本は固定の設定で、error の形は二重の保険にとどまる。
- **判断（stopReason と tool の実行）**：現行の loop は stopReason が `tool_use` のときだけ tool を実行する。
  adapter も、`tool_use` 以外では tool-call を返さない。Chat Completions では `finish_reason:"stop"` と tool_calls が同居しうるし、Anthropic の `max_tokens` では入力の切れた tool_use が届きうる。
- **事実（中立の名前）**：provider 名か model id のどちらかが anthropic／openai 系だと、tool schema が書き換わる（`additionalProperties`、optional の nullable 化）。
  中立名（provider と model id の両方）で書換えは 0。prompt の書換え（署名つき reasoning の除去、tool id の書換え）は、anthropic 系の名乗りと既定の processors の両方がそろうときだけ起きる。
- **事実（Responses の reasoning）**：summary が空で署名だけの block も、Mastra は落とさない（generate と stream）。順は reasoning → tool-call のまま。
- usage：V4 の写像は route の provider で分ける（Anthropic は total＝input＋read＋write、OpenAI・OpenRouter は total＝input）。台帳と audit には wire の生値を逆算なしで運ぶ。
- stopReason：tool_use→tool-calls、end_turn／stop_sequence→stop、max_tokens／length／model_context_window_exceeded→length、refusal→content-filter、ほかは other（raw を保持）。
- 試験：
  - 特性試験（`src/features/chat/agent/mastraAdapterCharacterization.test.ts`）：本物の `runAgentLoop`＋`chatApi.sendAgentMessage` と、本物の Mastra Agent＋adapter の args を、6 route × 場面 A〜J（H は stopReason が tool_use 以外で tool block が同居する 4 通り、I は結果が null、J は切詰め）で bytes 比較する。
    6 route は anthropic、openai chat／responses、openrouter chat（claude／その他）、openrouter responses。
  - 両経路の生の args は `electron/main/mastra/__fixtures__/wire-args/` に書き出す。更新は `GRIMODEX_UPDATE_WIRE_FIXTURES=1` のときだけ。
  - Rust（`grimodex-ai/src/mastra_wire_parity_tests.rs`）：fixture の args から、送信前の `request_prepared` で最終の body を取る。URL と header は同じ params から組む。current と adapter の bytes 一致を試験する。
    observer は 3 経路とも送信前に発火した（**事実**）ので、製品の組立ては変えていない。
    dev-dependencies で serde_json の `preserve_order` を addon の build と同じ条件にした。陰性対照で、key 順の差が bytes の差になることを確かめた。
- 現行の挙動で気づいた点（MP-2 では直さない）：
  - Chat Completions は `finish_reason` の `length` を `end_turn` に潰す（Responses は `length`）。
  - `redacted_thinking` と OpenRouter の `reasoning_details` は往復しない。
  - Responses は cache の区切りを使わず、`cost` が常に None。
  - Chat Completions は tool_result の `isError` を送らない。
- 未確認：OpenRouter の `cache_write_tokens` が `prompt_tokens` に含まれるか（台帳は生の値なので影響しない）。実 key での送信（U-14／U-18）。
- MP-3 へ渡すこと（MP-2 のレビューから）：
  - audit の `parentExecutionId` の連鎖（`chatTurnStoreActions.ts` は前の executionId をつなぐ）。特性試験は両側とも null に固定している。
  - Mastra の既定の logger は、adapter の error を元の error ごと console に出す。logger の注入が要る。
  - 現行の `chatApi.sendAgentMessage` は、`agentAuthorityCapabilities` を含む応答全体を audit の complete に渡す。ai-audit の writer に redaction があるかは**未確認**。
  - Rust の parity 試験は、TS の特性試験が args の一致を先に強制するので、単独では落ちない。効いているのは陰性対照、route の検査、欄名の drift の検出。napi の変換（`send_agent_message` の中の順序）は試験側の写しで、drift は欄名だけを見る。

### MP-3 loop の骨格（tool 0・memory 0）

- **分割（決定 2026-11-19）**：MP-3 を 3a（土台：build・製品 bundle の ee 検査・asar・env の配線）、3b（閉じた入口：契約・Main の gate L・audit の枠）、
  3c（turn owner・runtime・lifecycle・journey）の 3 PR に分ける。範囲の読み替え（renderer の分岐は MP-4、packaged の検査は MP-13、
  旗 L に Native の entry を足さない）と判断は [MP-3 の判断記録](mastra-mp3-decisions.md)（DR-MP3-n）。以下の範囲・条件は、その読み替えを適用して読む。
- 範囲：
  - main の turn owner。Mastra の `Agent` を、tool 0・memory 無しで 1 turn 走らせる。
  - abort、進捗 event、同じ session の再入の拒否、複数 window。
  - lifecycle（GDX-PRECHECK-001）：
    - egress participant の登録（`electron/main/index.ts:593-603` と同型）。
    - quit finalizer への登録（同 `:678`、`:782`。`electron/main/narrativeMaintenanceShutdown.ts:59`）。
    - closure、inflight 計数、sender の破棄・window close・identity の入替での停止（`nir1LocalGeneration.ts` と同型）。
    - restricted は拒否（`electron/main/profileEgress.ts:286` の `send_agent_message`＝old-external-ai と同じ）。
  - audit の owner の追加（`src/features/ai-verification/aiPathRegistry.ts:51-52`、`:522-574` の `renderer-agent` 4 経路が対象）。
  - typed IPC（開始・停止・event）。sender 無しの callerIdentity 発行（survey §4）。
  - gate L（closed）と journey の seam。
  - env 固定を load 時に適用（第 4.3 節）。遅延 load。
  - 添付つきの turn は legacy に落とす（agent chat が画像・PDF の添付を送る経路を持つかは**未調査**。画像 URL を agent の入力に通さない決定〔X11、X12〕との関係）。
  - Mastra が返す text は全 step の連結（S6）。現行の `finalText` との差の扱いを決める。
  - 文脈の組立（`contextBuilder`）は renderer に残し、IPC で system（segment と tail）・履歴・route を渡す案。agent 経路は非 stream のまま（U-4(j)、(k)）。
  - provider の失敗で、turn が再送を起こさない（再試行しない）。
- 層：renderer（呼出し側の wrapper と engine の分岐だけ）、IPC、main。N-API は既存。
- 条件：
  - gate 閉で、既存の journey が全部緑（`agent-stream-project`、`workspace-switch` を含む）。
  - `ipcContract` の試験、`aiPathRegistry` の試験（新 owner の callsite 検査）、`rendererIsolation.static.test.ts`。
  - main の lifecycle 試験：sender 破棄、window close、restricted の切替、quit、workspace の切替。
  - **製品の bundle で ee の検査**（MP-1 の script）、asar の列挙、`perf:budget`、起動時間。
  - 通信の捕捉：packaged の main で、起動から終了まで宛先 0（P1(b)）。
  - MP-1 のレビューから MP-3 の受入れに送る条件：
    - 製品の build（`electron/scripts/build.mjs`）に ee の stub plugin（`electron/scripts/mastra-ee-stub-plugin.mjs`）を入れる。
    - ee の検査（`electron/scripts/mastra-ee-check.mjs`）を、製品の main・preload・renderer の bundle と、`require()` の経路（`.cjs`）に当てる。
      MP-1 の「製品の main bundle に `@mastra/*` が入らない」検査は、このときその検査に差し替える。
    - `ci.yml` の production build の後に、`dist-electron/main.cjs` とその `.map` を検査する（ee 固有の文字列が 0。目印は ee の実装にだけある文字列）。
    - env 固定の配線先（`electron/main/mastraEnv.ts` の `apply()` を呼び、固定後の `process.env` を読む箇所を `originalEnv()` に切り替える）：
      `cliAi.ts` の `mergedEnv`、`codexAppServer/process.ts`、`vivliostyle.ts:471`、`backend.ts:131`、`ipc.ts:2106`、
      `cliAi.ts:300-330` の opencode の `{env:NAME}`（同じ process の中での読出し）。`env:` を明示しない spawn は、固定後の env を継承する。
    - `originalEnv()` は、固定前の env を凍結して保持する写しであること（呼ぶたびに新しい写しを返し、写しを変えても保持した写しは変わらない）。
    - `release.yml` で `checkPackage`（app.asar の ee の検査）を呼ぶか。今は `packaged-smoke.yml` だけが呼ぶ。
    - picomatch の再判断：`@mastra/core` が `picomatch 4.0.7`（GHSA-fc5q の対象）を直接引く。Mastra が picomatch を利用者の入力に使う経路を調べ、
      `scripts/pnpm-audit.mjs` の例外（期限 12/18）をユーザーに再確認する（2026-11-19 の決定：例外を続け、MP-3 の前に再判断）。
- 旗：L 閉。journey の seam だけが開ける。
- 確認：U-4（U-3 は決定済み）。
- 検証：第 8 節の「通信」「bundle・起動」。
- 注：chat IR S1 の `chat_agent_ir_select` は全 launch で閉じた gate（`electron/main/chatAgentIr.ts`）で、
  確認済みの脅威モデルは renderer の loop を前提にしている。loop が main に移ると受け手が変わる。
  **U-4(f) は、IR を開ける lane へ延期する（2026-11-21 のユーザー決定。DR-MP3-3 どおり）。**
  MP-4 でも chat IR は閉のままで、main の tool に IR を呼ぶ executor が無いことを静的試験で固定する
  （[MP-4 の判断](mastra-mp4-decisions.md) DR-MP4-21）。

### MP-4 tool 基盤、loop 規則、read tool

- 範囲：
  - manifest の 44 本（master で read 26、write 16、destructive 2）を Mastra の tool に。schema は `toolDefinitions.ts` の元の定義（adapter が `$schema`／`additionalProperties` を戻す。S6）。
    **段階に読み替える（2026-11-21 のユーザー決定 U-7(D)。[MP-4 の判断](mastra-mp4-decisions.md)第 1.2 節）**：
    MP-4 は、データ read のうち main の `dbExecute` と既存の Native の typed 呼出しで動く 20 本（M4。`get_codex_entry` は guard の扱い待ちで外す）を main の tool にする。
    `get_ui_state`・`ask_user`・UI 系の write 3 本は MP-5（main→renderer の RPC）、残りの write 15 本は MP-6（`propose_scene_body` は 2026-11-26 の Q4 で MP-5 から MP-6 へ）、`run_research` は MP-4 では移さない（DR-MP3-3）。help 2 本は MP-5 に寄せる（**技術判断**。[DR-MP4-11](mastra-mp4-decisions.md)。2026-11-21）。
    MP-4 の間は main の tool が 44 本そろわず、製品の agent-mode turn（毎 turn 44 本を宣言する）は Mastra に届かない（読み替えの帰結。**報告のみ**。C-5）。旗 L は閉のまま。
  - **loop 規則を同値に写す**（閾値の黙示変更は委任外）：
    - tool 回数の上限（窓に応じて 25／16／12／10。survey の点検は 25／16 だけ確認）、予算（窓の 30%、下限 2,000）。
    - `ask_user` は別枠 8、1 件の結果が予算の 25% を超えたら切詰め、上限到達時に制御 message を 1 回入れてもう 1 度だけ応答。
    - 未宣言 tool の拒否、abort、`beginAgentToolTurn` の turn 単位の分離。
  - **`run_research`（子 agent）**：manifest の 44 本の 1 つ。main の loop から子 loop を走らせる。
    子は `run_research` を持たない（`toolDefinitions.ts:958-963`）。audit の経路は `agent_research_subagent`（U-4(e)）。
    **MP-4 では移さない**（DR-MP3-3。扱いは旗 L を開ける前に決める。[DR-MP4-22](mastra-mp4-decisions.md)）。
  - **read 系 tool の main 化**。
    - **事実**：`src/features/chat/agent/toolExecutors.ts` は renderer の資源に依存する
      （`:6` の `db`＝renderer の Drizzle、`:38` の `useTreeStore`、`:94` の `useProseStagingStore`）。main では使えない。
    - 移す方式は**決定済み（U-7 は (D) 混合。2026-11-21）**：tool の核を共有 module に出し、main から既存の `backend.dbExecute` と
      既存の Native の typed 呼出し（`fts_search`、`codex_semantic_search`、`events_semantic_search`、`foreshadow_list_open_for_context`）で同じ SQL を発行する。新しい N-API は足さない。
    - `countTokens`（tokenizer）が main で動くかは**未確認**（plain Node の probe は動作。Electron main・asar は未確認。置き場と配布は [DR-MP4-18](mastra-mp4-decisions.md)（技術判断。既存の perf budget を超えるときだけ確認 C-8））。
- 層：main。N-API は**新設しない**（U-7 の決定）。renderer は engine の分岐だけ。
- 条件：
  - `agentLoop.test` の特性試験を、legacy と Mastra の**両方**に流して同値。
  - tool schema の bytes 一致（S6 #1〜#3）。
  - **Mastra の入力検証が、変形後の schema で現行と同じ入力を受理・拒否する**（S6 の未測定）。
  - read tool の結果が legacy と同値（fixture 比較）。
  - 長い履歴・大きい tool 結果（S6 の未測定）。
- 旗：L 閉。
- 確認：U-7 は決定済み（2026-11-21）。Q4（4c の wire の契約一式）・Q5（legacy より弱い窓の受容）・C-6・U-8 は 2026-11-24 に回答済み（[DR-MP4-52](mastra-mp4-decisions.md)。Q5 の脅威モデルの確定文書への追記だけは 4c-2 のときに別に確認）。条件つきは [MP-4 の判断](mastra-mp4-decisions.md)の第 8.1 節の C-8・C-9・C-10・C-16・C-17・C-18。回答済みと技術判断へ移した旧確認は第 8.2 節。

### MP-5 main→renderer の RPC と UI tool

- 範囲：
  - main→renderer の request／response の新設。既存の event は一方向（`electron/shared/ipcContract.ts:303-307` の `BACKEND_EVENT_CHANNEL_ALLOWLIST`。renderer の `emit` からは送れない）。
  - renderer に残る 6 本：`ask_user`、`run_app_command`、`apply_layout_preset`、`propose_setting_change`、`propose_scene_body`、`get_ui_state`（survey 付録 A）。
    MP-4 の判断で help 2 本（`get_app_help_index`、`get_app_help`）を足して 8 本にする（[DR-MP4-11](mastra-mp4-decisions.md)。技術判断。2026-11-21）。
    2026-11-26 のユーザー回答（Q4）で `propose_scene_body` を MP-6 に回し、**MP-5 は 7 本**（[MP-5 の判断](mastra-mp5-decisions.md)）。
  - 保留中の renderer 喪失（window close、reload、crash）時の所有と終了証跡。有限の待ち。
  - 同じ session の再入、複数 window。
- 層：renderer、IPC、main。
- 条件：
  - lifecycle 試験：`ask_user` の保留中に window close しても turn が有限の時間で閉じる。
  - IPC の新 contract の試験。`rendererIsolation.static.test.ts`。
- 旗：L 閉。
- 確認：U-8（決定済み 2026-11-24：run の最中に main→renderer へ問い合わせる方式）。
- 代案（U-8。採らない）：RPC ではなく、loop を一度終えて再開する形。

### MP-6 write tool、capability、write 後処理

- 範囲：
  - write 系 tool の main 化（survey 付録 A が挙げる 15 本。`propose_scene_body` を含む。MP-5 から回した 1 本）。
    manifest の read 以外は 18 本（write 16、destructive 2）で、survey の 15 本に UI の 3 本（`run_app_command`、`apply_layout_preset`、`propose_setting_change`）を足した数と合う。
  - **capability（製品認可）の維持**：main の発行（`electron/main/ipc.ts:1595`）と消費（同 `:1682`）を、loop の中で同じ関数で行う。
    one-shot、`senderId`・projectId・入力 digest の束縛を保つ。廃止は製品認可の削除で委任外。
  - write 後処理（store の再読込、undo、timelapse、index の予約）の書き手と永続先。main に移る分は renderer への完了 event。
  - `chatMessageId` と、master の #940 の予約行との整合。
  - `requiresUserConfirmation`（挙動を変えない）。
  - **SessionTasks（Release B）からの接続**（[SessionTasks の判断記録](session-tasks-decisions-2026-11.md)。設計のときに扱う。この段の範囲を決めるものではない）：
    - 承認した範囲での連続実行は ADR 008 の `mutate / task-scope`（Task Grant）で表す。Mastra の承認（`requireApproval`／`beforeApproval`）を「止めて、人が押したら再開する」部品として使う案は候補。`resumeData` とモデル入力の `approved` を根拠にせず、capability は上のとおり main が発行・消費する。mutate・destructive の capability は承認の確定後にだけ発行する（ADR 008 §4）。採る前に mock で確かめ、W12 と DR-MP5-7 の改訂を利用者に確認する（DR-ST-4）。
    - 親の turn の tool 回数の上限（`maxToolCalls`。wire の検証の上限 25 を含む）の撤廃は、この段の後に置く（停止が効く経路から。Mastra の経路は 4c-2 の後。`limit_tokens` や文脈で止まったときの扱いを決めてから。DR-ST-5）。
    - 確認待ちを会話の外に保存する場合の継ぎ目（DR-MP5-11 と W12 の「再起動の後に復元しない」を変える点。保存の範囲の拡大で、利用者の確認が要る。DR-ST-7）。
- 層：main、renderer。
- 条件：
  - **負の試験**：capability 無し、再利用、別 project、別 digest が拒否される。
  - **AWA/1 の移行条件。** 基準は AWA/1 実装後の legacy とする。`update_event`・`delete_event` は、作者の欄への無承認実行、承認の再利用、別 project・別 digest・承認後の版変更を拒否し、N-API に MCP の免除入口がないことを試験する。probe・承認待ち・再判定・一回限りの交換が legacy と同値であることを確認してから両ツールを通す。
  - 承認カードの運び方は U-8 の決定に従う（MP-5 の 8 ツールの外）。CSR/1 N1 以後の再判定は現在の場面に依存しない。U-9 の確認フラグは前倒しせず、将来配線する場合もこの 2 ツールは所有者による判定を優先する。2026-11-23 の確認 141（`nir1-agent-event-write-approval-proposal/1#agent-event-write-approval`）・確認 142（`nir1-agent-event-write-approval-proposal/1#mcp-author-event-write`）。
  - write→read の逐次順序、undoId。
  - write tool を含む turn の journey。
  - `agentAuthorityCapabilities` が落ちて write が通らなくなる回帰が無い（MP-2 の継ぎ目の結合試験）。
  - この MP の後に、**L の journey が全部緑**になること（L 単独で出荷できる地点）。
- 旗：L 閉。
- 確認：U-9（決定済み 2026-11-24：前倒ししない）。

### MP-7 schema と Rust の memory 書込み

- 範囲：
  - migration（`SCHEMA_VERSION` を 1 つ上げる）。現在は 46（`src-tauri/crates/grimodex-core/src/lib.rs:3`。基点 `357e6383` で確認）。
  - `chat_messages.parts_json`、`chat_sessions.mastra_metadata`、新表 3 本（`mastra_resources`、`mastra_observational_memory`、`mastra_memory_vectors`。FK は cascade）。
    DDL は spike の仮案（S-M14）。実物ではない。
  - 新表の clock trigger は migration が自動で付ける（S-M14）。外す選択は新しい契約。
  - `schema-contract.json` の再生成、`PREVIOUS_COMPATIBLE_*` の bookkeeping、D2a の台帳（P18＝`closed`）、`PROFILE_EGRESS_POLICY_VERSION` の扱い。
  - Rust の書込み関数（SQL は Rust が持つ。P9 の条件を製品の実装の要件にする）：
    - upsert は `INSERT … ON CONFLICT DO UPDATE … WHERE（値が変わるとき）`。SET に `role`／`session_id`／`created_at` を入れない。
    - `REPLACE` を含む SQL は 0（lint を製品 crate の試験に）。
    - role が user／assistant／system 以外と、差し込みは skip。
    - version／capture 付きの行は `parts_json` だけ更新。別 session の id 衝突は失敗。
    - 削除は既存の typed writer（`chat_typed_writes`）。
    - 同じ `createdAt` の読みは tie-breaker（`rowid`／`id`）を明示（S-M1）。
    - `deleteMessages(ids)` は、id から session を引いて束ねる。未終了の attempt は `generation-pending` で拒否（S-M14）。
      拒否の写像は `CHAT_WRITE_REFUSED:*` と同形（W3）。
  - N-API の `memory_*` typed command（main 専用。renderer から呼べない）。
- 層：Rust（`grimodex-db`、`grimodex-core`）、N-API、main（配線だけ）、生成物、台帳。
- 条件：
  - **現行の master の schema で、P9 の全 schema 試験（S-M14 と同等の経路）をやり直す**。FK 違反 0、FTS 2 本が本表と一致、clock の増分＝trigger の発火数。
  - 英語 project（#950 の後）と日本語 project の両方。
  - `schema-contract` の parity、D2a の台帳の完全性試験、migration supervisor の試験、Gate A2 の release fixture。
  - backup／restore の試験（新表も戻る。lease と epoch との合成は**未確認**）、project 削除の cascade。
  - clock の増加が read identity／freshness の失効に与える影響の測定（第 8 節）。
- 旗：M 閉。**旗で戻せない**（schema）。
- 確認：U-10、U-11。

### MP-8 TS の storage／vector adapter

- 範囲：
  - `MemoryStorage`（abstract 10、OM 19、resource 4）と `MastraVector`（9）を、N-API を呼ぶ薄い class として。
  - capability の宣言：`supportsObservationalMemory=true`（false のままだと memory 全体が黙って止まる。S-M1）、
    `supportsPartialThreadUpdate=true`（title の省略＝触らない）、`supportsAtomicWorkingMemoryMerge`、run fence の方針。
    `supportsObservationalMemoryHistorySearch`、`listThreadsPaginatesInMemory` の挙動は S-M1 の推測のまま（未実行）。
  - `dangerouslyClearAll` は新表だけを消し、`chat_*` は消さない（S-M1）。
  - thread↔session の写像（`title:''`、`title_manual`、`metadata` の往復）。`nir1-local-*` と restricted は読まない・書かない。
  - tool 本文を保存前に digest にする（`stripBodies`。`providerMetadata.mastra.modelOutput` も除く。S-M7）。
  - `idGenerator`（assistant の応答は引数が空。S-M3）。
  - **vector の `message_id` が storage の統合行の id と食い違う**問題（S-M9 追補）の対処。削除の保証（P3 の vector）の前提。
  - `MemoryRuntimeOwner` の W1・W8（admission、inflight 計数、closure で `ADAPTER_CLOSED`）。
  - turn 内の書込みの束ね方（W3）を、#940 の予約行と整合させる。
  - 1 turn の N-API 往復の削減（S-M2：`getThreadById`×17、`getObservationalMemory`×11、`saveMessages`×5）。turn 内の read cache など。
  - run fence を実装するかの方針（`supportsRunFencing`。InMemory は true、自作の既定は false。S-M1）。
  - typed writer の IMMEDIATE、workspace の lease、turn 終端の 1 transaction との合成（S-M14 の未確認。R-37）。
- 層：main（TS）。N-API は MP-7 の command。
- 条件：
  - S-M1 の差分試験を**実 Rust 版**で（InMemory と同じ操作列）。
  - P9 の条件 (1)〜(3) が、模型でなく製品の adapter で成立。
  - **実 Mastra の呼び順の記録**：stream と generate、`saveMessages` が 1〜8 回、assistant が 1〜2 行、`signal` の有無（S-M3、S-M10 の推測を実行へ）。
  - 並行試験（第 8 節）。
- 旗：M 閉（adapter は試験からだけ呼ばれる）。
- 確認：なし（決定の範囲）。vector の削除の保証が成り立たない場合は U-13 へ。

### MP-9 履歴の持ち主と保存の移動

- 範囲：
  - Mastra が履歴を持つ（P14 の選択肢 1）。renderer は新しい user message だけを渡す。
  - 要約・関連する過去の会話・pin は、system／`context` で渡し保存しない（§13。S-M10）。注入の位置は cache の volatile tail。
  - 保存を main の adapter に移す。engine＝mastra の turn では、renderer の `persistUser`／`persistAssistant`
    （`src/application/chat/chatTurnStoreActions.ts`。呼出しは複数か所〔基点で 4 組〕。MP-9 の着手時に列挙する）を呼ばない。二重保存を作らない。
  - timelapse の予約の移動（書き手が main に移る。設計 §2）。
  - NIR-1 の capture の作成順（user 行の INSERT の後に Rust が capture を作る流れ。**未試験**。S-M14）。
  - 既存 session の OM の seed（`observedMessageIds` に既存 id を入れる。S-M5）。
  - renderer が DB の行を再読込する経路。A/B 採用、`is_starred`、`thinking_blocks`、tokens／duration／model の写像。
  - semantic の二重 embedding（`chat_message_chunks` と `mastra_memory_vectors`）の併存か統合。
  - ~~圧縮しても消えない「目的欄」（会話ごとの目的と条件。[MP-4 の判断](mastra-mp4-decisions.md) DR-MP4-57 の 3。内容は SessionTasks の結論で変わりうる）。~~ 2026-11-26 に取り下げ（利用者の回答。[SessionTasks の判断記録](session-tasks-decisions-2026-11.md) の DR-ST-9）。
  - **SessionTasks（Release B）からの接続**（[SessionTasks の判断記録](session-tasks-decisions-2026-11.md) の DR-ST-7。設計のときに扱う）：続行のときに読んだ内容を引き継ぐ形（続行を出す条件は wire の P14 の Q4 と renderer）。SessionTasks の Task は Native の独立した表に置き、Mastra の thread metadata には置かない（ADR 007 §2・§4）。作者が書く目的欄は作らない（DR-ST-9）。前の回の tool の結果を全部残す形は、比較実験で質が下がったので、そのままは採らない（DR-ST-1）。
- 層：renderer、main。
- 条件：
  - gate M 閉で、既存の journey が全部緑。
  - M 開の journey：2 turn、tool 往復、再送、再生成、message 削除、A/B 採用。
  - **NIR-1 の capture が、本物の人の入力でだけ superseded** になる（差し込みでは発火しない）。
  - request の bytes と cache の先頭の安定性（tools→system が動かないこと）。
  - 旗 on の間に書いた行（assistant の 2 行分割、`data-om-*` の part）を、旧経路が読める（第 10 節）。
- 旗：M 閉。
- 確認：U-12。

### MP-10 背景 LLM・embedding・OM の構成

- 範囲：
  - route 4 本の登録（P7）：`memory_observer`、`memory_reflector`、`memory_title`、`memory_embedding`。audit の executable contract test（GDX-AI-AUDIT-001）。
  - `memoryModel` の解決（空なら主 model）。Mastra へ渡す model と embedder は object だけ。文字列 id は型と実行時の両方で禁止。
  - embedder はローカル ONNX。**事実**：既存の N-API に任意の text を埋め込む command は見当たらない（`index.d.ts` の semantic 系は scene の索引・検索と、保存済みの chat message の索引〔`chatIndexMessage`〕だけ）。
    新設が要る（P8 の `memory_*` の範囲）。
  - 言語ごとの model と次元（`embeddingDimension` を明示）。model が未 download のときの縮退。次元の不一致は保存が失敗する（S-M9）。
  - OM と memory の構成：
    - `bufferTokens:false`、`retrieval:false`、`observeAttachments:false`、`workingMemory.agentManaged:false`。
    - `bufferOnIdle` を off にする形（X2。**未確認**）。
    - semantic recall は thread scope。WM は resource、template は嗜好と文体だけ（P13）。
    - **既定値に頼らず全部を明示する**（既定は版で変わりうる。第 11 節）。
  - attachment を memory に通さない。URL 画像を agent の入力に通さない（X11、X12）。
  - env 固定を load 時に適用。
- 層：main、N-API、registry。
- 条件：
  - 4 route が audit の begin 行なしでは Native に拒否される試験。
  - 文字列 id を渡すと失敗する試験。
  - **未実行の 2 点を実行で確認**：`agentManaged:false`（X5）、PDF の `observeAttachments:false`（P6 の受入れ条件）。
  - 通信の捕捉：宛先は利用者の provider だけ（ローカル embedding は端末の外へ出ない）。
  - 題名生成と同 turn の step 間 observer の prompt に tool 本文が入る点（P5(c) の暫定）の現状。
  - 実 provider の遅延の測定（P11 の材料。第 8 節）。
- 旗：M 閉。
- 確認：U-14、U-15。

### MP-11 lifecycle（closure、quit、削除時の purge）

- 範囲：W4〜W7、W9、W10（[脅威モデル](mastra-migration-threat-model.md)の第 4 節）の実装。
  - closure、inflight 計数、`T_quit`（暫定 5 秒。P11）、quit finalizer と workspace 切替の participant 登録。
  - AbortSignal が届かない仕事（題名、embedding、背景 observer。S-M6）は、ambiguous の audit 行で閉じる。`settled()` は終了証跡にしない（X22）。
  - flag（`isObserving` など）の stale 回復（S-M5）。
  - **message 削除時の purge**（§13、P4(a)）：削除した範囲に由来する OM の部分だけを消し、再構築はしない。
    - **未設計**：OM は 1 つの text の log で、message 単位の由来の対応が無い。部分削除の方式は U-13。
    - WM は由来の対応が無い。message の削除時に WM をどうするかも U-13。
  - project 削除で WM と OM を必ず消す（P3(c)。新表の cascade。S-M14）。
  - restore との整合（DB と一緒に戻る）。
- 層：main、Rust。
- 条件：
  - 閉じた後に起動済みの仕事が残らない：inflight 0、audit の terminal、Native の terminal receipt。
  - reflector の背景経路の abort、quit 時の `settled()` の timeout（S-M6 の推測を実行へ）。
  - restricted の切替と workspace の切替で止まる。
  - quit で ambiguous になった件数を audit から数える。
  - 削除→purge の journey。
- 旗：M 閉。
- 確認：U-13、U-14。

### MP-12 設定・WM の UI・開示・consent

- 範囲：
  - typed IPC と renderer（P8(a)）：memory の機能ごとの on／off、`memoryModel`、WM の閲覧・編集・消去、観測の消去。
  - 開示と consent（GDX-AI-CONSENT-001）：policy version、route、provider、実際の接続先に束縛。送る内容、保存、費用、制御、spoiler（設計 §4.4）。
  - 縮退の事実を UI に出す（P12(a)）。
  - MCP に出さない（P17(a)）。zip export に OM・WM を含めない（P3(a)）。backup には自動で含まれる。
- 層：renderer、IPC、main、N-API。
- 条件：
  - `add-electron-command` の手順と `ipcContract` の試験。main で引数を再検証。restricted で拒否。
  - consent が無いと背景の route が動かない試験。
  - `buildArchive.ts`／`chatSerializer.ts` が、OM・WM の表（`mastra_resources`、`mastra_observational_memory`）を出さない試験。
    vector の扱いは U-19。
- 旗：M 閉。
- 確認：U-15、U-19。

### MP-13 旗を開ける

- **13a：L**（MP-6 の後ならいつでも可。M を待たない。ただし下の追加の条件〔問 42〕を満たした後）。**13b：M**（MP-12 の後）。それぞれ製品公開に当たる。
- 範囲：
  - gate の開放、または `engine` の既定の変更。
  - **P11 の確定**：実 provider の遅延の測定の後に、改めて伺う（P11）。
  - 公開前の検査：packaged の build（3 OS の packaged smoke）、通信の観測（15 分間隔の usage telemetry を含む長さと、終了時）、ee の検査、asar の列挙。
  - SPEC・設計書の更新、`THIRD_PARTY_LICENSES.md` の最終確認、release notes（公開向けの文章は Draft で停止）。
- 条件：Release の経路（Full と verify。GDX-TRACE-001）。第 10 節の停止条件のどれにも当たらない。
- 条件（追加、2026-11-28、contracts の問 42）：旗 L は、承認待ちからの出し直しと、生成の途中からの再開の両方がそろってから開ける（切り替えの許可ではない）。再開は DR-A3-8 のとおり MP-9 と再入の実装が前提。再入の実現性は偽の provider の試験で「条件つきで可能」：途中の状態を CoreMessage に組み直して `Agent.generate` を呼び直すと、監査の executionId を除いて、中断しない場合の次の要求と一致した。再開の入力（tool の呼出しと結果を含む履歴）と計数（step・tool の回数・token・上限の状態）の復元は未実装。実 provider、中断の瞬間の副作用、複数の鍵を持つ tool の入力の順序は未確認。
- 確認：U-16、U-17、U-18。

### MP-14 legacy 経路の撤去

- この計画の外。旗 on の運用の結果を見て、別に伺う。

## 7. ユーザーの確認の一覧

区分：**送信先**（新しい送信先）、**保存**（保存範囲）、**contract**（新しい契約）、**authority**（認可・権限）、**挙動**（利用者に見える挙動）、**公開**。
「推奨」は、根拠のあるものだけ。無いものは「なし」。内訳は表の下（第 7.1 節）。

**決定済み（2026-11-19）**：U-2、U-3、U-5、U-6（第 1.1 節）。次の表は、各 MP の前に伺う残りの項目。

| ID   | 前の MP | 確認すること                                          | 区分                | 推奨             |
| ---- | ------- | ----------------------------------------------------- | ------------------- | ---------------- |
| U-1  | 1       | 脅威モデルの確認と凍結（**確定 2026-11-19**）         | contract            | -                |
| U-4  | 3       | loop 移動の未決一式                                   | authority、contract | 内訳に           |
| U-7  | 4       | read tool の main 化の方式（**決定 2026-11-21：(D) 混合**） | contract            | -                |
| U-8  | 5       | UI tool を RPC にするか（**決定 2026-11-24：run の最中に main→renderer へ問い合わせる方式**） | contract、authority | なし             |
| U-9  | 6       | write 後処理の書き手の移動（**決定 2026-11-24：確認は前倒ししない**） | 保存、authority     | 前倒しはしない   |
| U-10 | 7       | `SCHEMA_VERSION` の bump                              | 保存、contract      | 13a の後に載せる |
| U-11 | 7       | D2a の class の適用範囲                               | authority           | なし             |
| U-12 | 9       | P14 の既存機能の行方                                  | 挙動、contract      | なし             |
| U-13 | 11      | OM・WM の削除時の扱い                                 | 保存、挙動          | なし             |
| U-14 | 10、11  | 実 provider での測定と P11                            | 送信先、挙動        | 先に可否を伺う   |
| U-15 | 10、12  | 開示・consent・保持期間                               | 保存、送信先        | 保持期間はなし   |
| U-16 | 13      | 旗を開ける                                            | 公開                | なし             |
| U-17 | 13      | SPEC の「Vercel AI SDK」の修正                        | 公開                | なし             |
| U-18 | 13      | 実 key での M13(a)（**承認 2026-11-19、受入れ条件**） | 送信先              | -                |
| U-19 | 12      | vector の export の範囲                               | 保存                | なし             |

- **注**：P2 の回答は(a)「実測なしで、止める条件を要件にする」。
  鍵ありの M13(a) の測定は、実在の provider へ送る行為になりうる。
  この緊張のため、既定は**ダミー key と偽の接続先**（P2(b)。実在の provider へ送らない）にし、MP-1 に入れた。実 key は U-18 に残す。
- 確認が未了の MP は `[precheck]` で止まる。

### 7.1 内訳

#### 決定済み（2026-11-19）

- **U-2**：docs は master に入れる。ただし計画書だけで、移行の計画、脅威モデル、lifecycle に限る。
  ee の license の条文の引用と法的な読解、spike の実行の記録は入れない。
- **U-3**：PR の分け方と順序（MP-0〜13）、旗が closed gate 2 本（L と M）であること、開けるのは journey の seam だけであること、を承認。
  - 付随して残る点：新しい `PrePublicationEntry`（L、M）の追加が、新しい authority に当たるか。
    承認がこれを含むかは**未確認**。MP-3 の前に確かめる。
- **MP-3 の分割と範囲**：3a／3b／3c の 3 PR。env は Grimodex 自身の owner token 5 名だけを実名で除かない。picomatch の例外（期限 12/18）は続け、
  Mastra の workspace を有効にしない検査を入れる。判断の正本は [MP-3 の判断記録](mastra-mp3-decisions.md)。
- **U-5**：依存の追加（`@mastra/core`、`@mastra/memory`）、`pnpm install`、`THIRD_PARTY_LICENSES.md` の更新を承認。version の更新は手動だけ。
  env の固定は、load の時だけ適用し、子 process には元の env の写しを渡す（推奨どおり）。
- **U-6**：最初から主要な provider すべて（Anthropic、OpenAI、OpenRouter）に対応する（推奨の「Anthropic から」ではない）。
  Ollama などは対象外で、今の経路のまま残す。
  OpenAI 系の usage の会計、Responses API の thinking と署名、OpenRouter の差は、MP-2 で確かめる項目（第 6 節 MP-2）。

#### 残りの項目

- **U-1**：脅威モデル（[脅威モデル文書](mastra-migration-threat-model.md)の X1〜X23、T 系、必須の防御、残るリスク、W1〜W10）。
  第 12.1 節の回答（P1〜P18）が脅威モデルの確認を兼ねるかが不明。兼ねないなら、最初の変更（MP-1）の前に 1 回。
  伺う点は同文書の「U-1 で確かめる点」。
- **U-4**：loop 移動の未決。survey の「設計上、ユーザー確認が要る追加の問い」（第 4 節の末尾）で、P1〜P18 の外。
  - (a) capability（senderId 束縛）の扱い。推奨：維持。廃止は製品認可の削除で委任外。
  - (b) sender 無しの callerIdentity の発行。
  - (c) 新しい `AiAuditOwner`。
  - (d) 新しい typed IPC。
  - (e) 移す呼出し元の範囲：main chat、`run_research` の子 agent、Context Creator、live harness。
    - `run_research` は manifest の 44 本の 1 つ（read。`agent-tool-manifest.json:43`、`toolDefinitions.ts:792`）で、
      子 loop を走らせる。audit の経路は `agent_research_subagent`（`aiPathRegistry.ts:537`）。main の loop から子 loop をどこで走らせるかが要る。
    - 推奨：main chat だけを先に（Q2）。ただし子 agent の扱いは MP-4 で決める。
  - (f) chat IR S1 の確認済み脅威モデルの再確認（受け手が main の loop に移る）。**延期（2026-11-21 のユーザー決定）**：IR を開ける lane で行う。MP-4 は IR を閉のままにし、静的試験で固定する。
  - (g) restricted の扱い。推奨：今と同じ拒否。
  - (h) `browser-mock.ts` の loop を残すか。
  - (i) 添付つき turn の扱い。推奨：legacy に落とす。
  - (j) 文脈の組立（`refreshContextLayers`、`contextBuilder`）を renderer に残すか。残すなら、新しい IPC で何を main に渡すか。
  - (k) agent 経路を stream にするか、非 stream のままか（今は非 stream の invoke。abort の IPC が無い）。
- **U-7**：read tool の main 化の方式。**決定済み（2026-11-21）**：(D) 混合。共有 core＋既存の `dbExecute` と typed 呼出しで、新しい N-API は不要。`get_ui_state`・`ask_user` は MP-5 の RPC、help 2 本は RPC（技術判断。[DR-MP4-11](mastra-mp4-decisions.md)。2026-11-21）。tokenizer の置き場は [DR-MP4-18](mastra-mp4-decisions.md)（測定の後に確定。既存の budget を超えるときだけ C-8）。
- **U-8**：UI tool（8 本。help 2 本を含む）を、main→renderer の RPC にするか、loop を一度終えて再開する形にするか。renderer 喪失時の扱い。**決定済み（2026-11-24）**：run の最中に main から renderer へ問い合わせる方式。renderer が閉じたときは有限の時間で終わらせる（[DR-MP4-52](mastra-mp4-decisions.md)）。
- **U-9**：write 後処理（undo、timelapse、index の予約）の書き手と永続先が main に移ること。`requiresUserConfirmation` を前倒しするか（推奨：しない）。**決定済み（2026-11-24）**：前倒ししない（[DR-MP4-52](mastra-mp4-decisions.md)）。
- **U-10**：`SCHEMA_VERSION` の bump。旧版では DB を開けなくなる一方向の変更。どの release に載せるか。推奨：L の単独出荷（13a）の後。
- **U-11**：
  - D2a の class の適用範囲。P18＝`closed` は決定済み。
  - 既存表 `chat_messages` の列 `parts_json` を、列単位で `closed` にできるか（**未確認**）。
  - `PROFILE_EGRESS_POLICY_VERSION` の扱い。
- **U-12**：P14 の既存機能の行方（P14 の回答が「実装の前に別に伺う」とした）。
  - `chat_summaries`、`chatRecall`、pin、`chat_message_prompts`。
  - 窓・予算・cache・prompt snapshot の契約をどう保つか。
  - semantic の二重 embedding（`chat_message_chunks` と `mastra_memory_vectors`）。
- **U-13**：P4(a) の実現方式（OM の部分削除）。message 削除時の WM の扱い。vector の削除の保証が成り立たない場合。
- **U-14**：実 provider での測定（利用者の key の使用と費用）。測定の後の P11（`T_quit`）の改定。
- **U-15**：開示の文面と consent。保持期間（P16：**推奨なし**）。tool 本文が observer と題名に入る点（P5(c)）の要件への昇格の時期。Mastra 同梱の prompt を使うか。
- **U-16**：旗を開ける（製品公開）。既定 on か opt-in か。L の単独出荷の可否。
- **U-17**：SPEC と設計書の「Vercel AI SDK」の記述の修正の方針（`docs/SPEC.md:21`、`:233-240`、`docs/Grimodex_AIエージェント設計書.md:9`、`:634` ほか）。
- **U-18**：実 key での M13(a) の測定（P2(c)）。やる場合のみ。
- **U-19**：vector の「export に含める」（P3、X7 の決定）が zip export を指すか（**未確認**）。
  - 指すなら、`buildArchive.ts`／`chatSerializer.ts` に vector を出す実装が要る。vector の metadata には message の本文（chunk）が入る。
  - OM・WM は zip export に含めない（P3(a)）。

## 8. 検証と測定

### 8.1 wire bytes（MP-2）

- **事実**：S6 は wire の bytes を測っていない。`.node` が未 build で、`build_anthropic_agent_body` が private だったため。
  args が同一なら body も同一という**推論**だけ（`src-tauri/crates/grimodex-ai/src/lib.rs` の body 組立てが純関数であることの読解）。
- 方法：Rust の crate 内の試験（private 関数に触れられる）で、固定の args から body を作り、snapshot と比べる。
  args の fixture は、現行の経路と adapter の経路の両方（S6 の `out/current-*.json` と `out/mastra-*-restored.json` の型）から作る。
- 受入れ：全場面で、**3 provider のそれぞれ**の body が同一（U-6）。
  Anthropic は `build_anthropic_agent_body`。OpenAI の Responses API の入力は `ai_responses.rs` の `build_agent_input` と読めるが、
  どの provider がどの組立てを通るか、OpenRouter の組立てはどれかは、MP-2 の着手時に特定する（**未確認**）。
- 製品の公開面は増やさない（test 専用）。

### 8.2 通信（MP-1、MP-3、MP-10、MP-13）

- 目的：「通信 0」の主張を、hook が捕まえる経路だけに限らない。
- **事実**（S3 の訂正 2、S-M8）：spike の hook は、hook の前に握った `fetch`、bundle 外の `require("undici")`、global `WebSocket`、`dgram`、`dns.Resolver`、Worker 内を捕捉しない。
- 手順：
  - hook の自己試験を毎回付ける（対象範囲を記録する）。env 有・無の対照を持つ。
  - packaged の main で、起動から終了までを、OS 側の捕捉でも観測する（P1(b)）。**推測**：実装は `ss`／`strace` 相当。
    3 provider 対応では、同じ宛先（`api.openai.com`、`api.anthropic.com` など）に、Rust 経由の正規の送信（利用者の provider）と、
    Node（Mastra）から出る直接の通信の両方が現れうる。process と socket の所有で区別して記録する（**未確認**。方法は MP-1 の通信の試験で決める）。
  - 観測の長さは 15 分間隔の usage telemetry を含む（S3 訂正 4。spike は 1.5 秒しか見ていない）と、終了時を含む。
  - `gateway-api.mastra.ai`（`MASTRA_GATEWAY_API_KEY` 設定時だけ有効。S3 訂正 3）。文字列 id を使わないことと、key が無いことの確認。
- **file 書込み**（X18）：走行の前後で HOME・cwd・TMPDIR のファイル差を取る（`om-debug.log`、`.mastra-om-repro`、`<cwd>/dist/...`。S2 と同じ方法）。
- **M13(a)**：ダミー key を env に置き、hook の下で、固定なしの対照と固定ありを比べる（MP-1）。実 key は U-18。
- 対象の宛先：`api.openai.com`、`api.anthropic.com`、`generativelanguage.googleapis.com`、`ai-gateway.vercel.sh`、`gateway-api.mastra.ai`、`us.posthog.com`、`license.mastra.ai`、`models.dev`、画像 URL のホスト（X11〜X17）。

### 8.3 実 provider の遅延と P11（MP-10、MP-11、MP-13）

- 測るもの：observer、reflector、題名、embedding の P50／P95。quit 時に ambiguous になる件数の割合。
- **事実**：spike の遅延は fake（`settled()` が 613 ms で解決。S-M6）。実測は無い（P11）。
- 手順：測定の可否を先に伺う（U-14）。実施するときは、Rust 経由で利用者の provider を使い、費用を記録する。
- `T_quit` は暫定 5 秒（案 C）のまま MP-11 まで進め、MP-13 の前に、測定の結果を添えて改めて伺う（P11）。
  既存の 30 秒の予算（`narrativeMaintenanceShutdown.ts:59`、`profileEgress.ts:80`）の内側に収める。

### 8.4 clock と失効（MP-7、MP-8、MP-9）

- **事実**（S-M14）：1 turn で clock は +10（chat と NIR-1 だけなら +6）。これは模型の通しの値で、実 Mastra の保存回数で増える（1〜8 回）。
  clock は `read_identity` と freshness の失効の合図なので、Graph／IR の登録の窓との重なり（lapse）に**影響しうる**。**未測定**。
- 測り方：既存の dev の harness を使えるか（**未確認**）。使えなければ、clock の増分と、registration の窓に重なる確率の見積りを MP-7 で作る。
- **閾値は緩めない**（確認台帳の現行の閾値。委任外）。超えるなら、adapter の書込みの束ね方の変更から検討する。
  clock の対象から新表を外す案は、core の関数の変更で新しい契約になる（U-11 と合わせて伺う）。
- 読み手の列挙：`read_identity.rs`、`incremental_freshness.rs`、`execute` の authorizer、`backup_restore`、MCP、post-effect。

### 8.5 並行性（MP-8、MP-11）

- 接続は Rust の 1 本の `Mutex<Connection>`（C-1。設計 §1.2）。adapter の呼出しは同じ接続を使うので、競合は待ち行列になる。**推測**。
- 試験：
  - 複数 session・複数 window の同時の turn、同じ session の二重 send の拒否。
  - 背景の書込み（observer、vector）と前景の transaction の重なり。`SQLITE_BUSY_SNAPSHOT` の件数と待ちの分布。
  - 1 turn の N-API 往復の回数と、legacy との turn の遅延の差。
  - 背景の checkpoint との相互作用（`background_checkpoint.rs`）。
- 受入れの値は、測定の結果から導く（固定値を先に置かない）。

### 8.6 bundle・起動・memory（MP-1、MP-3、MP-13）

- main の bundle の大きさ、起動時間（cold と warm）、`perf:budget`。`electron/scripts/process-memory.mjs` で main の RSS。
- packaged：asar の列挙、署名・公証、`import.meta` が空になる影響（`getPackageRoot` が cwd に落ちる。S2）、`MASTRA_DEV` を設定しないこと。
- 3 OS の packaged smoke（`electron/scripts/packaged-smoke`）。

### 8.7 journey

- 既存：`agent-stream-project`、`workspace-switch`（survey の点検記録）。
- 新設の案：
  - **J-L**：Mastra の loop の turn。read tool、write tool（capability）、`ask_user`、abort、restricted の切替、workspace の切替、turn 中の quit。
  - **J-M**：memory の turn。2 turn、OM の閾値、WM の編集、message の削除と purge、quit と背景の仕事、backup と restore。
- journey の待ちは、新しい durable id とその UI の投影が出るまで（`iron-laws.md` の immutable identity の節）。

## 9. リスクと、まだ未確認のこと

spike で未確認のものを、どの MP で確かめるかに割り当てた。出典の `S`・`M`・`X` は第 0 節。
X1〜X23 の「未確認」のセルは、R-8（通信）、R-13〜R-17、R-35、R-36 に束ねた。割当てが「対象外」のものは第 12.2 節。

| ID   | 内容                                                                                                                     | 区分         | 出典                          | 割当て                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------- | ----------------------- |
| R-1  | packaged の build（asar、署名、公証、`import.meta`）                                                                     | 未確認       | S2 未確認 1                   | MP-1、MP-3、MP-13       |
| R-2  | 実 Mastra の呼び順（保存 1〜8 回、行分割、`signal`、stream、`messageHistory.maxTokens`）                                 | 未確認       | S-M3、S-M10                   | MP-8                    |
| R-3  | clock の増加が Graph／IR の失効に与える影響                                                                              | 未確認       | S-M14                         | MP-7、MP-8、MP-9        |
| R-4  | 並行性（別接続、WAL、busy、背景と前景の重なり）                                                                          | 未確認       | S-M14                         | MP-8、MP-11             |
| R-5  | `agentAuthorityCapabilities` が adapter で落ちる                                                                         | 事実（読解） | S6                            | MP-2、MP-6              |
| R-6  | wire の bytes                                                                                                            | 未測定       | S6                            | MP-2                    |
| R-7  | 実 provider の遅延と `T_quit`                                                                                            | 未測定       | P11                           | MP-10、MP-11、MP-13     |
| R-8  | hook の盲点、15 分間隔の telemetry、gateway、ee の bridge、`child_process` の全 call site                                | 未確認       | S3 訂正 2〜4、6、X19、X20     | MP-3、MP-13             |
| R-9  | M13(a) の key あり                                                                                                       | 未確認       | S-M8                          | MP-1（ダミー）、U-18    |
| R-10 | URL 画像の download、user の file part（添付）                                                                           | 未確認       | M13、X12、S6                  | MP-3、MP-10             |
| R-11 | ee：stub が `undefined` を返す名前を、非 ee 側が呼ぶ箇所（版ごとに変わりうる）                                           | 未確認       | S2 訂正 11                    | MP-1、第 11 節          |
| R-12 | `server.fga` を使う構成では stub が合わない                                                                              | 事実         | S2                            | 使わない（第 11 節）    |
| R-13 | tool 本文が題名と同 turn の observer に入る                                                                              | 未確認       | S-M7                          | MP-10                   |
| R-14 | `agentManaged:false`、PDF の `observeAttachments:false`                                                                  | 未実行       | X5、P6                        | MP-10                   |
| R-15 | vector の `message_id` の食い違い（削除の保証）                                                                          | 原因は未確定 | S-M9 追補、S-M12              | MP-8、U-13              |
| R-16 | OM の部分削除の方式、WM の扱い                                                                                           | 未設計       | P4、X10                       | MP-11、U-13             |
| R-17 | 題名・embedder の計数、背景 reflector の abort、`settled()` の timeout、flag の stale 判定                               | 未確認       | S-M5、S-M6、脅威モデル第 4 節 | MP-11                   |
| R-18 | tool schema の変形後の入力検証、tool_result の null・truncation                                                          | 未測定       | S6 #1〜#2                     | MP-4                    |
| R-19 | loop 規則（回数・予算・`ask_user`・切詰め・制御 message）の同値                                                          | 未測定       | S6                            | MP-4                    |
| R-20 | `finalText` と、全 step の text の連結の差                                                                               | 事実         | S6                            | MP-3                    |
| R-21 | OpenAI・OpenRouter の usage 会計・Responses API の thinking と署名・差、`webSearch`／`apiVariant`、citations、`doStream` | 未確認       | S4、S6、U-6                   | MP-2                    |
| R-22 | 英語 project の `_en` FTS（#950 の後の挙動）                                                                             | 事実（推定） | S-M14、#950                   | MP-7                    |
| R-23 | NIR-1 の capture の作成順                                                                                                | 未試験       | S-M14                         | MP-9                    |
| R-24 | 並行 lane（chat IR S1、model-caps）が agent 経路を触っている                                                             | 事実         | 第 2 節                       | MP-3〜MP-6 の順序       |
| R-25 | `chat_agent_ir_select` の脅威モデルが renderer の loop 前提                                                              | 事実         | survey §4                     | 延期（IR を開ける lane。MP-4 は静的試験で閉を固定。2026-11-21 決定） |
| R-26 | embedding の言語ごとの model と次元、model 未 download                                                                   | 未確認       | S-M9                          | MP-10                   |
| R-27 | 同梱の observer／reflector／題名の prompt の質（日本語の小説）                                                           | 未確認       | -                             | MP-10（U-15）           |
| R-28 | 旗 off で env の固定が子 process に及ぶ                                                                                  | 事実         | 第 4.3 節                     | MP-1（U-5）             |
| R-29 | 旗を再び on にするときの OM の seed                                                                                      | 事実         | S-M5、X9                      | MP-9、第 10.2 節        |
| R-30 | `new Mastra` の "in-memory" の警告。domain を `false` にする構成                                                         | 事実         | S-M3                          | MP-8                    |
| R-31 | tokenizer（`countTokens`）が main で動くか（plain Node の probe は動作、約 163 ms。Electron main・asar・配布は未確認）    | 未確認       | survey §4、mp4-decisions DR-MP4-18 | MP-4                    |
| R-32 | `data-om-*` の part と assistant の 2 行分割の読み手                                                                     | 推測         | S-M2、設計 §1.4               | MP-9                    |
| R-33 | vector の「export」が zip export を指すか                                                                                | 未確認       | P3、X7                        | MP-12（U-19）           |
| R-34 | Mastra／AI SDK の `doGenerate` の自動の再試行と model の fallback                                                        | 未確認       | S-M6、脅威モデル第 4 節       | MP-2、MP-3              |
| R-35 | 背景仕事の失敗時（observer、reflector、題名、embedding、WM の更新）の挙動                                                | 未確認       | X1、X3、X5、X6、X9            | MP-10、MP-11            |
| R-36 | file 書込み（`OM_DEBUG`、`OM_REPRO_CAPTURE`、cwd 相対）                                                                  | 読解のみ     | X18、M14                      | MP-1、MP-3（第 8.2 節） |
| R-37 | typed writer の IMMEDIATE、lease、turn 終端の 1 transaction の合成                                                       | 未確認       | S-M14 未確認                  | MP-7、MP-8              |
| R-38 | 保存の束ね方（W3）と、master の #940 の予約行の整合                                                                      | 未確認       | S-M11、#940                   | MP-8                    |

## 10. やめる条件・戻す条件

### 10.1 停止条件（見つかったら、その MP を merge せず、次へ進まない）

- ee の検査が落ちる、または asar に ee の実体がある（MP-1、MP-3、MP-13）。
- 通信の観測で、利用者の provider 以外の宛先が出る、または Rust を経由しない本文の送信が出る。
- wire の bytes が一致しない。または cache の先頭が動く（MP-2、MP-9）。
- 全 schema 試験で FK 違反・FTS の不整合・予期しない削除（MP-7）。
- capability の負の試験が通る（拒否されない）（MP-6）。
- clock の増加で、Graph／IR の失効が確認台帳の現行の閾値を超える（第 8.4 節）。**閾値は緩めない**。
- 閉じた後に起動済みの仕事が残る、または quit が既存の 30 秒の予算に収まらない（MP-11）。
- 新しい Mastra の version が、ee を必須にする、license を変える、検査を通らない（第 11 節）。
- `perf:budget` と起動時間の予算を超える。超える分を、機能を削るより先に、遅延 load で減らす。緩和が要るなら独立した commit で、確認してから。

### 10.2 旗での戻し（旗を開けた後）

1. 新しい turn の engine を legacy にする（`engine` の設定、または gate を閉じる patch）。実行中の turn は、終端まで走らせるか abort する（途中で切り替えない）。
2. `MemoryRuntimeOwner` を closed にし、inflight 0、audit の terminal、Native の terminal receipt を待つ。
3. **旧経路が、旗 on の間に書いた行を読める**ことを journey で確認する。
   C-1 は `content`（text）と `metadata` の `tool_calls`／`thinking_blocks` を今の形で書くので、読める見込み（**推測**。MP-9 で確かめる）。
   assistant の 2 行分割と `data-om-*` の part は `parts_json` にだけある。
4. データ：WM、OM、vector、`parts_json` は残して使わない（P16(a)）。消去は MP-12 の「消去」の入口。
5. 再び on にするとき：旗 off の間に増えた message は OM が未観測。初回の大量の observer 呼出しを避けるため、seed（S-M5）を再実行する。

### 10.3 戻せないもの

- **schema の migration（MP-7）**：旧版は DB を開けない（`migrate.rs:469-472`）。additive の列と表は残し、`DROP COLUMN` はしない。
- したがって、**移行をやめる判断は MP-7 の前が安い**。MP-1〜MP-6 は、コードの revert で戻る。
- MP-7 の後にやめる場合：旗を閉じたままにし、新表と列は未使用で残す。

## 11. Mastra の version を上げる手順

pin は exact。自動更新（Dependabot など）の対象から外し、手動だけで上げる。

1. **差分の調査**：changelog、`engines`、peer の範囲（`@mastra/memory` は `@mastra/core >=1.83.0-0 <2`）、依存の増減、
   新しい `MASTRA_*` の env と、dist の新しい endpoint（grep）。
2. **ee の検査**：ee の chunk の名前は版ごとに変わる（hash）。
   - 素の bundle で ee の chunk を検出し、stub が当たることを確認する（検査 script と、陰性対照）。
   - stub の自己試験：公開名の欠けが 0、`requireFGA`／`checkFGA` が provider ありで throw、`StaticRBACProvider` が throw。
   - `@mastra/memory` の dist に ee の chunk が入っていないこと。新しい `ee/` ディレクトリ（他の package のものを含む）が増えていないこと。
   - 製品の bundle の metafile と、asar の列挙。`dist/license/index.js`（`LicenseClient`）の扱い。license key の env を設定しないので接続しないこと（X16）。
   - stub が `undefined` を返す名前を、非 ee 側が呼ぶ箇所が増えていないこと（R-11）。
3. **通信**：S3／S-M8 の走行を、hook の自己試験つきで再実行し、packaged の観測（第 8.2 節）。
4. **adapter の適合**：`MemoryStorage` の abstract の増減（型検査）、S-M1 の差分試験（実 Rust 版）、capability の宣言。
5. **S6 の parity**：tool schema の変形（`$schema`、model id 依存）、key 順、wire bytes。
6. **P9 の全 schema 試験**と、保存の回数・`signal`・`idGenerator` の観測（MP-8 の試験を再走）。
7. **既定値の差分**：OM の `bufferTokens`、`observeAttachments`、`retrieval`、閾値。構成は全部を明示してあるので、既定の変化は黙って効かないはずだが、差分を確認する。
8. **license**：`THIRD_PARTY_LICENSES.md` の更新。新しい依存の license。
9. **旗 off で CI、旗 on の journey、3 OS の packaged smoke**。
10. 2、3 のどれかが落ちる、ee が必須になる、license が変わる場合は、**版を上げない**（第 10.1 節）。

## 12. 追跡表

### 12.1 P1〜P18（ユーザーの回答 2026-11-19）

質問文と推奨は spike 枝の草稿にある。ここは回答の結論だけを載せる。

| P   | 回答の要点                                                                                                                                                                                                                                       | MP                 | 受入れの検証                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------- |
| P1  | (b) env の固定と、packaged の通信観測を受入れ条件に                                                                                                                                                                                              | 1、3、13           | 第 8.2 節                                                       |
| P2  | (a) 実測なしで、止める条件（model・embedder は object のみ、文字列 id 禁止、attachment を memory に通さない）を要件に                                                                                                                            | 1、10              | 文字列 id の禁止、ダミー key の対照                             |
| P3  | vector：削除・export・backup に含める（決定済み）。OM・WM：backup（自動）にだけ含め、zip export には含めない。project 削除で WM・OM を必ず消す                                                                                                   | 7、8、11、12       | cascade、OM・WM の表が zip に出ない、vector の id（R-15）、U-19 |
| P4  | (a) 削除した範囲に由来する OM の部分だけ消す。再構築しない                                                                                                                                                                                       | 11                 | 方式は U-13（R-16）                                             |
| P5  | (c) 暫定は開示して許容。絞る手当てを確かめたら要件に                                                                                                                                                                                             | 8、10、12          | 保存は digest だけ。題名・observer（R-13）                      |
| P6  | (a) attachment を送らない。PDF の確認を受入れ条件に                                                                                                                                                                                              | 10                 | PDF の `observeAttachments:false`（R-14）                       |
| P7  | (a) route 4 本（`memory_observer`、`memory_reflector`、`memory_title`、`memory_embedding`）                                                                                                                                                      | 10                 | audit の executable contract test                               |
| P8  | (a) 設定、WM の閲覧・編集・消去、観測の消去                                                                                                                                                                                                      | 7、12              | `ipcContract` の試験、main の再検証                             |
| P9  | 条件つき承認。(1) upsert は `ON CONFLICT DO UPDATE`。(2) role='signal' は adapter で除外。(3) 差し込む message は user で INSERT しない。(4) `grimodex_write_clock` を含む全 schema の試験を実装の前に（実施済み。S-M14。ただし adapter は模型） | 7、8、9            | 現行 master の全 schema 試験（MP-7）、製品の adapter（MP-8）    |
| P10 | stub と build の検査。Mastra への照会はしない。version を上げるたびに build の検査で ee の chunk を捕まえる                                                                                                                                      | 1、3、13、第 11 節 | ee の検査、asar の列挙                                          |
| P11 | 暫定 5 秒（案 C）。実 provider の遅延を測ってから改めて伺う                                                                                                                                                                                      | 11、13             | 第 8.3 節                                                       |
| P12 | (a) 読みの失敗は縮退して UI に出す。保存の失敗は turn の失敗                                                                                                                                                                                     | 9、12              | 縮退の裏付けが無い（X1）。MP-9 で試験                           |
| P13 | (a) resource＝project、WM は嗜好・文体の template だけ、recall と OM は thread scope                                                                                                                                                             | 10                 | 構成の明示、spoiler の試験                                      |
| P14 | (a) 選択肢 1（Mastra の履歴管理）。`chat_summaries`・`chatRecall`・pin・`chat_message_prompts` の行方は実装の前に別に伺う                                                                                                                        | 9                  | U-12                                                            |
| P15 | (a) `agentManaged:false`。tool の追加は後で別に伺う                                                                                                                                                                                              | 10                 | 実行での確認（R-14）                                            |
| P16 | (a) lazy 合成。旗を戻すと WM・OM・vector・`parts_json` は無視する。消去は MP-12 の入口。保持期間は未決                                                                                                                                           | 12、第 10.2 節     | U-15                                                            |
| P17 | (a) MCP に出さない                                                                                                                                                                                                                               | 12                 | standalone MCP の試験                                           |
| P18 | (b) `closed`                                                                                                                                                                                                                                     | 7                  | D2a の台帳の完全性試験（U-11）                                  |

### 12.2 対象外とするもの

| 項目                                                                                           | 理由                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 案 A・案 B（`@mastra/libsql`、別 file）に関する未確認（M17 の native addon、案 A の table 数） | 却下済みの案。C-1 は native 依存なし                                                                         |
| `electron` の binary の取得が cache か外部取得か（S2 未確認 3）                                | spike の環境の件。製品の CI の Electron は既存                                                               |
| 公式の storage 適合性試験の有無                                                                | 有無は調べない。MP-8 の S-M1 の差分試験で代える                                                              |
| `updateWorkingMemory` の実際の tool schema                                                     | P15(a)＝`agentManaged:false` で tool を外す。tool の追加は後で別に伺う                                       |
| ホスト型 embedding                                                                             | 利用者が選んだときだけ。MP-12 の UI に出すかは U-15                                                          |
| ee の扱いの再検討                                                                              | 決定済み（stub と build の検査。P10）。版ごとの再確認は第 11 節                                              |
| Web Editor の handoff                                                                          | 廃止済み。考慮しない                                                                                         |
| legacy 経路の撤去                                                                              | MP-14。この計画の外                                                                                          |
| `seed`・fixture の作り直し（設計 §2 の表）                                                     | C-1 は additive 列が null のまま。新表は空                                                                   |
| bundled の AI SDK の URL download の網羅                                                       | URL 画像を agent の入力に通さない（R-10）ことで避ける                                                        |
| zod の top-level 解決（S5 未確認 6）                                                           | tool の schema は JSON Schema をそのまま渡すので使わない                                                     |
| X11 の画像 URL の GET の取消し・ヘッダの中身                                                   | URL 画像を memory と agent の入力に通さない決定により、起きない。起きないことは通信の観測（第 8.2 節）で確認 |

## 13. この計画が確認していないこと

- master（spike の基点から 38 commit 先）の chat 周辺の変更の内容。題名だけで読んだ（第 2 節）。
- 本物の Rust（N-API）、実 ONNX、packaged の Electron main、Chromium 側の通信。
- OpenAI・OpenRouter の挙動（U-6）。spike は Anthropic 形の fake だけ（S4、S6）。MP-2 で確かめる。
- manifest の 44 本のうち、どれが renderer 常駐になるかの再点検。件数の内訳（read 26、write 16、destructive 2）は master で数えた。
- agent chat が画像・PDF の添付を送る経路を持つか（MP-3 で調べる）。
- journey の catalog と `workload-allocation` の digest の更新規則の正本（過去の PR の変更の組からの推測）。
- electron-builder が `files` の指定に加えて production 依存を asar に足すか（第 4.3 節）。
- この計画の PR の分け方が妥当かの、候補に触れない reviewer による独立した review（U-3 のユーザーの承認とは別）。
